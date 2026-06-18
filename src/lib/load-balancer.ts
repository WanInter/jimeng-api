import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import db from "@/lib/database.ts";
import { getCredit } from "@/api/controllers/core.ts";

// ==================== 积分消耗估算（基于 DB 可配置规则） ====================

/**
 * 查询积分消耗（优先从 DB cost_rules 表匹配，兜底用保守默认值）
 *
 * @param taskType 'image' 或 'video'
 * @param params 任务参数
 * @returns 预估积分消耗
 */
export function estimateCredits(
  taskType: 'image' | 'video',
  params: { model?: string; region?: string; resolution?: string; duration?: number } = {}
): number {
  return db.queryCostRule(taskType, params);
}

// ==================== Token 积分与代理查询 ====================

interface TokenInfo {
  token: string;
  credits: number;
  proxyUrl: string | null;
  source: 'cache' | 'realtime';
}

/**
 * 查询单个 token 的积分和代理配置
 * 优先使用 DB 缓存，缓存缺失时实时查询并更新缓存
 *
 * @param token session token
 * @returns token 信息（积分 + 代理）
 */
async function queryTokenInfo(token: string): Promise<TokenInfo> {
  // 先查 DB 缓存（包含 proxy_url）
  const cached = db.getAccountByToken(token);
  const accountProxy = cached?.proxy_url || null;

  if (cached && cached.credits_remaining > 0) {
    logger.debug(`[负载均衡] token ${token.substring(0, 8)}... 缓存积分=${cached.credits_remaining} 代理=${accountProxy || '无'}`);
    return { token, credits: cached.credits_remaining, proxyUrl: accountProxy, source: 'cache' };
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

    logger.info(`[负载均衡] token ${token.substring(0, 8)}... 实时积分=${total} 代理=${accountProxy || '无'}`);
    return { token, credits: total, proxyUrl: accountProxy, source: 'realtime' };
  } catch (e) {
    logger.warn(`[负载均衡] token ${token.substring(0, 8)}... 积分查询失败: ${e.message}`);
    return { token, credits: 0, proxyUrl: accountProxy, source: 'realtime' };
  }
}

/**
 * 将代理 URL 拼接到 token 前面
 * 如果 token 已经包含代理前缀，优先使用 token 自带的
 * 如果账号绑定了代理，使用账号的
 *
 * @param token 原始 token
 * @param accountProxy 账号绑定的代理 URL
 * @returns 拼接后的 token（代理@token 格式）
 */
export function buildTokenWithProxy(token: string, accountProxy: string | null): string {
  // token 自带代理（proxy@token 格式），不覆盖
  const proxyPattern = /^(https?|socks(?:4|5)?):\/\//i;
  if (proxyPattern.test(token.trim())) {
    return token;
  }
  // 账号绑定了代理，拼接
  if (accountProxy) {
    return `${accountProxy}@${token}`;
  }
  return token;
}

// ==================== 智能 Token 选择 ====================

/**
 * 选择策略：
 * - 'drain-low'：余额升序，优先用完小余额（适用于生图等低成本任务）
 * - 'highest'：余额降序，优先用大余额（适用于生视频等高成本任务）
 */
export type SelectionStrategy = 'drain-low' | 'highest';

export interface TokenSelection {
  token: string;          // 原始 token
  proxyToken: string;     // 拼接代理后的 token（可直接用于请求）
  credits: number;
  proxyUrl: string | null;
}

/**
 * 从多个 token 中智能选择一个
 *
 * 1. 查询所有 token 的积分（优先缓存，其次实时）
 * 2. 过滤余额不足以完成任务的 token（但至少保留 1 个）
 * 3. 按策略排序选择
 * 4. 拼接账号绑定的代理
 *
 * @param tokens 可用 token 列表
 * @param estimatedCost 预估任务积分消耗
 * @param strategy 选择策略
 * @returns 选中的 token 信息（含代理）
 */
export async function selectToken(
  tokens: string[],
  estimatedCost: number,
  strategy: SelectionStrategy = 'drain-low'
): Promise<TokenSelection> {
  // 只有 1 个 token，直接返回
  if (tokens.length === 1) {
    const info = await queryTokenInfo(tokens[0]);
    const proxyToken = buildTokenWithProxy(info.token, info.proxyUrl);
    logger.info(`[负载均衡] 仅 1 个 token，直接使用，代理=${info.proxyUrl || '无'}`);
    return { token: info.token, proxyToken, credits: info.credits, proxyUrl: info.proxyUrl };
  }

  // 并行查询所有 token 的积分和代理
  const tokenInfos = await Promise.all(tokens.map(t => queryTokenInfo(t)));

  // 记录所有 token 的状态
  for (const r of tokenInfos) {
    const masked = r.token.substring(0, 8) + '...';
    logger.info(`[负载均衡] token=${masked} 积分=${r.credits} 来源=${r.source} 代理=${r.proxyUrl || '无'}`);
  }

  // 过滤：积分 >= estimatedCost 的 token
  let eligible = tokenInfos.filter(r => r.credits >= estimatedCost);

  if (eligible.length === 0) {
    logger.warn(`[负载均衡] 没有 token 的积分(${tokenInfos.map(r => r.credits).join('/')})能满足预估消耗 ${estimatedCost}，使用全部尝试`);
    eligible = tokenInfos;
  } else {
    logger.info(`[负载均衡] ${eligible.length}/${tokenInfos.length} 个 token 满足预估消耗 ${estimatedCost}`);
  }

  // 按策略排序
  if (strategy === 'drain-low') {
    eligible.sort((a, b) => a.credits - b.credits);
  } else {
    eligible.sort((a, b) => b.credits - a.credits);
  }

  const selected = eligible[0];
  const proxyToken = buildTokenWithProxy(selected.token, selected.proxyUrl);
  const masked = selected.token.substring(0, 8) + '...';
  logger.info(`[负载均衡] 选中 token=${masked} 积分=${selected.credits} 策略=${strategy} 代理=${selected.proxyUrl || '无'}`);

  return {
    token: selected.token,
    proxyToken,
    credits: selected.credits,
    proxyUrl: selected.proxyUrl,
  };
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
 * 1. 用 selectToken 选出第一个 token（含代理绑定）
 * 2. 执行 taskFn(proxyToken)
 * 3. 如果积分不足错误，从剩余 token 中选下一个重试
 * 4. 最多重试 maxRetries 次
 *
 * @param tokens 可用 token 列表
 * @param taskFn 任务函数，接收拼接代理后的 token
 * @param options 重试选项
 */
export async function executeWithRetry<T>(
  tokens: string[],
  taskFn: (token: string) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, strategy = 'drain-low', estimatedCost = 0 } = options;

  if (tokens.length === 1) {
    const selection = await selectToken(tokens, estimatedCost, strategy);
    return await taskFn(selection.proxyToken);
  }

  const usedTokens = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt <= Math.min(maxRetries, tokens.length - 1); attempt++) {
    const availableTokens = tokens.filter(t => !usedTokens.has(t));
    if (availableTokens.length === 0) {
      logger.warn(`[负载均衡] 所有 token 已尝试过，无可用 token`);
      break;
    }

    const selection = await selectToken(availableTokens, estimatedCost, strategy);
    usedTokens.add(selection.token);
    const masked = selection.token.substring(0, 8) + '...';

    try {
      logger.info(`[负载均衡] 第 ${attempt + 1} 次尝试，token=${masked} 代理=${selection.proxyUrl || '无'}`);
      return await taskFn(selection.proxyToken);
    } catch (error) {
      lastError = error;
      logger.error(`[负载均衡] token=${masked} 执行失败: ${error.message}`);

      if (isInsufficientCreditsError(error)) {
        logger.warn(`[负载均衡] 积分不足错误，切换 token 重试...`);
        continue;
      }
      throw error;
    }
  }

  if (lastError) throw lastError;
  throw new Error('[负载均衡] 所有 token 均执行失败');
}
