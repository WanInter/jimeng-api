import WebSocket from "ws";
import logger from "@/lib/logger.ts";
import db from "@/lib/database.ts";

let msgId = 1;


export function getCdpHttpBase(port?: string | number | null): string {
  const configuredBase = process.env.DREAMINA_CDP_BASE || db.getSetting('dreamina_cdp_base', '');
  if (configuredBase) return configuredBase.replace(/\/$/, "");

  const cdpPort = String(port || process.env.DREAMINA_CDP_PORT || "64896");

  // If only BitBrowser API is configured, derive CDP host/scheme from it.
  // BitBrowser /browser/open returns a local CDP port; on a remote BitBrowser
  // machine the CDP is normally exposed on the same host as the API.
  const bitbrowserApiBase = process.env.BITBROWSER_API_BASE || db.getSetting('bitbrowser_api_base', '');
  if (!process.env.DREAMINA_CDP_HOST && bitbrowserApiBase) {
    try {
      const api = new URL(bitbrowserApiBase);
      return `${api.protocol}//${api.hostname}:${cdpPort}`;
    } catch { /* fallback below */ }
  }

  const host = process.env.DREAMINA_CDP_HOST || "127.0.0.1";
  const scheme = process.env.DREAMINA_CDP_SCHEME || "http";
  return `${scheme}://${host}:${cdpPort}`;
}

export function rewriteCdpWsUrl(wsUrl: string, port?: string | number | null): string {
  if (!wsUrl) return wsUrl;
  if (process.env.DREAMINA_CDP_WS_BASE) {
    const path = new URL(wsUrl).pathname;
    return `${process.env.DREAMINA_CDP_WS_BASE.replace(/\/$/, "")}${path}`;
  }
  const configuredBase = process.env.DREAMINA_CDP_BASE || db.getSetting('dreamina_cdp_base', '');
  const bitbrowserApiBase = process.env.BITBROWSER_API_BASE || db.getSetting('bitbrowser_api_base', '');
  if (!configuredBase && !process.env.DREAMINA_CDP_HOST && !bitbrowserApiBase) return wsUrl;
  const base = new URL(getCdpHttpBase(port));
  const u = new URL(wsUrl);
  u.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  u.hostname = base.hostname;
  u.port = base.port;
  return u.toString();
}

export async function getGeneratePageWs(port: string): Promise<string> {
  const base = getCdpHttpBase(port);
  const tabs = await fetch(`${base}/json/list`).then(r => r.json()) as any[];
  const tab = tabs.find(t => t.type === 'page' && String(t.url || '').includes('/ai-tool/generate'))
    || tabs.find(t => t.type === 'page' && String(t.url || '').includes('dreamina.capcut.com'));
  if (!tab?.webSocketDebuggerUrl) throw new Error(`Dreamina CDP page not found on ${base}`);
  return rewriteCdpWsUrl(tab.webSocketDebuggerUrl, port);
}

export function cdpCall(ws: WebSocket, method: string, params: any = {}, timeoutMs = 30000): Promise<any> {
  const id = msgId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage as any);
      reject(new Error(`CDP call timeout: ${method}`));
    }, timeoutMs);
    const onMessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage as any);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage as any);
  });
}

export interface BrowserSignedRequest {
  url: string;
  headers: Record<string, string>;
  postData: string;
}

/**
 * Reuse Dreamina page secsdk/webmssdk to sign a request URL.
 *
 * The page's fetch is intercepted before it reaches the network. By the time
 * Fetch.requestPaused fires, secsdk has already appended msToken/X-Bogus/X-Gnarly
 * and browser headers. We cancel the browser request and return the signed URL
 * to the Node caller.
 */
export async function browserSignRequest(url: string, data: any, options: { cdpPort?: string | number | null; cdpWsUrl?: string | null } = {}): Promise<BrowserSignedRequest> {
  const port = String(options.cdpPort || process.env.DREAMINA_CDP_PORT || '64896');
  const wsUrl = options.cdpWsUrl || await getGeneratePageWs(port);
  const ws = new WebSocket(wsUrl);
  const targetPath = new URL(url).pathname;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error('browserSignRequest timeout')); }, 60000);

    ws.onopen = async () => {
      try {
        await cdpCall(ws, 'Fetch.enable', {
          patterns: [{ urlPattern: `*${targetPath}*`, requestStage: 'Request' }]
        });

        ws.addEventListener('message', async (ev: MessageEvent) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.method !== 'Fetch.requestPaused') return;
          const p = msg.params;
          const reqUrl = p.request?.url || '';
          if (!reqUrl.includes(targetPath)) return;

          try {
            await cdpCall(ws, 'Fetch.failRequest', {
              requestId: p.requestId,
              errorReason: 'Aborted'
            });
          } catch { /* ignore */ }

          clearTimeout(timer);
          try { await cdpCall(ws, 'Fetch.disable'); } catch { /* ignore */ }
          try { ws.close(); } catch { /* ignore */ }

          logger.info(`浏览器签名完成: ${new URL(reqUrl).pathname}`);
          resolve({
            url: reqUrl,
            headers: p.request?.headers || {},
            postData: p.request?.postData || JSON.stringify(data),
          });
        });

        const expression = `
(async()=>{
  try {
    await fetch(${JSON.stringify(url)}, {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(${JSON.stringify(data)})
    });
  } catch (e) {
    // Expected: Fetch domain aborts the signed browser request.
  }
  return true;
})()`;
        await cdpCall(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      } catch (e: any) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(e);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket error')); };
  });
}

/** Fallback/direct browser fetch, useful for debugging. */
export async function browserFetchJson(url: string, data: any, options: { cdpPort?: string | number | null; cdpWsUrl?: string | null } = {}): Promise<any> {
  const port = String(options.cdpPort || process.env.DREAMINA_CDP_PORT || '64896');
  const wsUrl = options.cdpWsUrl || await getGeneratePageWs(port);
  const ws = new WebSocket(wsUrl);
  const evalId = msgId++;
  const expression = `
(async()=>{
  const res = await fetch(${JSON.stringify(url)}, {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(${JSON.stringify(data)})
  });
  const text = await res.text();
  return JSON.stringify({status: res.status, url: res.url, text});
})()`;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error('browserFetchJson timeout')); }, 120000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: evalId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket error')); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== evalId) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const raw = msg.result?.result?.value;
      const envelope = JSON.parse(raw);
      logger.info(`浏览器代理请求完成: ${envelope.status} ${new URL(envelope.url).pathname}`);
      let body: any;
      try { body = JSON.parse(envelope.text); } catch { body = envelope.text; }
      if (envelope.status >= 400) return reject(new Error(`browser fetch HTTP ${envelope.status}: ${envelope.text.slice(0, 500)}`));
      resolve(body);
    };
  });
}
