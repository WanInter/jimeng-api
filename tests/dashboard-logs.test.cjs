const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

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
  assert.equal(logs.length, 3);
  assert.match(logs[0].message, /^GET \/v1\/\[unmatched\] 200 .*ms$/);
  assert.equal(logs[0].level, 'ERROR');
  assert.match(logs[1].message, /^POST \/v1\/images\/generations 200 .*ms$/);
  assert.equal(logs[1].level, 'WARN');
  assert.match(logs[2].message, /^GET \/v1\/models 200 .*ms$/);
  assert.equal(logs[2].level, 'INFO');
  assert.equal(await getLogs('INFO').then((items) => items.length), 1);
  assert.equal(await getLogs('WARN').then((items) => items.length), 1);
  assert.equal(await getLogs('ERROR').then((items) => items.length), 1);
  assert.equal(await getLogs('ALL').then((items) => items.length), 3);
  assert.ok(logs.every((item) => !item.message.includes(marker)));
});
