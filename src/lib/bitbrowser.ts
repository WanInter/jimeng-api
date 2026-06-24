import axios, { AxiosInstance } from "axios";
import logger from "@/lib/logger.ts";
import { cdpCall, getGeneratePageWs } from "@/lib/browser-fetch.ts";

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

const DEFAULT_LOGIN_URL = "https://dreamina.capcut.com/ai-tool/generate";

function getBaseUrl() {
  return process.env.BITBROWSER_API_BASE || "http://127.0.0.1:54345";
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

  async list(page = 1, pageSize = 100): Promise<any[]> {
    const res = await this.http.post("/browser/list", { page, pageSize });
    if (!res.data?.success) throw new Error(res.data?.msg || `BitBrowser list failed: ${res.status}`);
    return res.data?.data?.list || [];
  }

  async findProfileForAccount(account: { name?: string; login_username?: string; username?: string; token_preview?: string }): Promise<any | null> {
    const targets = [account.login_username, account.username, account.name]
      .map(norm)
      .filter(v => v && v !== "unknown");
    if (!targets.length) return null;

    const profiles = await this.list(1, Number(process.env.BITBROWSER_LIST_PAGE_SIZE || 500));

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
