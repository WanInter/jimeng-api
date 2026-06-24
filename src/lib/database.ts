import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';

// 数据库文件路径
const DB_PATH = process.env.DB_PATH || './data/jimeng.db';

// 确保数据目录存在
fs.ensureDirSync(path.dirname(DB_PATH));

// 初始化数据库连接
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// 初始化表结构
db.exec(`
  -- 用户表（管理员账号）
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- Session表
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- 系统设置表
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- API Key统计表
  CREATE TABLE IF NOT EXISTS key_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL,
    key_preview TEXT NOT NULL,
    model TEXT NOT NULL,
    credits_used INTEGER DEFAULT 0,
    remaining_credits INTEGER DEFAULT 0,
    call_count INTEGER DEFAULT 1,
    last_used TEXT DEFAULT (datetime('now', 'localtime')),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- 媒体记录表
  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT,
    key_preview TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- 日志缓冲表
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- 即梦账号表（存储session token）
  CREATE TABLE IF NOT EXISTS jimeng_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    token_preview TEXT NOT NULL,
    region TEXT DEFAULT 'cn',
    credits_remaining INTEGER DEFAULT 0,
    credits_total INTEGER DEFAULT 0,
    status TEXT DEFAULT 'unknown',
    last_check TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- API Key表
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    key_preview TEXT NOT NULL,
    account_id INTEGER,
    is_active INTEGER DEFAULT 1,
    call_count INTEGER DEFAULT 0,
    last_used TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (account_id) REFERENCES jimeng_accounts(id)
  );

  -- 积分消耗规则表（可配置，管理后台可编辑）
  CREATE TABLE IF NOT EXISTS cost_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,          -- 'image' 或 'video'
    model_pattern TEXT DEFAULT '*',   -- 模型匹配模式，'*' 表示所有模型，'jimeng-4.5' 精确匹配，'seedance' 模糊匹配
    region TEXT DEFAULT '*',          -- 地区：'*' 所有，'cn'/'us'/'hk'/'jp'/'sg'
    resolution TEXT DEFAULT '*',      -- 分辨率：'*'/'1k'/'2k'/'4k'/'720p'/'1080p'
    duration_min INTEGER DEFAULT 0,   -- 视频时长下限（秒），图片为 0
    duration_max INTEGER DEFAULT 0,   -- 视频时长上限（秒），图片为 0
    credits_cost INTEGER NOT NULL,    -- 消耗积分数
    priority INTEGER DEFAULT 0,       -- 优先级（数值越大越优先匹配）
    description TEXT DEFAULT '',      -- 规则描述
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- 创建索引
  CREATE INDEX IF NOT EXISTS idx_key_stats_key ON key_stats(key_hash);
  CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cost_rules_type ON cost_rules(task_type);
`);

// 迁移：为已有表添加新字段（如果不存在）
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN proxy_url TEXT DEFAULT ''"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN cookie TEXT DEFAULT ''"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN login_username TEXT DEFAULT ''"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN login_password TEXT DEFAULT ''"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN bitbrowser_profile_id TEXT DEFAULT ''"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN bitbrowser_window_id TEXT DEFAULT ''"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN cdp_port INTEGER DEFAULT 0"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN cdp_ws_url TEXT DEFAULT ''"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN user_agent TEXT DEFAULT ''"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN login_status TEXT DEFAULT 'unknown'"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN last_login_at TEXT"); } catch (e) { /* 字段已存在 */ }
try { db.exec("ALTER TABLE jimeng_accounts ADD COLUMN last_login_error TEXT DEFAULT ''"); } catch (e) { /* 字段已存在 */ }

// 初始化默认积分消耗规则（仅在表为空时插入）
const ruleCount = (db.prepare('SELECT COUNT(*) as c FROM cost_rules').get() as { c: number }).c;
if (ruleCount === 0) {
  const insertRule = db.prepare(`
    INSERT INTO cost_rules (task_type, model_pattern, region, resolution, duration_min, duration_max, credits_cost, priority, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const defaultRules: [string, string, string, string, number, number, number, number, string][] = [
    // ===== 图片生成 =====
    // 基础文生图（所有模型，默认4张）
    ['image', '*', '*', '1k',  0, 0, 3,  10, '图片 1k 基础'],
    ['image', '*', '*', '2k',  0, 0, 5,  20, '图片 2k 默认'],
    ['image', '*', '*', '4k',  0, 0, 10, 30, '图片 4k 高清'],
    // jimeng-5.0 高端模型溢价
    ['image', 'jimeng-5.0', '*', '2k', 0, 0, 8,  25, 'jimeng-5.0 2k'],
    ['image', 'jimeng-5.0', '*', '4k', 0, 0, 15, 35, 'jimeng-5.0 4k'],

    // ===== 视频生成（按时长×模型×分辨率） =====
    // jimeng-video-3.0 标准版
    ['video', 'jimeng-video-3.0',       '*', '720p',  0, 5,  25,  10, '3.0 5s 720p'],
    ['video', 'jimeng-video-3.0',       '*', '720p',  6, 10, 45,  10, '3.0 10s 720p'],
    ['video', 'jimeng-video-3.0',       '*', '1080p', 0, 5,  40,  15, '3.0 5s 1080p'],
    ['video', 'jimeng-video-3.0',       '*', '1080p', 6, 10, 70,  15, '3.0 10s 1080p'],
    // jimeng-video-3.0-fast
    ['video', 'jimeng-video-3.0-fast',  '*', '720p',  0, 5,  20,  10, '3.0-fast 5s'],
    ['video', 'jimeng-video-3.0-fast',  '*', '720p',  6, 10, 35,  10, '3.0-fast 10s'],
    // jimeng-video-3.5-pro
    ['video', 'jimeng-video-3.5-pro',   '*', '*',     0, 5,  40,  20, '3.5-pro 5s'],
    ['video', 'jimeng-video-3.5-pro',   '*', '*',     6, 10, 70,  20, '3.5-pro 10s'],
    ['video', 'jimeng-video-3.5-pro',   '*', '*',    11, 15, 100, 20, '3.5-pro 15s'],
    // seedance-2.0（高端）
    ['video', 'jimeng-video-seedance-2.0',      '*', '*', 0, 5,  50,  25, 'seedance-2.0 5s'],
    ['video', 'jimeng-video-seedance-2.0',      '*', '*', 6, 10, 90,  25, 'seedance-2.0 10s'],
    ['video', 'jimeng-video-seedance-2.0',      '*', '*',11, 15, 130, 25, 'seedance-2.0 15s'],
    ['video', 'jimeng-video-seedance-2.0-fast', '*', '*', 0, 5,  40,  25, 'seedance-2.0-fast 5s'],
    ['video', 'jimeng-video-seedance-2.0-fast', '*', '*', 6, 10, 70,  25, 'seedance-2.0-fast 10s'],
    ['video', 'jimeng-video-seedance-2.0-fast', '*', '*',11, 15, 100, 25, 'seedance-2.0-fast 15s'],
    // veo3 / veo3.1（国际站高端）
    ['video', 'jimeng-video-veo3',   '*', '*', 0, 8, 80,  30, 'veo3 8s'],
    ['video', 'jimeng-video-veo3.1', '*', '*', 0, 8, 80,  30, 'veo3.1 8s'],
    // sora2
    ['video', 'jimeng-video-sora2',  '*', '*', 0, 4,  50,  25, 'sora2 4s'],
    ['video', 'jimeng-video-sora2',  '*', '*', 5, 8,  80,  25, 'sora2 8s'],
    ['video', 'jimeng-video-sora2',  '*', '*', 9, 12, 120, 25, 'sora2 12s'],
    // 通用兜底（未匹配到具体规则时）
    ['video', '*', '*', '*', 0, 5,  30,  1, '视频通用 5s'],
    ['video', '*', '*', '*', 6, 10, 55,  1, '视频通用 10s'],
    ['video', '*', '*', '*',11, 15, 80,  1, '视频通用 15s'],
  ];
  const insertMany = db.transaction((rules: typeof defaultRules) => {
    for (const r of rules) insertRule.run(...r);
  });
  insertMany(defaultRules);
}

// 密码哈希
export function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// 生成Session ID
export function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Key预览（隐藏中间部分）
export function keyPreview(key: string): string {
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

// Key哈希
export function hashKey(key: string): string {
  return crypto.createHash('md5').update(key).digest('hex');
}


function secretKey(): Buffer {
  return crypto.createHash('sha256').update(process.env.ACCOUNT_SECRET || process.env.SESSION_SECRET || 'jimeng-api-local-secret').digest();
}

export function encryptSecret(value: string): string {
  if (!value || value.startsWith('enc:')) return value || '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(value: string): string {
  if (!value || !value.startsWith('enc:')) return value || '';
  const [, ivB64, tagB64, dataB64] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}


// ==================== 系统设置 ====================

export function getSetting(key: string, defaultValue: string = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value || defaultValue;
}

export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', 'localtime')
  `).run(key, value || '');
}

export function getRemoteBrowserSettings() {
  return {
    bitbrowser_api_base: getSetting('bitbrowser_api_base', process.env.BITBROWSER_API_BASE || 'http://127.0.0.1:54345'),
    dreamina_cdp_base: getSetting('dreamina_cdp_base', process.env.DREAMINA_CDP_BASE || ''),
  };
}

export function updateRemoteBrowserSettings(settings: { bitbrowser_api_base?: string; dreamina_cdp_base?: string }): void {
  setSetting('bitbrowser_api_base', settings.bitbrowser_api_base || '');
  setSetting('dreamina_cdp_base', settings.dreamina_cdp_base || '');
}

// ==================== 用户管理 ====================

export function isSetupComplete(): boolean {
  const result = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return result.count > 0;
}

export function createUser(username: string, password: string): void {
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
}

export function validateUser(username: string, password: string): number | null {
  const user = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username) as { id: number; password_hash: string } | undefined;
  if (user && user.password_hash === hashPassword(password)) {
    return user.id;
  }
  return null;
}

export function changePassword(userId: number, newPassword: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
}

// ==================== Session管理 ====================

export function createSession(userId: number): string {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24小时
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sessionId, userId, expiresAt);
  return sessionId;
}

export function validateSession(sessionId: string): number | null {
  const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(sessionId) as { user_id: number; expires_at: string } | undefined;
  if (session && new Date(session.expires_at) > new Date()) {
    return session.user_id;
  }
  if (session) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }
  return null;
}

export function deleteSession(sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// ==================== 统计管理 ====================

export function recordCall(key: string, model: string, creditsUsed: number = 0, remainingCredits: number = 0): void {
  console.log(`[DB] recordCall called: model=${model}, creditsUsed=${creditsUsed}, remainingCredits=${remainingCredits}`);
  const keyHash = hashKey(key);
  const preview = keyPreview(key);
  
  try {
    const existing = db.prepare('SELECT id, call_count, credits_used FROM key_stats WHERE key_hash = ? AND model = ?').get(keyHash, model) as { id: number; call_count: number; credits_used: number } | undefined;
    
    if (existing) {
      db.prepare(`UPDATE key_stats SET call_count = ?, credits_used = ?, remaining_credits = ?, last_used = datetime('now', 'localtime') WHERE id = ?`)
        .run(existing.call_count + 1, existing.credits_used + creditsUsed, remainingCredits, existing.id);
      console.log(`[DB] Updated key_stats: id=${existing.id}, call_count=${existing.call_count + 1}, creditsUsed=${creditsUsed}`);
    } else {
      db.prepare('INSERT INTO key_stats (key_hash, key_preview, model, credits_used, remaining_credits) VALUES (?, ?, ?, ?, ?)')
        .run(keyHash, preview, model, creditsUsed, remainingCredits);
      console.log(`[DB] Inserted new key_stats: model=${model}, preview=${preview}, creditsUsed=${creditsUsed}`);
    }
  } catch (e) {
    console.error(`[DB] recordCall error:`, e);
  }
}

export function getStats() {
  // 按Key汇总（包含剩余积分）
  const keyStats = db.prepare(`
    SELECT key_preview, SUM(call_count) as total_calls, SUM(credits_used) as total_credits, 
           MAX(remaining_credits) as remaining_credits, MAX(last_used) as last_used
    FROM key_stats GROUP BY key_hash ORDER BY total_calls DESC
  `).all();
  
  // 按模型汇总
  const modelStats = db.prepare(`
    SELECT model, SUM(call_count) as total_calls, SUM(credits_used) as total_credits
    FROM key_stats GROUP BY model ORDER BY total_calls DESC
  `).all();
  
  // 总计
  const totals = db.prepare(`
    SELECT SUM(call_count) as total_calls, SUM(credits_used) as total_credits FROM key_stats
  `).get() as { total_calls: number; total_credits: number };
  
  return { keyStats, modelStats, totals };
}

// ==================== 媒体管理 ====================

export function saveMedia(type: 'image' | 'video', url: string, model: string, prompt: string, key: string): void {
  db.prepare('INSERT INTO media (type, url, model, prompt, key_preview) VALUES (?, ?, ?, ?, ?)')
    .run(type, url, model, prompt, keyPreview(key));
}

export function getMedia(page: number = 1, limit: number = 20, type?: string) {
  const offset = (page - 1) * limit;
  let query = 'SELECT * FROM media';
  let countQuery = 'SELECT COUNT(*) as total FROM media';
  const params: any[] = [];
  
  if (type) {
    query += ' WHERE type = ?';
    countQuery += ' WHERE type = ?';
    params.push(type);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  
  const items = db.prepare(query).all(...params, limit, offset);
  const countResult = db.prepare(countQuery).get(...params) as { total: number };
  
  return {
    items,
    total: countResult.total,
    page,
    limit,
    totalPages: Math.ceil(countResult.total / limit)
  };
}

// ==================== 日志管理 ====================

const MAX_LOGS = 1000;

export function addLog(level: string, message: string): void {
  db.prepare('INSERT INTO logs (level, message) VALUES (?, ?)').run(level, message);
  
  // 清理旧日志
  db.prepare(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ${MAX_LOGS})`).run();
}

export function getLogs(level?: string, limit: number = 100) {
  let query = 'SELECT * FROM logs';
  const params: any[] = [];
  
  if (level && level !== 'ALL') {
    query += ' WHERE level = ?';
    params.push(level);
  }
  
  query += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  
  return db.prepare(query).all(...params);
}

export function clearLogs(): void {
  db.prepare('DELETE FROM logs').run();
}

// ==================== 即梦账号管理 ====================

export function addAccount(name: string, token: string, region: string = 'cn', proxyUrl: string = '', cookie: string = ''): number {
  const preview = keyPreview(token);
  const result = db.prepare('INSERT INTO jimeng_accounts (name, token, token_preview, region, proxy_url, cookie) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, token, preview, region, proxyUrl, cookie);
  return result.lastInsertRowid as number;
}

export function getAccounts() {
  return db.prepare(`
    SELECT id, name, token_preview, region, proxy_url,
           bitbrowser_profile_id, bitbrowser_window_id, cdp_port, cdp_ws_url,
           login_username, login_status, last_login_at, last_login_error,
           CASE WHEN cookie IS NOT NULL AND cookie != '' THEN 1 ELSE 0 END as has_cookie,
           credits_remaining, credits_total, status, last_check, created_at
    FROM jimeng_accounts ORDER BY created_at DESC
  `).all();
}

/**
 * 获取所有账号的完整 token（用于保活检测）
 */
export function getAllAccountTokens() {
  return db.prepare('SELECT id, name, token, proxy_url, cookie, status FROM jimeng_accounts ORDER BY id').all() as { id: number; name: string; token: string; proxy_url: string | null; cookie?: string | null; status: string }[];
}

export function getAccountById(id: number) {
  return db.prepare('SELECT * FROM jimeng_accounts WHERE id = ?').get(id) as any;
}

export function getAccountToken(id: number): string | null {
  const account = db.prepare('SELECT token FROM jimeng_accounts WHERE id = ?').get(id) as { token: string } | undefined;
  return account?.token || null;
}

export function updateAccountCredits(id: number, remaining: number, total: number): void {
  db.prepare('UPDATE jimeng_accounts SET credits_remaining = ?, credits_total = ?, last_check = datetime(\'now\', \'localtime\') WHERE id = ?')
    .run(remaining, total, id);
}

export function updateAccountStatus(id: number, status: string): void {
  db.prepare('UPDATE jimeng_accounts SET status = ?, last_check = datetime(\'now\', \'localtime\') WHERE id = ?')
    .run(status, id);
}

export function deleteAccount(id: number): void {
  db.prepare('DELETE FROM api_keys WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM jimeng_accounts WHERE id = ?').run(id);
}

export function updateAccountProxy(id: number, proxyUrl: string): void {
  db.prepare('UPDATE jimeng_accounts SET proxy_url = ? WHERE id = ?').run(proxyUrl, id);
}

export function updateAccountCookie(id: number, cookie: string): void {
  db.prepare('UPDATE jimeng_accounts SET cookie = ? WHERE id = ?').run(cookie, id);
}

export function getAccountCookieByToken(token: string): string | null {
  const account = db.prepare('SELECT cookie FROM jimeng_accounts WHERE token = ?').get(token) as { cookie: string } | undefined;
  return account?.cookie || null;
}


export function importLoginAccount(input: {
  name: string; username: string; password: string; region?: string; proxy_url?: string; bitbrowser_profile_id?: string;
}): number {
  const token = `pending-${crypto.randomBytes(16).toString('hex')}`;
  const preview = keyPreview(input.username || token);
  const result = db.prepare(`
    INSERT INTO jimeng_accounts (name, token, token_preview, region, proxy_url, login_username, login_password, bitbrowser_profile_id, login_status, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unknown')
  `).run(input.name, token, preview, input.region || 'vn', input.proxy_url || '', input.username, encryptSecret(input.password), input.bitbrowser_profile_id || '');
  return result.lastInsertRowid as number;
}

export function updateAccountLoginSecret(id: number, username: string, password: string): void {
  db.prepare('UPDATE jimeng_accounts SET login_username = ?, login_password = ? WHERE id = ?').run(username, encryptSecret(password), id);
}

export function updateAccountBitBrowserProfile(id: number, profileId: string): void {
  db.prepare('UPDATE jimeng_accounts SET bitbrowser_profile_id = ? WHERE id = ?').run(profileId, id);
}

export function updateAccountBitBrowserRuntime(id: number, runtime: { cdp_port?: number | null; cdp_ws_url?: string | null; bitbrowser_window_id?: string | null; user_agent?: string | null }): void {
  db.prepare(`
    UPDATE jimeng_accounts SET cdp_port = ?, cdp_ws_url = ?, bitbrowser_window_id = ?, user_agent = ? WHERE id = ?
  `).run(runtime.cdp_port || 0, runtime.cdp_ws_url || '', runtime.bitbrowser_window_id || '', runtime.user_agent || '', id);
}

export function updateAccountLoginStatus(id: number, status: string, error: string = ''): void {
  db.prepare(`UPDATE jimeng_accounts SET login_status = ?, last_login_error = ?, last_login_at = datetime('now', 'localtime') WHERE id = ?`)
    .run(status, error, id);
}

export function updateAccountTokenAndCookie(id: number, token: string, cookie: string): void {
  db.prepare(`
    UPDATE jimeng_accounts SET token = ?, token_preview = ?, cookie = ?, login_status = 'ok', status = 'active', last_login_error = '', last_login_at = datetime('now', 'localtime') WHERE id = ?
  `).run(token, keyPreview(token), cookie, id);
}

// ==================== 积分消耗规则管理 ====================

export function getCostRules() {
  return db.prepare('SELECT * FROM cost_rules ORDER BY task_type, priority DESC, id').all();
}

export function addCostRule(rule: {
  task_type: string; model_pattern?: string; region?: string;
  resolution?: string; duration_min?: number; duration_max?: number;
  credits_cost: number; priority?: number; description?: string;
}): number {
  const result = db.prepare(`
    INSERT INTO cost_rules (task_type, model_pattern, region, resolution, duration_min, duration_max, credits_cost, priority, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.task_type, rule.model_pattern || '*', rule.region || '*',
    rule.resolution || '*', rule.duration_min || 0, rule.duration_max || 0,
    rule.credits_cost, rule.priority || 0, rule.description || ''
  );
  return result.lastInsertRowid as number;
}

export function updateCostRule(id: number, rule: {
  task_type?: string; model_pattern?: string; region?: string;
  resolution?: string; duration_min?: number; duration_max?: number;
  credits_cost?: number; priority?: number; description?: string;
}): void {
  const existing = db.prepare('SELECT * FROM cost_rules WHERE id = ?').get(id) as any;
  if (!existing) return;
  db.prepare(`
    UPDATE cost_rules SET task_type=?, model_pattern=?, region=?, resolution=?,
    duration_min=?, duration_max=?, credits_cost=?, priority=?, description=? WHERE id=?
  `).run(
    rule.task_type ?? existing.task_type, rule.model_pattern ?? existing.model_pattern,
    rule.region ?? existing.region, rule.resolution ?? existing.resolution,
    rule.duration_min ?? existing.duration_min, rule.duration_max ?? existing.duration_max,
    rule.credits_cost ?? existing.credits_cost, rule.priority ?? existing.priority,
    rule.description ?? existing.description, id
  );
}

export function deleteCostRule(id: number): void {
  db.prepare('DELETE FROM cost_rules WHERE id = ?').run(id);
}

/**
 * 查询匹配的积分消耗规则
 *
 * @param taskType 'image' 或 'video'
 * @param params 模型、地区、分辨率、时长
 * @returns 匹配的积分消耗，无匹配返回默认值
 */
export function queryCostRule(
  taskType: string,
  params: { model?: string; region?: string; resolution?: string; duration?: number }
): number {
  const { model = '', region = 'cn', resolution = '2k', duration = 0 } = params;

  // 查询所有同类型规则，按优先级降序
  const rules = db.prepare(
    'SELECT * FROM cost_rules WHERE task_type = ? ORDER BY priority DESC, id'
  ).all(taskType) as any[];

  for (const rule of rules) {
    // 模型匹配：'*' 匹配所有，精确匹配，或模糊包含
    if (rule.model_pattern !== '*' && !model.includes(rule.model_pattern)) continue;
    // 地区匹配
    if (rule.region !== '*' && rule.region !== region) continue;
    // 分辨率匹配
    if (rule.resolution !== '*' && rule.resolution !== resolution) continue;
    // 时长匹配（仅视频）
    if (taskType === 'video') {
      if (rule.duration_min > 0 && duration < rule.duration_min) continue;
      if (rule.duration_max > 0 && duration > rule.duration_max) continue;
    }
    return rule.credits_cost;
  }

  // 无匹配，返回保守默认值
  return taskType === 'video' ? 50 : 5;
}

// ==================== API Key管理 ====================

export function generateApiKey(name: string, accountId?: number): string {
  const apiKey = 'jm-' + crypto.randomBytes(32).toString('hex');
  const preview = apiKey.slice(0, 6) + '****' + apiKey.slice(-4);
  db.prepare('INSERT INTO api_keys (name, api_key, key_preview, account_id) VALUES (?, ?, ?, ?)')
    .run(name, apiKey, preview, accountId || null);
  return apiKey;
}

export function getApiKeys() {
  return db.prepare(`
    SELECT k.id, k.name, k.key_preview, k.is_active, k.call_count, k.last_used, k.created_at,
           a.name as account_name
    FROM api_keys k
    LEFT JOIN jimeng_accounts a ON k.account_id = a.id
    ORDER BY k.created_at DESC
  `).all();
}

export function validateApiKey(apiKey: string): { valid: boolean; accountId?: number; keyId?: number } {
  const key = db.prepare('SELECT id, account_id, is_active FROM api_keys WHERE api_key = ?').get(apiKey) as any;
  if (!key || !key.is_active) return { valid: false };
  return { valid: true, accountId: key.account_id, keyId: key.id };
}

export function incrementApiKeyUsage(keyId: number): void {
  db.prepare('UPDATE api_keys SET call_count = call_count + 1, last_used = datetime(\'now\', \'localtime\') WHERE id = ?').run(keyId);
}

export function toggleApiKey(keyId: number, isActive: boolean): void {
  db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, keyId);
}

export function deleteApiKey(keyId: number): void {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyId);
}

export function getRandomAccountToken(): string | null {
  const accounts = db.prepare('SELECT token FROM jimeng_accounts WHERE status != ? ORDER BY RANDOM() LIMIT 1').all('invalid') as { token: string }[];
  return accounts.length > 0 ? accounts[0].token : null;
}

/**
 * 根据 token 精确查找账号（用于匹配 Authorization header 中的 token 与 DB 中的账号）
 *
 * @param token session token
 * @returns 账号信息或 null
 */
export function getAccountByToken(token: string): { id: number; credits_remaining: number; status: string; proxy_url: string; cookie: string; cdp_port?: number; cdp_ws_url?: string; bitbrowser_profile_id?: string } | null {
  // 去掉可能的区域前缀进行匹配，因为 DB 中存储的是完整 token
  const account = db.prepare(
    'SELECT id, credits_remaining, status, proxy_url, cookie, cdp_port, cdp_ws_url, bitbrowser_profile_id FROM jimeng_accounts WHERE token = ?'
  ).get(token) as { id: number; credits_remaining: number; status: string; proxy_url: string; cookie: string; cdp_port?: number; cdp_ws_url?: string; bitbrowser_profile_id?: string } | undefined;
  return account || null;
}

/**
 * 批量获取所有有效账号的 token + 积分（用于负载均衡）
 *
 * @returns 账号积分列表
 */
export function getAllAccountCredits(): { token: string; credits_remaining: number; status: string }[] {
  return db.prepare(
    'SELECT token, credits_remaining, status FROM jimeng_accounts WHERE status != ?'
  ).all('invalid') as { token: string; credits_remaining: number; status: string }[];
}

export default {
  updateRemoteBrowserSettings,
  getRemoteBrowserSettings,
  setSetting,
  getSetting,
  encryptSecret,
  decryptSecret,
  isSetupComplete,
  createUser,
  validateUser,
  changePassword,
  createSession,
  validateSession,
  deleteSession,
  recordCall,
  getStats,
  saveMedia,
  getMedia,
  addLog,
  getLogs,
  clearLogs,
  addAccount,
  getAccounts,
  getAccountById,
  getAccountToken,
  updateAccountCredits,
  updateAccountStatus,
  updateAccountProxy,
  updateAccountCookie,
  getAccountCookieByToken,
  updateAccountTokenAndCookie,
  updateAccountLoginStatus,
  updateAccountBitBrowserRuntime,
  updateAccountBitBrowserProfile,
  updateAccountLoginSecret,
  importLoginAccount,
  deleteAccount,
  getCostRules,
  addCostRule,
  updateCostRule,
  deleteCostRule,
  queryCostRule,
  generateApiKey,
  getApiKeys,
  validateApiKey,
  incrementApiKeyUsage,
  toggleApiKey,
  deleteApiKey,
  getRandomAccountToken,
  getAccountByToken,
  getAllAccountCredits,
  getAllAccountTokens
};
