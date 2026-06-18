import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import db from "@/lib/database.ts";
import { getCredit } from "@/api/controllers/core.ts";

// ==================== 积分消耗估算 ====================

/**
 * 估算生图积分消耗
 *
 * 即梦官方参考值（jimeng-4.5，2k 分辨率）：
 * - 1 张：约 4-5 积分
 * - 4 张（默认）：约 12-20 积分
 *
 * @param count 生成图片数量
 * @param resolution 分辨率（1k/2k/4k）
 */
export function estimateImageCredits(count: number = 4, resolution: string = '2k'): number {
  const basePerImage = resolution === '4k' ? 8 : resolution === '1k' ? 3 : 5;
  return basePerImage * count;
}

/**
 * 估算生视频积分消耗
 *
 * 即梦官方参考值：
 * - 5s：约 20-30 积分
 * - 10s：约 40-60 积分
 * - 15s：约 60-90 积分
 *
 * @param model 视频模型
 * @param duration 时长（秒）
 */
export function estimateVideoCredits(model: string = '', duration: number = 5): number {
  // 高端模型消耗更高
  const isHighEnd = model.includes('veo3') || model.includes('sora2') || model.includes('seedance-2.0');
  const multiplier = isHighEnd ? 1.5 : 1.0;

  // 按时长线性估算
  let baseCost: number;
  if (duration <= 5) {
    baseCost = 25;
  } else if (duration <= 8) {
    baseCost = 35;
  } else if (duration <= 10) {
    baseCost = 50;
  } else if (duration <= 12) {
    baseCost = 60;
  } else {
    // 15s
    baseCost = 75;
  }

  return Math.ceil(baseCost * multiplier);
}

/**
 * 统一积分估算入口
 */
export function estimateCredits(
  taskType: 'image' | 'video',
  options: { resolution?: string; count?: number; model?: string; duration?: number } = {}
): number {
  if (taskType === 'video') {
    return estimateVideoCredits(options.model, options.duration || 5);
  }
  return estimateImageCredits(options.count || 4, options.resolution || '2k');
}

// ==================== Token 积分查询 ====================

interface TokenCredit {
  token: string;
  credits: number;
  source: 'cache' | 'realtime';
}

/**
 * 查询单个 token 的积分
 * 优先使用 DB 缓存，缓存缺失时实时查询并更新缓存
 *
 * @param token session token
 * @returns 积分信息
 */
async function queryTokenCredits(token: string): Promise<TokenCredit> {
  // 先查 DB 缓存
  const cached = db.getAccountByToken(token);
  if (cached && cached.credits_remaining > 0) {
    logger.debug(`[负载均衡] token ${token.substring(0, 8)}... 使用缓存积分: ${cached.credits_remaining}`);
    return { token, credits: cached.credits_remaining, source: 'cache' };
  }

  // 缓存缺失或为 0，实时查询
  try {
    const creditInfo = await getCredit(token);
    const total = creditInfo.totalCredit;

    // 更新 DB 缓存（如果该 token 已注册到账号表）
    if (cached) {
      db.updateAccountCredits(cached.id, total, total);
      db.updateAccountStatus(cached.id, 'active');
    }

    logger.info(`[负载均衡] token ${token.substring(0, 8)}... 实时查询积分: ${total}`);
    return { token, credits: total, source: 'realtime' };
  } catch (e) {
    logger.warn(`[负载均衡] token ${token.substring(0, 8)}... 积分查询失败: ${e.message}`);
    return { token, credits: 0, source: 'realtime' };
  }
}

// ==================== 智能 Token 选择 ====================

/**
 * 选择策略：
 * - 'drain-low'：余额升序，优先用完小余额（适用于生图等低成本任务）
 * - 'highest'：余额降序，优先用大余额（适用于生视频等高成本任务）
 */
export type SelectionStrategy = 'drain-low' | 'highest';

/**
 * 从多个 token 中智能选择一个
 *
 * 1. 查询所有 token 的积分（优先缓存，其次实时）
 * 2. 过滤余额不足以完成任务的 token（但至少保留 1 个）
 * 3. 按策略排序选择
 *
 * @param tokens 可用 token 列表
 * @param estimatedCost 预估任务积分消耗
 * @param strategy 选择策略
 * @returns 选中的 token
 */
export async function selectToken(
  tokens: string[],
  estimatedCost: number,
  strategy: SelectionStrategy = 'drain-low'
): Promise<string> {
  // 只有 1 个 token，直接返回
  if (tokens.length === 1) {
    logger.info(`[负载均衡] 仅 1 个 token，直接使用`);
    return tokens[0];
  }

  // 并行查询所有 token 的积分
  const creditResults = await Promise.all(tokens.map(t => queryTokenCredits(t)));

  // 记录所有 token 的积分状态
  for (const r of creditResults) {
    const masked = r.token.substring(0, 8) + '...';
    logger.info(`[负载均衡] token=${masked} 积分=${r.credits} 来源=${r.source}`);
  }

  // 过滤：积分 >= estimatedCost 的 token
  let eligible = creditResults.filter(r => r.credits >= estimatedCost);

  if (eligible.length === 0) {
    // 没有足够积分的 token，保留全部（让上游决定是否报错）
    logger.warn(`[负载均衡] 没有 token 的积分(${creditResults.map(r => r.credits).join('/')})能满足预估消耗 ${estimatedCost}，使用全部 token 尝试`);
    eligible = creditResults;
  } else {
    logger.info(`[负载均衡] ${eligible.length}/${creditResults.length} 个 token 满足预估消耗 ${estimatedCost}`);
  }

  // 按策略排序
  if (strategy === 'drain-low') {
    // 余额升序：最小的排前面，优先用完
    eligible.sort((a, b) => a.credits - b.credits);
  } else {
    // 余额降序：最大的排前面，优先用大余额
    eligible.sort((a, b) => b.credits - a.credits);
  }

  const selected = eligible[0];
  const masked = selected.token.substring(0, 8) + '...';
  logger.info(`[负载均衡] 选中 token=${masked} 积分=${selected.credits} 策略=${strategy}`);

  return selected.token;
}

// ==================== 带重试的任务执行 ====================

/**
 * 判断错误是否为积分不足相关
 */
export function isInsufficientCreditsError(error: any): boolean {
  if (error.code === 5000 || error.code === 1006 || error.code === 2039) return true;
  if (error.code && EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS &&
      error.code === EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS[0]) return true;
  const msg = error.message || '';
  return msg.includes('积分不足') || msg.includes('5000') || msg.includes('1006') || msg.includes('2039');
}

export interface RetryOptions {
  maxRetries?: number;
  strategy?: SelectionStrategy;
  estimatedCost?: number;
}

/**
 * 带积分感知重试的任务执行
 *
 * 1. 用 selectToken 选出第一个 token
 * 2. 执行 taskFn(token)
 * 3. 如果积分不足错误，从剩余 token 中选下一个重试
 * 4. 最多重试 maxRetries 次
 *
 * @param tokens 可用 token 列表
 * @param taskFn 任务函数，接收 token 返回结果
 * @param options 重试选项
 */
export async function executeWithRetry<T>(
  tokens: string[],
  taskFn: (token: string) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, strategy = 'drain-low', estimatedCost = 0 } = options;

  // 如果只有 1 个 token，不走重试逻辑
  if (tokens.length === 1) {
    return await taskFn(tokens[0]);
  }

  const usedTokens = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt <= Math.min(maxRetries, tokens.length - 1); attempt++) {
    // 可用 token = 全部 - 已用过的
    const availableTokens = tokens.filter(t => !usedTokens.has(t));
    if (availableTokens.length === 0) {
      logger.warn(`[负载均衡] 所有 token 已尝试过，无可用 token`);
      break;
    }

    const token = await selectToken(availableTokens, estimatedCost, strategy);
    usedTokens.add(token);
    const masked = token.substring(0, 8) + '...';

    try {
      logger.info(`[负载均衡] 第 ${attempt + 1} 次尝试，使用 token=${masked}`);
      return await taskFn(token);
    } catch (error) {
      lastError = error;
      logger.error(`[负载均衡] token=${masked} 执行失败: ${error.message}`);

      if (isInsufficientCreditsError(error)) {
        logger.warn(`[负载均衡] 积分不足错误，尝试切换 token 重试...`);
        continue;
      }

      // 非积分错误，直接抛出
      throw error;
    }
  }

  // 所有重试都失败
  if (lastError) throw lastError;
  throw new Error('[负载均衡] 所有 token 均执行失败');
}
