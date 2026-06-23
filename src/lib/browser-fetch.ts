import logger from "@/lib/logger.ts";

let msgId = 1;

async function getGeneratePageWs(port: string): Promise<string> {
  const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()) as any[];
  const tab = tabs.find(t => t.type === 'page' && String(t.url || '').includes('/ai-tool/generate'))
    || tabs.find(t => t.type === 'page' && String(t.url || '').includes('dreamina.capcut.com'));
  if (!tab?.webSocketDebuggerUrl) throw new Error(`Dreamina CDP page not found on port ${port}`);
  return tab.webSocketDebuggerUrl;
}

export async function browserFetchJson(url: string, data: any): Promise<any> {
  const port = process.env.DREAMINA_CDP_PORT || '64896';
  const wsUrl = await getGeneratePageWs(port);
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
