import util from '@/lib/util.ts';
import logger from '@/lib/logger.ts';
import db from '@/lib/database.ts';
import { getCredit, getTokenLiveStatus } from '@/api/controllers/core.ts';
import { buildTokenWithProxy } from '@/lib/load-balancer.ts';

// ==================== 反检测：降低检测频率 ====================
// 存活检测间隔：每 2 小时（而非 30 分钟），减少"无意义"请求
const HEALTH_CHECK_INTERVAL = '0 */2 * * *';

// 积分同步间隔：每 12 小时（而非 6 小时）
const CREDITS_SYNC_INTERVAL = '0 */12 * * *';

// 连续失败次数阈值，超过则标记为 expired
const MAX_FAILURE_COUNT = 3;

// 记录每个账号的连续失败次数
const failureCounts = new Map<number, number>();

// ==================== 反检测：随机延迟 ====================
// 模拟人类操作间隔，避免固定时间模式被检测
function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * 检查单个账号的存活状态
 */
async function checkAccountHealth(account: { id: number; name: string; token: string; proxy_url: string | null }): Promise<boolean> {
  const masked = account.name || `账号${account.id}`;
  const proxyToken = buildTokenWithProxy(account.token, account.proxy_url);

  try {
    const isAlive = await getTokenLiveStatus(proxyToken);

    if (isAlive) {
      // 存活，重置失败计数
      failureCounts.set(account.id, 0);
      db.updateAccountStatus(account.id, 'active');
      logger.debug(`[账号保活] ${masked} 状态正常`);
      return true;
    } else {
      // 不存活，增加失败计数
      return handleFailure(account, masked, 'Token 已失效');
    }
  } catch (error) {
    return handleFailure(account, masked, error.message);
  }
}

/**
 * 处理检测失败
 */
function handleFailure(account: { id: number; name: string }, masked: string, reason: string): boolean {
  const currentFailures = (failureCounts.get(account.id) || 0) + 1;
  failureCounts.set(account.id, currentFailures);

  if (currentFailures >= MAX_FAILURE_COUNT) {
    db.updateAccountStatus(account.id, 'expired');
    logger.warn(`[账号保活] ${masked} 连续失败 ${currentFailures} 次，标记为 expired，原因: ${reason}`);
  } else {
    db.updateAccountStatus(account.id, 'warning');
    logger.warn(`[账号保活] ${masked} 检测失败 (${currentFailures}/${MAX_FAILURE_COUNT})，原因: ${reason}`);
  }

  return false;
}

/**
 * 执行所有账号的存活检测
 */
async function runHealthCheck(): Promise<void> {
  const accounts = db.getAllAccountTokens();

  if (accounts.length === 0) {
    logger.debug('[账号保活] 无账号，跳过存活检测');
    return;
  }

  // 反检测：随机打乱检测顺序，避免固定模式
  const shuffled = [...accounts].sort(() => Math.random() - 0.5);

  logger.info(`[账号保活] 开始存活检测，共 ${shuffled.length} 个账号`);

  let activeCount = 0;
  let failedCount = 0;

  for (const account of shuffled) {
    const isAlive = await checkAccountHealth(account);
    if (isAlive) {
      activeCount++;
    } else {
      failedCount++;
    }

    // 反检测：随机延迟 3-8 秒，模拟人类操作间隔
    await randomDelay(3000, 8000);
  }

  logger.info(`[账号保活] 存活检测完成: ${activeCount} 正常, ${failedCount} 异常`);
}

/**
 * 同步单个账号的积分
 */
async function syncAccountCredits(account: { id: number; name: string; token: string; proxy_url: string | null }): Promise<void> {
  const masked = account.name || `账号${account.id}`;
  const proxyToken = buildTokenWithProxy(account.token, account.proxy_url);

  try {
    const creditInfo = await getCredit(proxyToken);
    db.updateAccountCredits(account.id, creditInfo.totalCredit, creditInfo.totalCredit);
    logger.debug(`[积分同步] ${masked} 积分=${creditInfo.totalCredit}`);
  } catch (error) {
    logger.warn(`[积分同步] ${masked} 同步失败: ${error.message}`);
  }
}

/**
 * 执行所有账号的积分同步
 */
async function runCreditsSync(): Promise<void> {
  const accounts = db.getAllAccountTokens();

  if (accounts.length === 0) {
    logger.debug('[积分同步] 无账号，跳过积分同步');
    return;
  }

  // 反检测：随机打乱同步顺序
  const shuffled = [...accounts].sort(() => Math.random() - 0.5);

  logger.info(`[积分同步] 开始同步积分，共 ${shuffled.length} 个账号`);

  let successCount = 0;
  let failedCount = 0;

  for (const account of shuffled) {
    try {
      await syncAccountCredits(account);
      successCount++;
    } catch {
      failedCount++;
    }

    // 反检测：随机延迟 5-15 秒
    await randomDelay(5000, 15000);
  }

  logger.info(`[积分同步] 同步完成: ${successCount} 成功, ${failedCount} 失败`);
}

/**
 * 初始化账号保活定时任务
 */
export function initAccountKeeper(): void {
  logger.info('[账号保活] 初始化定时任务...');

  // 存活检测定时任务（每 2 小时）
  const healthCheckJob = util.createCronJob(HEALTH_CHECK_INTERVAL, async () => {
    try {
      await runHealthCheck();
    } catch (error) {
      logger.error('[账号保活] 存活检测任务异常:', error.message);
    }
  });

  // 积分同步定时任务（每 12 小时）
  const creditsSyncJob = util.createCronJob(CREDITS_SYNC_INTERVAL, async () => {
    try {
      await runCreditsSync();
    } catch (error) {
      logger.error('[积分同步] 同步任务异常:', error.message);
    }
  });

  // 启动定时任务
  healthCheckJob.start();
  creditsSyncJob.start();

  logger.success('[账号保活] 定时任务已启动');
  logger.info('  - 存活检测: 每 2 小时执行一次');
  logger.info('  - 积分同步: 每 12 小时执行一次');

  // 反检测：启动时延迟 30 秒再执行首次检测，避免启动瞬间大量请求
  setTimeout(async () => {
    logger.info('[账号保活] 启动后首次检测...');
    await runHealthCheck();
  }, 30000);
}

/**
 * 手动触发存活检测（供 API 调用）
 */
export async function triggerHealthCheck(): Promise<{ active: number; failed: number }> {
  const accounts = db.getAllAccountTokens();

  if (accounts.length === 0) {
    return { active: 0, failed: 0 };
  }

  let activeCount = 0;
  let failedCount = 0;

  for (const account of accounts) {
    const isAlive = await checkAccountHealth(account);
    if (isAlive) {
      activeCount++;
    } else {
      failedCount++;
    }
  }

  return { active: activeCount, failed: failedCount };
}

/**
 * 手动触发积分同步（供 API 调用）
 */
export async function triggerCreditsSync(): Promise<{ success: number; failed: number }> {
  const accounts = db.getAllAccountTokens();

  if (accounts.length === 0) {
    return { success: 0, failed: 0 };
  }

  let successCount = 0;
  let failedCount = 0;

  for (const account of accounts) {
    try {
      await syncAccountCredits(account);
      successCount++;
    } catch {
      failedCount++;
    }
  }

  return { success: successCount, failed: failedCount };
}
