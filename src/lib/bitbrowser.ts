import WebSocket from "ws";
import axios, { AxiosInstance } from "axios";
import logger from "@/lib/logger.ts";
import db from "@/lib/database.ts";
import { cdpCall, getCdpHttpBase, getGeneratePageWs, rewriteCdpWsUrl } from "@/lib/browser-fetch.ts";

export interface BitBrowserOpenResult {
  ws?: string;
  http?: string;
  cdpPort?: number;
  seq?: number;
  name?: string;
  pid?: number;
  raw: any;
}

export interface DreaminaLoginResult {
  status: "ok" | "need_2fa" | "failed";
  message?: string;
  cookies?: string;
  cdpPort?: number;
  cdpWsUrl?: string;
  userAgent?: string;
}

export interface RunningDreaminaContext {
  cdpPort: number;
  pageWsUrl?: string;
  profileId?: string;
  pageUrl?: string;
  title?: string;
}

const DEFAULT_LOGIN_URL = "https://dreamina.capcut.com/ai-tool/home?need_login=true";

function getBaseUrl() {
  return process.env.BITBROWSER_API_BASE || db.getSetting('bitbrowser_api_base', 'http://127.0.0.1:54345');
}

function mask(value?: string | null) {
  if (!value) return "";
  return value.length <= 8 ? "****" : `${value.slice(0, 3)}****${value.slice(-3)}`;
}

function extractPort(openData: any): number | undefined {
  const http = String(openData?.http || "");
  const match = http.match(/:(\d+)$/) || http.match(/^(\d+)$/);
  if (match) return Number(match[1]);
  const ws = String(openData?.ws || "");
  const wsMatch = ws.match(/:(\d+)\//);
  return wsMatch ? Number(wsMatch[1]) : undefined;
}

function cdpBaseFromBitBrowserApi(bitbrowserApiBase: string, cdpPort: number): string {
  const api = new URL(bitbrowserApiBase);
  return `${api.protocol}//${api.hostname}:${cdpPort}`;
}

function getOpenArgs(): string[] {
  const raw = process.env.BITBROWSER_OPEN_ARGS || db.getSetting('bitbrowser_open_args', '');
  const args = raw
    ? raw.split(/\s*,\s*/).map(v => v.trim()).filter(Boolean)
    : [];

  // For remote API deployments, CDP must listen on a non-loopback address;
  // otherwise /browser/open returns a port that is only reachable from the BitBrowser machine itself.
  if (!args.some(a => a.startsWith('--remote-debugging-address='))) {
    args.push('--remote-debugging-address=0.0.0.0');
  }
  return args;
}

async function hasDreaminaPage(cdpBase: string): Promise<boolean> {
  try {
    const tabs = await fetch(`${cdpBase.replace(/\/$/, "")}/json/list`).then(r => r.json()) as any[];
    return tabs.some(t => t.type === 'page' && String(t.url || '').includes('dreamina.capcut.com'));
  } catch {
    return false;
  }
}

function cookieHeaderFromCdp(cookies: any[]): string {
  return cookies
    .filter(c => String(c.domain || "").includes("capcut.com") || String(c.domain || "").includes("dreamina"))
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
}

function norm(v: any): string {
  return String(v || "").trim().toLowerCase();
}

function profileSearchText(profile: any): string {
  return [
    profile.id, profile.seq, profile.name, profile.userName, profile.username,
    profile.remark, profile.platform, profile.url, profile.code
  ].map(norm).join(" ");
}

function parseProxyUrl(proxyUrl?: string | null): Partial<Record<string, any>> {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return { proxyMethod: 3, proxyType: 'noproxy' };

  // Support both standard URL form and the imported shorthand form:
  //   http://user:pass@host:port
  //   user:pass@host:port
  const candidates = /^https?:\/\//i.test(raw) ? [raw] : [`http://${raw}`, raw];
  for (const candidate of candidates) {
    try {
      const u = new URL(candidate);
      const type = u.protocol.replace(':', '') || 'http';
      if (!u.hostname || !u.port) continue;
      return {
        proxyMethod: 2,
        proxyType: type === 'https' ? 'http' : type,
        host: u.hostname,
        port: Number(u.port || (type === 'https' ? 443 : 80)),
        proxyUserName: decodeURIComponent(u.username || ''),
        proxyPassword: decodeURIComponent(u.password || ''),
      };
    } catch {
      // Try next candidate.
    }
  }

  // BitBrowser requires proxyType even when falling back to no-proxy.
  return { proxyMethod: 3, proxyType: 'noproxy', remark: `Invalid proxy_url ignored: ${raw.slice(0, 80)}` };
}

function buildCreateProfilePayload(account: { name?: string; login_username?: string; username?: string; proxy_url?: string; region?: string }): any {
  const username = String(account.login_username || account.username || account.name || '').trim();
  const name = username || `Dreamina ${Date.now()}`;
  return {
    name,
    remark: `auto-created by jimeng-api${account.region ? ` / ${account.region}` : ''}`,
    url: DEFAULT_LOGIN_URL,
    ...parseProxyUrl(account.proxy_url),
    browserFingerPrint: {
      coreVersion: '124',
      ostype: 'PC',
      os: 'Win32',
      isIpCreateTimeZone: true,
      isIpCreateLanguage: true,
      isIpCreateDisplayLanguage: true,
      openWidth: 1280,
      openHeight: 900,
    },
  };
}

function extractProfileId(data: any): string {
  return String(data?.id || data?.browserId || data?.browser_id || data?.data?.id || data?.data?.browserId || data?.data?.browser_id || '').trim();
}


function getBitBrowserApiTimeoutMs(): number {
  const raw = process.env.BITBROWSER_API_TIMEOUT_MS || db.getSetting('bitbrowser_api_timeout_ms', '120000');
  const timeout = Number(raw);
  return Number.isFinite(timeout) && timeout >= 30000 ? timeout : 120000;
}

export class BitBrowserClient {
  private http: AxiosInstance;

  constructor(baseUrl = getBaseUrl()) {
    this.http = axios.create({ baseURL: baseUrl, timeout: getBitBrowserApiTimeoutMs(), validateStatus: () => true });
  }

  async list(page = 1, pageSize = 20): Promise<any[]> {
    const res = await this.http.post("/browser/list", { page, pageSize });
    if (!res.data?.success) throw new Error(res.data?.msg || `BitBrowser list failed: ${res.status}`);
    return res.data?.data?.list || [];
  }

  async listAll(maxPages = 30, pageSize = Number(process.env.BITBROWSER_LIST_PAGE_SIZE || 2)): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= maxPages; page++) {
      let rows: any[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          rows = await this.list(page, pageSize);
          break;
        } catch (e) {
          const msg = String(e?.message || e || '');
          if (!/频繁|frequency|frequent|rate/i.test(msg) || attempt === 3) throw e;
          logger.warn(`BitBrowser list 触发限频，退避后重试: page=${page}, attempt=${attempt}`);
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
      if (!rows.length) break;
      all.push(...rows);
      if (rows.length < pageSize) break;
      // BitBrowser local API can rate-limit rapid pagination requests.
      await new Promise(r => setTimeout(r, Number(process.env.BITBROWSER_LIST_DELAY_MS || 350)));
    }
    return all;
  }

  async findProfileForAccount(account: { name?: string; login_username?: string; username?: string; token_preview?: string }): Promise<any | null> {
    const targets = [account.login_username, account.username, account.name]
      .map(norm)
      .filter(v => v && v !== "unknown");
    if (!targets.length) return null;

    const profiles = await this.listAll();

    // 1. 优先精确匹配 name / userName。
    for (const profile of profiles) {
      const fields = [profile.name, profile.userName, profile.username].map(norm);
      if (targets.some(t => fields.includes(t))) return profile;
    }

    // 2. 其次在 name / remark / url 等字段里包含匹配。
    for (const profile of profiles) {
      const haystack = profileSearchText(profile);
      if (targets.some(t => t.length >= 4 && haystack.includes(t))) return profile;
    }

    return null;
  }

  async detectDreaminaCdpBase(): Promise<{ cdpBase: string; profileId?: string; cdpPort: number; opened: BitBrowserOpenResult; hasDreaminaPage: boolean; warning?: string }> {
    const profiles = await this.listAll();
    const candidates = [
      ...profiles.filter(p => Number(p.status) === 1),
      ...profiles.filter(p => Number(p.status) !== 1),
    ];

    let lastError: any;
    let firstReachable: { cdpBase: string; profileId?: string; cdpPort: number; opened: BitBrowserOpenResult; hasDreaminaPage: boolean; warning?: string } | null = null;

    for (const profile of candidates) {
      try {
        const opened = await this.open(String(profile.id));
        if (!opened.cdpPort) continue;
        const cdpBase = cdpBaseFromBitBrowserApi(this.http.defaults.baseURL || getBaseUrl(), opened.cdpPort);
        const dreamina = await hasDreaminaPage(cdpBase);
        const result = { cdpBase, profileId: String(profile.id), cdpPort: opened.cdpPort, opened, hasDreaminaPage: dreamina };
        if (dreamina) return result;
        if (!firstReachable) {
          firstReachable = {
            ...result,
            warning: "已检测到可访问的 CDP，但该窗口当前未打开 Dreamina 页面；保存后请在账号页点击“登录”或手动打开 dreamina.capcut.com。",
          };
        }
      } catch (e) {
        lastError = e;
      }
    }

    if (firstReachable) return firstReachable;
    throw new Error(lastError?.message || "未检测到可访问的 BitBrowser CDP。请确认远程服务器可访问 BitBrowser 返回的 CDP 端口，而不仅是 54345。");
  }

  async open(id: string): Promise<BitBrowserOpenResult> {
    if (!id) throw new Error("BitBrowser profile id is required");
    const res = await this.http.post("/browser/open", { id, args: getOpenArgs() });
    if (!res.data?.success) throw new Error(res.data?.msg || `BitBrowser open failed: ${res.status}`);
    const data = res.data.data || {};
    return { ...data, cdpPort: extractPort(data), raw: res.data };
  }

  async close(id: string): Promise<void> {
    if (!id) throw new Error("BitBrowser profile id is required");
    const res = await this.http.post("/browser/close", { id });
    if (!res.data?.success) throw new Error(res.data?.msg || `BitBrowser close failed: ${res.status}`);
  }

  async createOrUpdate(input: any): Promise<any> {
    // BitBrowser 本地 API 的新增/更新接口在不同版本里字段要求不同。
    // 这里提供透传封装：调用方传完整 browserFingerPrint / proxy 等 payload。
    const endpoint = input.id ? "/browser/update" : (process.env.BITBROWSER_CREATE_ENDPOINT || "/browser/update");
    const res = await this.http.post(endpoint, input);
    if (res.data?.success) return res.data.data || res.data;
    const detail = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data || '');
    throw new Error(res.data?.msg || res.data?.message || `BitBrowser ${endpoint} failed: ${res.status}${detail ? ` ${detail}` : ''}`);
  }

  async createProfileForAccount(account: { name?: string; login_username?: string; username?: string; proxy_url?: string; region?: string }): Promise<any> {
    const payload = buildCreateProfilePayload(account);
    logger.info(`自动创建 BitBrowser profile: ${mask(payload.name)}`);
    const data = await this.createOrUpdate(payload);
    const profileId = extractProfileId(data);
    if (profileId) return { ...data, id: profileId, autoCreatedPayload: { name: payload.name, url: payload.url, proxyType: payload.proxyType, host: payload.host, port: payload.port } };

    // 某些 BitBrowser 版本创建接口只返回布尔值，不返回 id；创建后按名称再查一次。
    const matched = await this.findProfileForAccount(account);
    if (matched?.id) return matched;
    throw new Error('BitBrowser profile 已创建但未返回 profile id，且无法按账号名称重新匹配');
  }
}

function getCandidateCdpPorts(extra?: Array<number | string | null | undefined>): number[] {
  const values = [
    ...(extra || []),
    process.env.DREAMINA_CDP_PORT,
    process.env.BITBROWSER_CDP_PORT,
    ...(process.env.BITBROWSER_CDP_PORTS || '').split(',')
  ];
  if (!values.some(v => String(v || '').trim() === '64896')) values.push('64896');
  return [...new Set(values.map(v => Number(String(v || '').trim())).filter(v => Number.isInteger(v) && v > 0 && v < 65536))];
}

export async function discoverRunningDreaminaContext(extraPorts: Array<number | string | null | undefined> = []): Promise<RunningDreaminaContext | null> {
  for (const port of getCandidateCdpPorts(extraPorts)) {
    try {
      const tabs = await fetch(`${getCdpHttpBase(port)}/json/list`).then(r => r.json()) as any[];
      const dreaminaPage = tabs.find(t => t.type === 'page' && String(t.url || '').includes('dreamina.capcut.com'));
      if (!dreaminaPage) continue;
      const workbench = tabs.find(t => t.type === 'page' && String(t.url || '').includes('console.bitbrowser.net'));
      let profileId: string | undefined;
      if (workbench?.url) {
        try { profileId = new URL(workbench.url).searchParams.get('id') || undefined; } catch {}
      }
      return {
        cdpPort: port,
        pageWsUrl: rewriteCdpWsUrl(dreaminaPage.webSocketDebuggerUrl, port),
        profileId,
        pageUrl: dreaminaPage.url,
        title: dreaminaPage.title,
      };
    } catch {
      // Port is not a CDP endpoint, ignore.
    }
  }
  return null;
}

async function waitForPageWs(port: number, timeoutMs = 60000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: any;
  while (Date.now() < deadline) {
    try {
      return await getGeneratePageWs(String(port));
    } catch (e) {
      lastError = e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastError || new Error(`Dreamina page not found on CDP port ${port}`);
}

async function evalOnPage<T = any>(ws: WebSocket, expression: string, timeoutMs = 30000, contextId?: number): Promise<T> {
  const params: any = { expression, awaitPromise: true, returnByValue: true };
  if (typeof contextId === 'number') params.contextId = contextId;
  const result = await cdpCall(ws, "Runtime.evaluate", params, timeoutMs);
  const remote = result?.result;
  if (remote?.subtype === "error") throw new Error(remote?.description || remote?.value || "Runtime.evaluate failed");
  return remote?.value as T;
}

/**
 * Dreamina 的第三方登录弹窗常渲染在同源 iframe 中；主 frame 里 querySelectorAll('input')
 * 找不到邮箱/密码框，导致状态机反复点击"使用电子邮件继续"却停在原地。
 * 这里枚举所有 execution context（主 frame + 各 iframe），返回第一个满足条件的 contextId。
 */
async function findContextIdWhere(ws: WebSocket, predicateExpr: string): Promise<number | undefined> {
  const contexts = await collectExecutionContexts(ws);
  for (const ctx of contexts) {
    const hit = await evalOnPage<boolean>(ws, predicateExpr, 10000, ctx).catch(() => false);
    if (hit) return ctx;
  }
  return undefined;
}

/**
 * 通过 Page.getFrameTree + Runtime.executionContextCreated 事件收集可用 contextId。
 * Runtime.enable 会为每个已存在的 context 重放 executionContextCreated 事件。
 */
async function collectExecutionContexts(ws: WebSocket, waitMs = 1200): Promise<Array<number | undefined>> {
  const ids = new Set<number>();
  const onMessage = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.method === 'Runtime.executionContextCreated' && typeof msg.params?.context?.id === 'number') {
        ids.add(msg.params.context.id);
      }
    } catch { /* 忽略非 JSON 帧 */ }
  };
  ws.addEventListener('message', onMessage as any);
  try {
    // 先 disable 再 enable，强制重放全部已存在 context（含 iframe）。
    await cdpCall(ws, 'Runtime.disable', {}, 5000).catch(() => null);
    await cdpCall(ws, 'Runtime.enable', {}, 5000).catch(() => null);
    await new Promise(r => setTimeout(r, waitMs));
  } finally {
    ws.removeEventListener('message', onMessage as any);
  }
  // undefined 代表默认（主 frame）context，始终最先尝试。
  return [undefined, ...ids];
}

async function navigateAndWait(ws: WebSocket, url: string) {
  await cdpCall(ws, "Page.enable");
  await cdpCall(ws, "Runtime.enable");
  await cdpCall(ws, "Page.navigate", { url });
  await new Promise(r => setTimeout(r, 5000));
}

/**
 * 可见性判断不能用 offsetParent：按 CSS 规范，position:fixed 元素的 offsetParent 为 null，
 * 而 Dreamina 登录弹窗正是 fixed 定位，会导致弹窗内的元素被误判为不可见。
 */
const VISIBLE_FN = `el => {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
}`;

async function clickTextByCdp(ws: WebSocket, pattern: string, flags = 'i', contextId?: number): Promise<boolean> {
  const expression = `(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)});
    const visible = ${VISIBLE_FN};
    const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
    const lineCount = el => textOf(el).split(String.fromCharCode(10)).filter(Boolean).length;
    const score = el => {
      const cls = String(el.className || '');
      const role = el.getAttribute('role') || '';
      const txt = textOf(el);
      return (el.matches('button,a,[role=button],[role=menuitem]') ? 120 : 0)
        + (/lv_new_third_part_sign_in_expand-button|login-button/i.test(cls) ? 220 : 0)
        + (/lv_new_third_part_sign_in_expand-wrapper/i.test(cls) ? 80 : 0)
        + (/email|mail|電子郵件|电子邮件|郵箱|邮箱|login|sign/i.test(cls + ' ' + txt) ? 80 : 0)
        + (role === 'menuitem' ? 40 : 0)
        + (lineCount(el) === 1 ? 120 : 0)
        - txt.length / 5
        - lineCount(el) * 80
        - el.querySelectorAll('*').length;
    };
    const clickSelector = '.lv_new_third_part_sign_in_expand-button,.login-button-CK3g2c,button,a,[role=button],[role=menuitem]';
    const candidates = [...document.querySelectorAll('button,a,[role=button],[role=menuitem],div,span')]
      .filter(el => visible(el) && re.test(textOf(el)))
      .map(el => {
        // If a large modal/container matches because its text includes every
        // login method, never blindly pick its first child (usually Google).
        // Prefer the smallest clickable descendant whose own text also matches.
        const matchingChildren = [...(el.querySelectorAll?.(clickSelector) || [])].filter(c => visible(c) && re.test(textOf(c)));
        const child = matchingChildren.sort((a, b) => score(b) - score(a))[0];
        const closest = el.closest(clickSelector);
        const clickable = child || (closest && re.test(textOf(closest)) ? closest : null) || el;
        return clickable;
      })
      .filter((el, idx, arr) => arr.indexOf(el) === idx)
      .sort((a, b) => score(b) - score(a));
    const el = candidates[0];
    if (!el) return null;
    // 先滚动，坐标在下一次调用里再取，避免平滑滚动未结束导致坐标失效。
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    window.__jmClickTarget = el;
    const r = el.getBoundingClientRect();
    // Input.dispatchMouseEvent 使用顶层 viewport 坐标；若元素位于 iframe 中，
    // getBoundingClientRect 返回的是 iframe 内部坐标，必须叠加各层 iframe 的偏移。
    let offsetX = 0, offsetY = 0, w = window, guard = 0;
    while (w !== w.parent && guard++ < 10) {
      try {
        const fr = w.frameElement;
        if (!fr) break;
        const fb = fr.getBoundingClientRect();
        offsetX += fb.left; offsetY += fb.top;
        w = w.parent;
      } catch { break; }
    }
    return {
      x: r.left + r.width / 2 + offsetX,
      y: r.top + r.height / 2 + offsetY,
      w: r.width, h: r.height,
      inFrame: offsetX !== 0 || offsetY !== 0,
      text: textOf(el).slice(0, 120), tag: el.tagName,
      role: el.getAttribute('role'), cls: String(el.className || '').slice(0, 120)
    };
  })()`;
  const params: any = { expression, returnByValue: true, awaitPromise: true };
  if (typeof contextId === 'number') params.contextId = contextId;
  const result = await cdpCall(ws, 'Runtime.evaluate', params, 15000);
  const target = result?.result?.value;
  if (!target || typeof target.x !== 'number' || typeof target.y !== 'number') return false;
  if (!(target.w > 0 && target.h > 0)) {
    logger.warn(`CDP 点击目标尺寸为 0，跳过点击: ${target.text} (${target.tag})`);
    return false;
  }
  logger.info(`CDP 点击文本: ${target.text} (${target.tag}${target.role ? '/' + target.role : ''}) at ${Math.round(target.x)},${Math.round(target.y)}${target.inFrame ? ' [iframe]' : ''}`);
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' }, 5000);
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 }, 5000);
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 }, 5000);

  // 真实鼠标点击可能被遮罩层拦截；补一次目标元素上的直接 DOM click 作为兜底。
  await evalOnPage(ws, `(() => {
    const el = window.__jmClickTarget;
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    delete window.__jmClickTarget;
    return true;
  })()`, 10000, contextId).catch(() => false);
  return true;
}


const PASS_INPUT_FN = `i => i.type === 'password' || /password|passwd|pwd|密码|密碼|mật khẩu|mat khau/i.test([i.name,i.id,i.placeholder,i.autocomplete].join(' '))`;

/**
 * 邮箱框只在同一表单/弹窗里存在密码框时才认定，避免匹配到首页的搜索框或提示词框。
 * 之前的松散正则在首页就能命中 input，导致把账号填进生成提示框。
 */
/**
 * 判定登录表单是否已就绪。Dreamina 是两步式：第一步弹窗只有邮箱框，密码框要提交后才出现，
 * 所以"只有邮箱框"也算已进入表单，不能再去点登录方式选择按钮（会重置弹窗）。
 * 同时要求该输入框位于登录弹窗/表单内，避免把首页提示词框当成登录表单。
 */
const CREDENTIAL_FIELDS_EXPR = `(() => {
  const visible = ${VISIBLE_FN};
  const isPass = ${PASS_INPUT_FN};
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  if (inputs.find(isPass)) return true;
  const LOGIN_SCOPE_SEL = 'form,[role=dialog],[class*=modal],[class*=login],[class*=sign],[class*=Login],[class*=Sign]';
  return inputs.some(i => {
    if (i.type !== 'email' && !/email|e-mail|邮箱|郵箱/i.test([i.name,i.id,i.placeholder,i.autocomplete].join(' '))) return false;
    return !!i.closest(LOGIN_SCOPE_SEL);
  });
})()`;

/** 返回承载邮箱/密码表单的 contextId；undefined 表示主 frame 或未找到。 */
async function findCredentialContextId(ws: WebSocket): Promise<number | undefined> {
  return await findContextIdWhere(ws, CREDENTIAL_FIELDS_EXPR);
}

async function hasDreaminaCredentialFields(ws: WebSocket, contextId?: number): Promise<boolean> {
  return await evalOnPage<boolean>(ws, CREDENTIAL_FIELDS_EXPR, 15000, contextId);
}

async function getPageSnapshot(ws: WebSocket, limit = 3000): Promise<{ url: string; title: string; text: string; cookies: string; ua: string }> {
  const info = await evalOnPage<any>(ws, `JSON.stringify({
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText.slice(0, ${limit}) : '',
    cookies: document.cookie,
    ua: navigator.userAgent
  })`, 20000);
  return JSON.parse(info || "{}");
}

async function handleDreaminaPostSubmitRecovery(ws: WebSocket): Promise<boolean> {
  // Dreamina occasionally completes the account login server-side but leaves an
  // error modal in the browser (Traditional Chinese: 發生錯誤 / 重新整理頁面並重試).
  // A real click on the modal refresh/retry button reveals the already-created
  // session cookies. Handle this generically for imported accounts/locales.
  const snapshot = await getPageSnapshot(ws, 2500).catch(() => null);
  const text = String(snapshot?.text || '');
  if (!/(發生錯誤|发生错误|something went wrong|error occurred|重新整理|刷新|重試|重试|retry|refresh)/i.test(text)) {
    return false;
  }

  logger.warn('Dreamina 登录后出现错误/刷新提示，尝试点击重新整理/重试后再次检测登录态');
  const clicked = await clickTextByCdp(ws, '重新整理|刷新|重試|重试|retry|refresh|try again').catch(() => false);
  if (!clicked) {
    await cdpCall(ws, 'Page.reload', { ignoreCache: false }, 10000).catch(() => null);
  }
  await new Promise(r => setTimeout(r, Number(process.env.DREAMINA_LOGIN_RECOVERY_WAIT_MS || 25000)));
  return true;
}

export async function checkDreaminaLoginByCdp(cdpPort: number, cdpWsUrl?: string | null): Promise<DreaminaLoginResult> {
  const wsUrl = cdpWsUrl || await waitForPageWs(cdpPort, 15000);
  const ws = new WebSocket(wsUrl);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error("check login timeout")); }, 30000);
    ws.onopen = async () => {
      try {
        const parsed = await getPageSnapshot(ws, 3000);
        const cookies = await cdpCall(ws, "Network.getAllCookies").catch(() => ({ cookies: [] }));
        const cookieHeader = cookieHeaderFromCdp(cookies.cookies || []);
        const text = String(parsed.text || "").toLowerCase();
        const docCookie = String(parsed.cookies || "");
        const loggedIn = /sessionid=|sid_tt=|sid_guard=/.test(cookieHeader || docCookie);
        const need2fa = /(verify|verification|code|captcha|验证码|安全验证|two-factor|2fa)/i.test(parsed.text || "");
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve({ status: loggedIn ? "ok" : need2fa ? "need_2fa" : "failed", cookies: cookieHeader || docCookie, cdpPort, cdpWsUrl: wsUrl, userAgent: parsed.ua });
      } catch (e) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(e);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP websocket error")); };
  });
}

export async function loginDreaminaViaBitBrowser(options: {
  bitbrowserProfileId: string;
  username?: string;
  password?: string;
  loginUrl?: string;
}): Promise<DreaminaLoginResult> {
  const client = new BitBrowserClient();
  logger.info(`打开 BitBrowser profile: ${options.bitbrowserProfileId}`);
  const opened = await client.open(options.bitbrowserProfileId);
  if (!opened.cdpPort) throw new Error("BitBrowser open did not return CDP port");

  const wsUrl = opened.ws || await waitForPageWs(opened.cdpPort, 60000).catch(() => "");
  const pageWsUrl = wsUrl.includes("/devtools/page/") ? wsUrl : undefined;
  const targetWs = pageWsUrl || await waitForPageWs(opened.cdpPort, 60000);
  const ws = new WebSocket(targetWs);
  // 自动填表的诊断结果需要在 Promise 之外可见，以便写入登录状态提示。
  let fillOutcome: any = null;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error("Dreamina login automation timeout")); }, 120000);
    ws.onopen = async () => {
      try {
        await navigateAndWait(ws, options.loginUrl || DEFAULT_LOGIN_URL);

        const before = await checkDreaminaLoginByCdp(opened.cdpPort!, targetWs).catch(() => null);
        if (before?.status === "ok") {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          return resolve();
        }

        if (options.username && options.password) {
          logger.info(`尝试自动填写 Dreamina 登录表单: ${mask(options.username)}`);
          // Prefer real CDP mouse clicks for the login dialog. Dreamina often ignores
          // synthetic DOM click events on these login controls. If the credential
          // form is already visible, do not click the login-method chooser again;
          // doing so can reset the modal back to the method selection page.
          const EMAIL_OPTION_RE = '使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱).*繼續|使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱).*继续|continue.*(email|e-mail)|email.*continue|tiếp tục bằng email|tiep tuc bang email|電子郵件|电子邮件|邮箱|郵箱';

          // 登录弹窗可能在 iframe 内：先在所有 execution context 里找凭据表单。
          let credCtx = await findCredentialContextId(ws).catch(() => undefined);
          const alreadyAtCredentialForm = credCtx !== undefined
            || await hasDreaminaCredentialFields(ws).catch(() => false);

          if (!alreadyAtCredentialForm) {
            // 登录方式选择按钮同样可能在 iframe 内，逐个 context 尝试点击。
            const clickInAnyContext = async (pattern: string): Promise<boolean> => {
              for (const ctx of await collectExecutionContexts(ws)) {
                if (await clickTextByCdp(ws, pattern, 'i', ctx).catch(() => false)) return true;
              }
              return false;
            };

            // 分阶段推进，每步验证是否已出现凭据表单，避免在首页空点或重复点击重置弹窗。
            // 阶段一：页面可能仍是未登录首页（日志实测文本为 "Sign in to start creating"），
            // 需要先打开登录弹窗；?need_login=true 并不保证弹窗自动弹出。
            const SIGN_IN_RE = '^\\s*(sign in|sign up|log in|login|登录|登入|登錄|đăng nhập|dang nhap)\\s*$';
            for (const stage of [SIGN_IN_RE, EMAIL_OPTION_RE] as const) {
              credCtx = await findCredentialContextId(ws).catch(() => undefined);
              if (credCtx !== undefined) break;
              const clicked = await clickInAnyContext(stage);
              logger.info(`Dreamina 登录阶段点击 ${clicked ? '成功' : '未命中'}: ${stage === SIGN_IN_RE ? 'Sign in' : 'Continue with email'}`);
              await new Promise(r => setTimeout(r, 3000));
            }
            // 弹窗切换后表单可能落在新的 iframe context，重新定位。
            credCtx = await findCredentialContextId(ws).catch(() => undefined);
            if (credCtx === undefined && !await hasDreaminaCredentialFields(ws).catch(() => false)) {
              logger.warn('Dreamina 登录弹窗未出现邮箱/密码表单，将继续尝试填表并输出页面诊断信息');
            }
          } else {
            logger.info(`Dreamina 已在邮箱/密码表单，跳过登录方式选择点击${credCtx !== undefined ? ` (iframe context ${credCtx})` : ''}`);
          }
          try {
            const fillResult = await evalOnPage<any>(ws, `
(async()=>{
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = ${VISIBLE_FN};
  const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
  const clickLike = el => {
    if (!el) return false;
    el.scrollIntoView({block:'center', inline:'center'});
    const r = el.getBoundingClientRect();
    const opts = {bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2};
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  };
  const byText = (re) => {
    const lineCount = el => textOf(el).split(String.fromCharCode(10)).filter(Boolean).length;
    const score = el => {
      const cls = String(el.className || '');
      const role = el.getAttribute('role') || '';
      const txt = textOf(el);
      return (el.matches('button,a,[role=button],[role=menuitem]') ? 100 : 0)
        + (/lv_new_third_part_sign_in_expand-button|login-button/i.test(cls) ? 200 : 0)
        + (/lv_new_third_part_sign_in_expand-wrapper/i.test(cls) ? 60 : 0)
        + (role === 'menuitem' ? 30 : 0)
        + (lineCount(el) === 1 ? 100 : 0)
        - txt.length / 10
        - lineCount(el) * 60
        - el.querySelectorAll('*').length;
    };
    const clickSelector = '.lv_new_third_part_sign_in_expand-button,.login-button-CK3g2c,button,a,[role=button],[role=menuitem]';
    return [...document.querySelectorAll('button,a,[role=button],[role=menuitem],div,span')]
      .filter(el => visible(el) && re.test(textOf(el)))
      .map(el => {
        const matchingChildren = [...(el.querySelectorAll?.(clickSelector) || [])].filter(c => visible(c) && re.test(textOf(c)));
        return matchingChildren.sort((a, b) => score(b) - score(a))[0] || (el.closest(clickSelector) && re.test(textOf(el.closest(clickSelector))) ? el.closest(clickSelector) : null) || el;
      })
      .filter((el, idx, arr) => arr.indexOf(el) === idx)
      .sort((a, b) => score(b) - score(a))[0];
  };
  const setValue = (el, value) => {
    if (!el) return false;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent('input',{bubbles:true, inputType:'insertText', data:String(value)}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  };
  const isPass = ${PASS_INPUT_FN};
  const findPass = () => [...document.querySelectorAll('input')].filter(visible).find(isPass);
  const USER_RE = /email|e-mail|user|account|phone|mobile|login|mail|邮箱|郵箱|账号|帳號|tài khoản|tai khoan/i;
  // 账号框必须落在登录弹窗/表单范围内，避免误取首页提示词框（实测 hasUser 曾在首页误判为 true）。
  const LOGIN_SCOPE_SEL = 'form,[role=dialog],[class*=modal],[class*=login],[class*=sign],[class*=Login],[class*=Sign]';
  const findUser = () => {
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const pass = inputs.find(isPass);
    const scope = (pass || inputs.find(i => i.type === 'email'))?.closest(LOGIN_SCOPE_SEL);
    const pool = scope ? inputs.filter(i => scope.contains(i)) : inputs;
    return pool.find(i => i !== pass && (i.type === 'email' || (i.type === 'text' && USER_RE.test([i.name,i.id,i.placeholder,i.autocomplete].join(' ')))));
  };
  const submitRe = /^(log in|sign in|login|continue|next|submit|登录|登入|繼續|继续|下一步|tiếp tục|tiep tuc|kế tiếp|ke tiep|đăng nhập|dang nhap)$/i;
  // 从输入框向上逐层查找最近的提交按钮，绝不退化为全文档搜索。
  // 全文档搜索会命中页面右上角的全局 "Sign in"（DOM 顺序早于弹窗），
  // 点击它等于重新打开登录弹窗，导致流程退回登录方式选择页。
  const findSubmit = (anchor) => {
    if (!anchor) return null;
    let el = anchor.parentElement, guard = 0;
    while (el && el !== document.body && guard++ < 12) {
      const btns = [...el.querySelectorAll('button,[role=button],[type=submit]')]
        .filter(visible)
        .filter(b => !b.disabled && submitRe.test(textOf(b)));
      if (btns.length) return btns[btns.length - 1];
      el = el.parentElement;
    }
    return null;
  };

  // Dreamina/CapCut 采用两步式邮箱登录（实测截图确认）：
  // 第一步弹窗只有 "Enter email" + Continue，提交后密码框才渲染出来。
  // 因此不能要求邮箱框和密码框同时存在，否则流程会在第一步死锁。
  const trace = [];
  let user = findUser();
  let pass = findPass();

  if (!user && !pass) {
    const emailOption = byText(/continue.*(email|e-mail)|email.*continue|tiếp tục bằng email|tiep tuc bang email|使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱).*繼續|使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱).*继续|電子郵件|电子邮件|邮箱|郵箱/i);
    if (emailOption) { clickLike(emailOption); trace.push('clicked-email-option'); await sleep(3000); }
    user = findUser();
    pass = findPass();
  }

  let userSet = false, passSet = false, submitted = false, emailStepSubmitted = false;

  // 第一步：填邮箱并提交（密码框尚未出现时）
  if (user && !pass) {
    userSet = setValue(user, ${JSON.stringify(options.username)});
    trace.push('filled-email');
    await sleep(600);
    const next = findSubmit(user);
    if (next) {
      clickLike(next);
      emailStepSubmitted = true;
      submitted = true;
      trace.push('submitted-email-step:' + textOf(next).slice(0, 30));
    } else {
      trace.push('email-step-submit-not-found');
    }
    // 等待密码框渲染（可能伴随弹窗内容替换或验证码）
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      pass = findPass();
      if (pass) { trace.push('password-field-appeared-after-' + (i + 1) + 's'); break; }
    }
  }

  // 第二步：填密码并提交
  if (pass) {
    const u = findUser();
    // 第二步页面若仍带邮箱框且为空，补填一次（部分实现会保留该字段）。
    if (u && !u.value) { userSet = setValue(u, ${JSON.stringify(options.username)}) || userSet; await sleep(400); }
    passSet = setValue(pass, ${JSON.stringify(options.password)});
    trace.push('filled-password');
    await sleep(800);
    const submit = findSubmit(pass);
    if (submit) { clickLike(submit); submitted = true; trace.push('submitted-password-step:' + textOf(submit).slice(0, 30)); }
    else trace.push('password-step-submit-not-found');

    // 校验提交结果：若弹窗退回登录方式选择页（出现 Continue with Google/Facebook/TikTok），
    // 说明点到的是全局 Sign in 而非表单内提交按钮，需要明确报出而不是静默成功。
    if (submitted) {
      for (let i = 0; i < 8; i++) {
        await sleep(1000);
        const t = document.body?.innerText || '';
        const backToChooser = /continue with (google|facebook|tiktok|capcut mobile)/i.test(t);
        if (backToChooser) { trace.push('regressed-to-method-chooser-after-' + (i + 1) + 's'); break; }
        if (!findPass()) { trace.push('password-form-closed-after-' + (i + 1) + 's'); break; }
      }
    }
  }

  const hasUser = !!findUser() || userSet;
  const hasPass = !!pass;
  const regressed = trace.some(t => t.startsWith('regressed-to-method-chooser'));
  return {
    userSet, passSet, hasUser, hasPass, submitted, emailStepSubmitted, trace,
    reason: regressed ? 'regressed-to-method-chooser'
      : (!hasUser && !hasPass) ? 'credential-form-not-found'
      : (!hasPass ? 'password-step-not-reached' : ''),
    inputs: [...document.querySelectorAll('input')].filter(visible).map(i => ({ type: i.type, name: i.name, id: i.id, ph: i.placeholder })).slice(0, 10),
    url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 1200)
  };
})()`, 45000, credCtx);
            // 之前这里丢弃了返回值，导致"表单没找到"和"填了没提交"在日志里无法区分。
            fillOutcome = fillResult || null;
            if (fillOutcome) {
              logger.info(`Dreamina 自动填表结果: hasUser=${fillOutcome.hasUser} hasPass=${fillOutcome.hasPass} userSet=${fillOutcome.userSet} passSet=${fillOutcome.passSet} submitted=${fillOutcome.submitted} 步骤=[${(fillOutcome.trace || []).join(' -> ')}] url=${fillOutcome.url}`);
              if (fillOutcome.reason === 'regressed-to-method-chooser') {
                logger.warn('Dreamina 提交后退回登录方式选择页，说明点击的按钮不在凭据表单内或凭据被拒绝。请确认账号密码是否正确');
              } else if (fillOutcome.reason === 'password-step-not-reached') {
                logger.warn(`Dreamina 邮箱已提交但密码框未出现（可能触发验证码或需邮箱验证码登录）。可见 input: ${JSON.stringify(fillOutcome.inputs || [])}`);
                logger.warn(`Dreamina 页面文本片段: ${String(fillOutcome.text || '').replace(/\s+/g, ' ').slice(0, 300)}`);
              } else if (!fillOutcome.hasUser && !fillOutcome.hasPass) {
                logger.warn(`Dreamina 未找到邮箱/密码输入框${credCtx !== undefined ? ` (context ${credCtx})` : ' (主 frame)'}，已跳过填写避免误填。可见 input: ${JSON.stringify(fillOutcome.inputs || [])}`);
                logger.warn(`Dreamina 页面文本片段: ${String(fillOutcome.text || '').replace(/\s+/g, ' ').slice(0, 300)}`);
              } else if (!fillOutcome.submitted) {
                logger.warn('Dreamina 已填入邮箱/密码但未找到可点击的提交按钮，请在 BitBrowser 中手动提交后点击"检测"');
              }
            }
          } catch (e) {
            // Clicking login/submit can navigate the page and make the Runtime.evaluate
            // response disappear. Do not fail the whole login flow; keep the browser
            // open so the user can finish captcha/2FA/manual login and then click 检测.
            logger.warn(`Dreamina 自动填表未确认完成: ${e.message || e}`);
          }
          await new Promise(r => setTimeout(r, Number(process.env.DREAMINA_LOGIN_SETTLE_MS || 30000)));
          await handleDreaminaPostSubmitRecovery(ws).catch(e => logger.warn(`Dreamina 登录恢复处理失败: ${e.message || e}`));
        }

        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve();
      } catch (e) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(e);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP websocket error")); };
  });

  // The login click may navigate or replace the page target; rediscover the current
  // Dreamina page instead of reusing a possibly stale WebSocket URL.
  const finalResult = await checkDreaminaLoginByCdp(opened.cdpPort);

  // 登录未成功时，把自动填表的实际卡点带回后台，避免只显示"登录未确认"。
  if (finalResult.status !== 'ok' && !finalResult.message && options.username && options.password) {
    if (!fillOutcome) {
      finalResult.message = '自动填表未返回结果（页面可能已跳转），请在 BitBrowser 中确认后点击“检测”';
    } else if (fillOutcome.reason === 'regressed-to-method-chooser') {
      finalResult.message = '提交后退回登录方式选择页，可能是账号密码错误或被拒绝，请核对凭据';
    } else if (fillOutcome.reason === 'password-step-not-reached') {
      finalResult.message = '邮箱已提交但密码框未出现，可能需要邮箱验证码，请在 BitBrowser 中人工完成';
    } else if (!fillOutcome.hasUser || !fillOutcome.hasPass) {
      finalResult.message = '未找到邮箱/密码输入框，登录弹窗结构可能已变化或仍停留在登录方式选择页';
    } else if (!fillOutcome.submitted) {
      finalResult.message = '已填入邮箱/密码但未找到提交按钮，请在 BitBrowser 中手动提交';
    } else {
      finalResult.message = '已提交登录但未检测到会话 cookie，可能需要人工完成验证码/二次验证';
    }
  }
  return finalResult;
}

export default BitBrowserClient;
