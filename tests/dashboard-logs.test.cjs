const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('API calls appear in dashboard logs without secrets or dashboard polling', async (t) => {
  const dir = mkdtempSync(path.join(process.env.JIMENG_TEST_TMPDIR || os.tmpdir(), 'jimeng-logs-'));
  const legacyDb = new Database(path.join(dir, 'jimeng.db'));
  legacyDb.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now', 'localtime')));
    INSERT INTO logs (level, message) VALUES ('INFO', 'old log entry');`);
  legacyDb.close();
  const port = await freePort();
  const server = spawn(process.execPath, ['dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      DB_PATH: path.join(dir, 'jimeng.db'),
      SERVER_ENV: 'dev',
      SERVER_HOST: '127.0.0.1',
      SERVER_PORT: String(port),
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      const killTimer = setTimeout(() => server.kill('SIGKILL'), 3000);
      server.kill('SIGTERM');
      try { await exited; } finally { clearTimeout(killTimer); }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) break;
    try {
      const response = await fetch(`${base}/ping`);
      if (response.ok) { ready = true; break; }
    } catch { /* server is starting */ }
    await delay(100);
  }
  assert.ok(ready, 'test server did not start');

  const marker = 'test-only-private-value';
  const success = await fetch(`${base}/v1/models?api_key=${marker}`, {
    headers: { Authorization: `Bearer ${marker}`, Cookie: `private=${marker}` },
  });
  assert.equal(success.status, 200);

  const failed = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: '' },
    body: JSON.stringify({ prompt: marker }),
  });
  assert.ok((await failed.json()).code < 0, 'the request should fail validation');

  const failedVideo = await fetch(`${base}/v1/videos/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jimeng-video-3.5-pro', prompt: marker, resolution: '720p', ratio: '16:9', duration: 5, filePaths: [], file_paths: [marker, marker] }),
  });
  const failedVideoBody = await failedVideo.json();
  assert.ok(failedVideoBody.code < 0, 'the video request should fail without authorization');

  const suspiciousModel = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `jimeng-4.5:1024x1024:${marker}`, prompt: marker, ratio: marker, resolution: marker, response_format: marker }),
  });
  assert.ok((await suspiciousModel.json()).code < 0);

  const failedStream = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jimeng-4.5', messages: [{ role: 'user', content: marker }], stream: true }),
  });
  assert.ok((await failedStream.json()).code < 0);

  const unknown = await fetch(`${base}/v1/unknown/${marker}?api_key=${marker}`);
  assert.ok((await unknown.json()).code < 0, 'the route should not match');

  const setup = await fetch(`${base}/dashboard/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test-admin', password: 'test-password' }),
  });
  assert.equal(setup.status, 200);
  const login = await fetch(`${base}/dashboard/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test-admin', password: 'test-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const getLogs = async (level) => {
    const response = await fetch(`${base}/dashboard/logs?level=${level}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const logs = await getLogs('ALL');
  assert.equal(logs.length, 7);
  assert.match(logs[0].message, /^GET \/v1\/\[unmatched\] 200 .*ms$/);
  assert.equal(logs[0].level, 'ERROR');
  assert.equal(logs[0].details, null);
  assert.equal(logs[1].details.stream, true);
  assert.equal(logs[1].details.result, 'failed');
  assert.equal(logs[1].details.messageCount, 1);
  assert.equal(logs[2].details.model, undefined);
  assert.equal(logs[2].details.estimatedCredits, undefined);
  assert.equal(logs[2].details.requestedRatio, undefined);
  assert.equal(logs[2].details.requestedResolution, undefined);
  assert.equal(logs[2].details.responseFormat, undefined);
  assert.match(logs[3].message, /^POST \/v1\/videos\/generations 200 .*ms$/);
  assert.equal(logs[3].level, 'WARN');
  assert.equal(logs[3].details.model, 'jimeng-video-3.5-pro');
  assert.equal(logs[3].details.category, 'video');
  assert.equal(logs[3].details.requestedResolution, '720p');
  assert.equal(logs[3].details.requestedRatio, '16:9');
  assert.equal(logs[3].details.requestedDurationSeconds, 5);
  assert.equal(logs[3].details.functionMode, 'first_last_frames');
  assert.equal(logs[3].details.inputImageCount, 2);
  assert.equal(logs[3].details.inputVideoCount, 0);
  assert.equal(logs[3].details.promptLength, marker.length);
  assert.equal(logs[3].details.errorCode, failedVideoBody.code);
  assert.equal(logs[3].details.estimatedCredits, 40);
  assert.equal(logs[3].details.actualCredits, null);
  assert.equal(logs[3].details.result, 'failed');
  assert.match(logs[4].message, /^POST \/v1\/images\/generations 200 .*ms$/);
  assert.equal(logs[4].details.category, 'image');
  assert.equal(logs[4].details.estimatedCredits, 5);
  assert.equal(logs[4].details.actualCredits, null);
  assert.match(logs[5].message, /^GET \/v1\/models 200 .*ms$/);
  assert.equal(logs[5].level, 'INFO');
  assert.equal(logs[5].details, null);
  assert.equal(logs[6].message, 'old log entry');
  assert.equal(logs[6].details, null);
  assert.equal(await getLogs('INFO').then((items) => items.length), 2);
  assert.equal(await getLogs('WARN').then((items) => items.length), 4);
  assert.equal(await getLogs('ERROR').then((items) => items.length), 1);
  assert.equal(await getLogs('ALL').then((items) => items.length), 7);
  assert.ok(!JSON.stringify(logs).includes(marker));
});

test('dashboard renders details safely and labels estimates separately from actual cost', async () => {
  const html = readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  const helpers = script.match(/const logDetailLabels = [\s\S]*?(?=async function loadLogs\()/)?.[0];
  assert.ok(helpers);
  const { logDetailRows } = new Function(`${helpers} return { logDetailRows };`)();
  const rows = Object.fromEntries(logDetailRows({ model: 'jimeng-video-3.5-pro', estimatedCredits: 40, actualCredits: null }));
  assert.match(rows['规则预估积分'], /40.*非实扣/);
  assert.match(rows['实际扣费'], /未知/);
  assert.ok(html.includes('<details class="log-details"'), 'missing expandable log details');

  const container = { innerHTML: '', querySelectorAll: () => [] };
  const document = {
    getElementById: id => id === 'log-level' ? { value: 'ALL' } : container,
    createElement: () => ({ click() {} }),
  };
  const fakeLogs = [{
    id: 7, created_at: '2026-10-13 05:53:26', level: 'INFO', message: '<script>alert(1)</script>',
    details: { model: '<svg/onload=1>', estimatedCredits: 40, actualCredits: null },
  }];
  const api = async () => ({ ok: true, json: async () => fakeLogs });
  const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const loadLogsSource = script.slice(script.indexOf('async function loadLogs()'), script.indexOf('async function clearLogs()'));
  const exportSource = script.slice(script.indexOf('function exportLogs()'), script.indexOf('// ===== 媒体库 ====='));
  let exported;
  const URL = { createObjectURL: blob => { exported = blob; return 'blob:test'; } };
  const { loadLogs, exportLogs } = new Function('document', 'api', 'escapeHtml', 'URL', 'Blob',
    `let loadedLogs = []; ${helpers} ${loadLogsSource} ${exportSource} return { loadLogs, exportLogs };`)(document, api, escapeHtml, URL, Blob);
  await loadLogs();
  assert.match(container.innerHTML, /查看详情/);
  assert.match(container.innerHTML, /未知（未采集到可信实扣）/);
  assert.ok(!container.innerHTML.includes('<script>'));
  assert.ok(!container.innerHTML.includes('<svg/onload=1>'));
  exportLogs();
  const text = await exported.text();
  assert.match(text, /规则预估积分: 40 积分（规则预估，非实扣）/);
  assert.match(text, /实际扣费: 未知（未采集到可信实扣）/);
});
