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

async function evalOnPage<T = any>(ws: WebSocket, expression: string, timeoutMs = 30000): Promise<T> {
  const result = await cdpCall(ws, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  const remote = result?.result;
  if (remote?.subtype === "error") throw new Error(remote?.description || remote?.value || "Runtime.evaluate failed");
  return remote?.value as T;
}

async function navigateAndWait(ws: WebSocket, url: string) {
  await cdpCall(ws, "Page.enable");
  await cdpCall(ws, "Runtime.enable");
  await cdpCall(ws, "Page.navigate", { url });
  await new Promise(r => setTimeout(r, 5000));
}

async function clickTextByCdp(ws: WebSocket, pattern: string, flags = 'i'): Promise<boolean> {
  const expression = `(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)});
    const visible = el => !!(el && el.offsetParent !== null);
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
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: textOf(el).slice(0, 120), tag: el.tagName, role: el.getAttribute('role'), cls: String(el.className || '').slice(0, 120) };
  })()`;
  const result = await cdpCall(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 15000);
  const target = result?.result?.value;
  if (!target || typeof target.x !== 'number' || typeof target.y !== 'number') return false;
  logger.info(`CDP 点击文本: ${target.text} (${target.tag}${target.role ? '/' + target.role : ''})`);
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' }, 5000);
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 }, 5000);
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 }, 5000);
  return true;
}


async function hasDreaminaCredentialFields(ws: WebSocket): Promise<boolean> {
  return await evalOnPage<boolean>(ws, `(() => {
    const visible = el => !!(el && el.offsetParent !== null);
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const hasUser = inputs.some(i => i.type === 'email' || /email|user|account|phone|mobile|login|mail|邮箱|郵箱|账号|帳號|tài khoản|tai khoan/i.test([i.name,i.id,i.placeholder,i.type,i.autocomplete].join(' ')));
    const hasPass = inputs.some(i => i.type === 'password' || /password|密码|密碼|mật khẩu|mat khau/i.test([i.name,i.id,i.placeholder,i.autocomplete].join(' ')));
    return hasUser && hasPass;
  })()`, 15000);
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
          const alreadyAtCredentialForm = await hasDreaminaCredentialFields(ws).catch(() => false);
          if (!alreadyAtCredentialForm) {
            const emailClickedFirst = await clickTextByCdp(ws, '使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱).*繼續|使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱).*继续|continue.*(email|e-mail)|email.*continue|tiếp tục bằng email|tiep tuc bang email|電子郵件|电子邮件|邮箱|郵箱').catch(() => false);
            if (emailClickedFirst) await new Promise(r => setTimeout(r, 2500));
            if (!emailClickedFirst) {
              await clickTextByCdp(ws, '^(log in|sign in|login|continue|登录|登入|đăng nhập|dang nhap)$').catch(() => false);
              await new Promise(r => setTimeout(r, 2500));
              await clickTextByCdp(ws, '使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱).*繼續|使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱).*继续|continue.*(email|e-mail)|email.*continue|tiếp tục bằng email|tiep tuc bang email|電子郵件|电子邮件|邮箱|郵箱').catch(() => false);
              await new Promise(r => setTimeout(r, 2500));
            }
          } else {
            logger.info('Dreamina 已在邮箱/密码表单，跳过登录方式选择点击');
          }
          try {
            await evalOnPage(ws, `
(async()=>{
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!(el && el.offsetParent !== null);
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
  const findUser = () => {
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    return inputs.find(i => i.type === 'email' || /email|user|account|phone|mobile|login|mail|邮箱|郵箱|账号|帳號|tài khoản|tai khoan/i.test([i.name,i.id,i.placeholder,i.type,i.autocomplete].join(' ')));
  };
  const findPass = () => [...document.querySelectorAll('input')].find(i => visible(i) && (i.type === 'password' || /password|密码|密碼|mật khẩu|mat khau/i.test([i.name,i.id,i.placeholder,i.autocomplete].join(' '))));

  // State machine: if email/password fields are already visible, never click
  // the login method chooser again; repeated clicks reset the modal.
  let user = findUser();
  let pass = findPass();
  if (!user || !pass) {
    const emailOption = byText(/continue.*(email|e-mail)|email.*continue|tiếp tục bằng email|tiep tuc bang email|使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱).*繼續|使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱).*继续|電子郵件|电子邮件|邮箱|郵箱/i);
    if (emailOption) { clickLike(emailOption); await sleep(3000); }
  }
  for (let i = 0; i < 10; i++) {
    user = findUser();
    pass = findPass();
    if (user && pass) break;
    await sleep(800);
  }

  const userSet = setValue(user, ${JSON.stringify(options.username)});
  await sleep(500);
  const passSet = setValue(pass, ${JSON.stringify(options.password)});
  await sleep(800);
  const submitRe = /^(log in|sign in|login|continue|next|submit|登录|登入|繼續|继续|下一步|tiếp tục|tiep tuc|kế tiếp|ke tiep|đăng nhập|dang nhap)$/i;
  const submit = byText(submitRe) || [...document.querySelectorAll('button,[role=button]')].filter(visible).find(b => !b.disabled && submitRe.test(textOf(b)));
  if (submit) clickLike(submit);
  return { userSet, passSet, hasUser: !!user, hasPass: !!pass, submitted: !!submit, url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 1200) };
})()`, 45000);
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
  return await checkDreaminaLoginByCdp(opened.cdpPort);
}

export default BitBrowserClient;
