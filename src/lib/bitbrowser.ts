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

const DEFAULT_LOGIN_URL = "https://dreamina.capcut.com/ai-tool/generate";

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


export class BitBrowserClient {
  private http: AxiosInstance;

  constructor(baseUrl = getBaseUrl()) {
    this.http = axios.create({ baseURL: baseUrl, timeout: 30000, validateStatus: () => true });
  }

  async list(page = 1, pageSize = 20): Promise<any[]> {
    const res = await this.http.post("/browser/list", { page, pageSize });
    if (!res.data?.success) throw new Error(res.data?.msg || `BitBrowser list failed: ${res.status}`);
    return res.data?.data?.list || [];
  }

  async listAll(maxPages = 20, pageSize = 20): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const rows = await this.list(page, pageSize);
      if (!rows.length) break;
      all.push(...rows);
      if (rows.length < pageSize) break;
    }
    return all;
  }

  async findProfileForAccount(account: { name?: string; login_username?: string; username?: string; token_preview?: string }): Promise<any | null> {
    const targets = [account.login_username, account.username, account.name]
      .map(norm)
      .filter(v => v && v !== "unknown");
    if (!targets.length) return null;

    const profiles = await this.listAll(20, Number(process.env.BITBROWSER_LIST_PAGE_SIZE || 20));

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
    const profiles = await this.listAll(20, Number(process.env.BITBROWSER_LIST_PAGE_SIZE || 20));
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
    const res = await this.http.post("/browser/open", { id });
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
    if (!res.data?.success) throw new Error(res.data?.msg || `BitBrowser ${endpoint} failed: ${res.status}`);
    return res.data.data || res.data;
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

async function evalOnPage<T = any>(ws: WebSocket, expression: string): Promise<T> {
  const result = await cdpCall(ws, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
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

export async function checkDreaminaLoginByCdp(cdpPort: number, cdpWsUrl?: string | null): Promise<DreaminaLoginResult> {
  const wsUrl = cdpWsUrl || await waitForPageWs(cdpPort, 15000);
  const ws = new WebSocket(wsUrl);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error("check login timeout")); }, 30000);
    ws.onopen = async () => {
      try {
        const info = await evalOnPage<any>(ws, `JSON.stringify({
          url: location.href,
          title: document.title,
          text: document.body ? document.body.innerText.slice(0, 3000) : '',
          cookies: document.cookie,
          ua: navigator.userAgent
        })`);
        const parsed = JSON.parse(info || "{}");
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
          await evalOnPage(ws, `
(async()=>{
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const byText = (re) => [...document.querySelectorAll('button,a,div,span')].find(el => re.test((el.innerText||el.textContent||'').trim()) && el.offsetParent !== null);
  const loginBtn = byText(/^(log in|sign in|登录|登入|continue)$/i) || byText(/log in|sign in|登录|登入/i);
  if (loginBtn) { loginBtn.click(); await sleep(2000); }
  const inputs = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null);
  const user = inputs.find(i => /email|user|account|phone|mobile|login/i.test([i.name,i.id,i.placeholder,i.type].join(' '))) || inputs[0];
  if (user) { user.focus(); user.value = ${JSON.stringify(options.username)}; user.dispatchEvent(new Event('input',{bubbles:true})); user.dispatchEvent(new Event('change',{bubbles:true})); }
  await sleep(500);
  const pass = [...document.querySelectorAll('input')].find(i => i.type === 'password' || /password|密码/i.test([i.name,i.id,i.placeholder].join(' ')));
  if (pass) { pass.focus(); pass.value = ${JSON.stringify(options.password)}; pass.dispatchEvent(new Event('input',{bubbles:true})); pass.dispatchEvent(new Event('change',{bubbles:true})); }
  await sleep(500);
  const submit = byText(/^(log in|sign in|登录|登入|continue|next|下一步)$/i) || [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && !b.disabled);
  if (submit) submit.click();
  return true;
})()`);
          await new Promise(r => setTimeout(r, 10000));
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

  return await checkDreaminaLoginByCdp(opened.cdpPort, targetWs);
}

export default BitBrowserClient;
