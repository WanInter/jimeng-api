import os from "os";
import path from "path";
import _ from "lodash";
import mime from "mime";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { browserFetchJson } from "@/lib/browser-fetch.ts";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import db from "@/lib/database.ts";
import { JimengErrorHandler, JimengErrorResponse } from "@/lib/error-handler.ts";
import { BASE_URL_DREAMINA_US, BASE_URL_DREAMINA_HK, DA_VERSION, WEB_VERSION } from "@/api/consts/dreamina.ts";

import {
  BASE_URL_CN,
  BASE_URL_US_COMMERCE,
  BASE_URL_HK_COMMERCE,
  BASE_URL_HK,
  DEFAULT_ASSISTANT_ID_CN,
  DEFAULT_ASSISTANT_ID_US,
  DEFAULT_ASSISTANT_ID_HK,
  DEFAULT_ASSISTANT_ID_JP,
  DEFAULT_ASSISTANT_ID_SG,
  DEFAULT_ASSISTANT_ID_VN,
  PLATFORM_CODE,
  REGION_CN,
  REGION_US,
  REGION_HK,
  REGION_JP,
  REGION_SG,
  REGION_VN,
  VERSION_CODE,
  RETRY_CONFIG
} from "@/api/consts/common.ts";

// ==================== 反检测：设备标识随机化 ====================
// 每次请求生成独立的设备标识，避免所有请求共享同一设备指纹
function generateDeviceId(): string {
  return String(Math.floor(Math.random() * 999999999999999999) + 7000000000000000000);
}
function generateWebId(): string {
  return String(Math.floor(Math.random() * 999999999999999999) + 7000000000000000000);
}
function generateUserId(): string {
  return util.uuid(false);
}

// ==================== 反检测：User-Agent 池 ====================
const UA_POOL = [
  // Match BitBrowser 14 / Dreamina VN environment. Random UA caused Shark fingerprint mismatch.
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
];

// 从 UA 解析 Chrome 版本号
function extractChromeVersion(ua: string): string {
  const match = ua.match(/Chrome\/(\d+)/);
  return match ? match[1] : "142";
}

// 检测实际操作系统
const IS_LINUX = os.platform() !== "win32";
// Match BitBrowser macOS fingerprint instead of the server OS.
const PLATFORM_STR = "macOS";
const SEC_CH_UA_PLATFORM = '"macOS"';

// ==================== 反检测：速率限制器 ====================
// Per-token 令牌桶限流，防止高频请求触发风控
const rateLimiters = new Map<string, { tokens: number; lastRefill: number }>();
const RATE_LIMIT_MAX_TOKENS = 5; // 桶容量：最多 5 个并发请求
const RATE_LIMIT_REFILL_RATE = 1; // 每秒补充 1 个令牌

function acquireRateLimit(token: string): void {
  const now = Date.now();
  let limiter = rateLimiters.get(token);
  if (!limiter) {
    limiter = { tokens: RATE_LIMIT_MAX_TOKENS, lastRefill: now };
    rateLimiters.set(token, limiter);
  }

  // 补充令牌
  const elapsed = (now - limiter.lastRefill) / 1000;
  limiter.tokens = Math.min(RATE_LIMIT_MAX_TOKENS, limiter.tokens + elapsed * RATE_LIMIT_REFILL_RATE);
  limiter.lastRefill = now;

  // 如果没有可用令牌，阻塞等待
  if (limiter.tokens < 1) {
    const waitMs = ((1 - limiter.tokens) / RATE_LIMIT_REFILL_RATE) * 1000;
    // 同步等待（通过 Atomics 实现）
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    Atomics.wait(int32, 0, 0, Math.min(waitMs, 5000));
    limiter.tokens = 1;
  }

  limiter.tokens -= 1;
}

// ==================== 反检测：Cookie 生成 ====================
// 生成随机 ttwid（字节跳动 WebID 跟踪标识）
function generateTtwid(): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// 生成随机 odin_tt
function generateOdinTt(): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// 生成随机 s_v_web_id
function generateSvWebId(): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// 生成随机 passport_csrf_token
function generatePassportCsrfToken(): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}


function getCookieValue(cookie: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`));
  return match ? match[1] : undefined;
}

// 模型名称
const MODEL_NAME = "jimeng";
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;

/**
 * 获取缓存中的access_token
 *
 * 目前jimeng的access_token是固定的，暂无刷新功能
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
export async function acquireToken(refreshToken: string): Promise<string> {
  return refreshToken;
}

/**
 * 解析 token 中的地区信息
 *
 * @param refreshToken 刷新令牌
 * @returns 地区信息对象
 */
export interface RegionInfo {
  isUS: boolean;
  isHK: boolean;
  isJP: boolean;
  isSG: boolean;
  isVN: boolean;
  isInternational: boolean;
  isCN: boolean;
}

export interface TokenWithProxy {
  token: string;
  proxyUrl: string | null;
}

export function parseProxyFromToken(rawToken: string): TokenWithProxy {
  const tokenValue = rawToken.trim();
  const proxyPattern = /^(https?|socks(?:4|5)?):\/\//i;
  if (!proxyPattern.test(tokenValue)) return { token: tokenValue, proxyUrl: null };

  const lastAtIndex = tokenValue.lastIndexOf("@");
  if (lastAtIndex <= 0 || lastAtIndex === tokenValue.length - 1)
    return { token: tokenValue, proxyUrl: null };

  const proxyUrl = tokenValue.slice(0, lastAtIndex);
  const token = tokenValue.slice(lastAtIndex + 1);
  if (!proxyUrl || !token) return { token: tokenValue, proxyUrl: null };

  return { token, proxyUrl };
}

export function parseRegionFromToken(refreshToken: string): RegionInfo {
  const { token: parsedToken } = parseProxyFromToken(refreshToken);
  const token = parsedToken.toLowerCase();
  const isUS = token.startsWith('us-');
  const isHK = token.startsWith('hk-');
  const isJP = token.startsWith('jp-');
  const isSG = token.startsWith('sg-');
  const isVN = token.startsWith('vn-');
  const isInternational = isUS || isHK || isJP || isSG || isVN;

  return {
    isUS,
    isHK,
    isJP,
    isSG,
    isVN,
    isInternational,
    isCN: !isInternational
  };
}

/**
 * 根据地区获取 Referer
 *
 * @param refreshToken 刷新令牌
 * @param cnPath 国内站路径
 * @returns Referer URL
 */
export function getRefererByRegion(refreshToken: string, cnPath: string): string {
  const { isInternational } = parseRegionFromToken(refreshToken);
  return isInternational
    ? "https://dreamina.capcut.com/"
    : `https://jimeng.jianying.com${cnPath}`;
}

/**
 * 根据地区获取 AssistantID
 *
 * @param regionInfo 地区信息
 * @returns AssistantID
 */
export function getAssistantId(regionInfo: RegionInfo): number {
  if (regionInfo.isUS) return DEFAULT_ASSISTANT_ID_US;
  if (regionInfo.isJP) return DEFAULT_ASSISTANT_ID_JP;
  if (regionInfo.isSG) return DEFAULT_ASSISTANT_ID_SG;
  if (regionInfo.isVN) return DEFAULT_ASSISTANT_ID_VN;
  if (regionInfo.isHK) return DEFAULT_ASSISTANT_ID_HK;
  return DEFAULT_ASSISTANT_ID_CN;
}

/**
 * 生成cookie（每次请求独立生成，模拟真实浏览器 Cookie 行为）
 *
 * 包含字节跳动完整追踪 Cookie：
 * - ttwid: WebID 跟踪标识
 * - odin_tt: 设备标识
 * - s_v_web_id: 验证 Cookie
 * - fpk1: 浏览器指纹
 * - passport_csrf_token: CSRF 保护
 */
export function generateCookie(refreshToken: string) {
  const { token: tokenWithRegion } = parseProxyFromToken(refreshToken);
  const { isUS, isHK, isJP, isSG, isVN } = parseRegionFromToken(tokenWithRegion);
  const token = (isUS || isHK || isJP || isSG || isVN)
    ? tokenWithRegion.substring(3)
    : tokenWithRegion;

  const deviceId = generateDeviceId();
  const webId = generateWebId();
  const userId = generateUserId();
  const now = util.unixTimestamp();

  // 动态生成 sid_guard 过期时间（当前时间 + 60天）
  const expiryDate = new Date((now + 5184000) * 1000);
  const expiryStr = expiryDate.toUTCString().replace(/,/g, "%2C").replace(/ /g, "+").replace(/:/g, "%3A");

  return [
    `ttwid=${generateTtwid()}`,
    `odin_tt=${generateOdinTt()}`,
    `s_v_web_id=${generateSvWebId()}`,
    `fpk1=${generatePassportCsrfToken()}`,
    `passport_csrf_token=${generatePassportCsrfToken()}`,
    `_tea_web_id=${webId}`,
    `is_staff_user=false`,
    `sid_guard=${token}%7C${now}%7C5184000%7C${expiryStr}`,
    `uid_tt=${userId}`,
    `uid_tt_ss=${userId}`,
    `sid_tt=${token}`,
    `sessionid=${token}`,
    `sessionid_ss=${token}`,
    `store-region=${isUS ? 'us' : isHK ? 'hk' : isJP ? 'jp' : (isSG || isVN) ? 'sg' : 'cn-gd'}`,
    `store-region-src=uid`,
  ].join("; ");
}

/**
 * 获取积分信息
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
export async function getCredit(refreshToken: string) {
  const referer = getRefererByRegion(refreshToken, "/ai-tool/image/generate");

  const {
    credit: { gift_credit, purchase_credit, vip_credit }
  } = await request("POST", "/commerce/v1/benefits/user_credit", refreshToken, {
    data: {},
    headers: {
      Referer: referer,
    },
    noDefaultParams: true
  });
  logger.info(`\n积分信息: \n赠送积分: ${gift_credit}, 购买积分: ${purchase_credit}, VIP积分: ${vip_credit}`);
  return {
    giftCredit: gift_credit,
    purchaseCredit: purchase_credit,
    vipCredit: vip_credit,
    totalCredit: gift_credit + purchase_credit + vip_credit
  }
}

/**
 * 接收今日积分（仅在积分为 0 时调用）
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
export async function receiveCredit(refreshToken: string) {
  logger.info("正在尝试收取今日积分...")
  const referer = getRefererByRegion(refreshToken, "/ai-tool/home");

  const { receive_quota } = await request("POST", "/commerce/v1/benefits/credit_receive", refreshToken, {
    data: {
      time_zone: "Asia/Shanghai"
    },
    headers: {
      Referer: referer
    }
  });
  logger.info(`今日${receive_quota}积分收取成功`);
  return receive_quota;
}

/**
 * 请求jimeng
 *
 * @param method 请求方法
 * @param uri 请求路径
 * @param params 请求参数
 * @param headers 请求头
 */
export async function request(
  method: string,
  uri: string,
  refreshToken: string,
  options: AxiosRequestConfig & { noDefaultParams?: boolean } = {}
) {
  const { token: tokenWithRegion, proxyUrl } = parseProxyFromToken(refreshToken);
  const regionInfo = parseRegionFromToken(tokenWithRegion);
  const { isUS, isHK, isJP, isSG, isVN } = regionInfo;
  await acquireToken(regionInfo.isInternational ? tokenWithRegion.substring(3) : tokenWithRegion);
  const deviceTime = util.unixTimestamp();
  const sign = util.md5(
    `9e2c|${uri.slice(-7)}|${PLATFORM_CODE}|${VERSION_CODE}|${deviceTime}||11ac`
  );

  let baseUrl: string;
  let aid: number;
  let region: string;

  if (isUS) {
    if (uri.startsWith("/commerce/")) {
      baseUrl = BASE_URL_US_COMMERCE;
    } else {
      baseUrl = BASE_URL_DREAMINA_US;
    }
    aid = DEFAULT_ASSISTANT_ID_US;
    region = REGION_US;
  } else if (isHK || isJP || isSG || isVN) {
    // HK, JP and SG regions use the same SG base URL
    if (uri.startsWith("/commerce/")) {
      baseUrl = BASE_URL_HK_COMMERCE;
    } else {
      baseUrl = BASE_URL_DREAMINA_HK;
    }
    if (isJP) {
      aid = DEFAULT_ASSISTANT_ID_JP;
      region = REGION_JP;
    } else if (isSG) {
      aid = DEFAULT_ASSISTANT_ID_SG;
      region = REGION_SG;
    } else if (isVN) {
      aid = DEFAULT_ASSISTANT_ID_VN;
      // 越南账号当前仍归入 Dreamina 亚太/新加坡链路；生成接口用 SG 区域参数更接近真实站点。
      region = REGION_SG;
    } else {
      aid = DEFAULT_ASSISTANT_ID_HK;
      region = REGION_HK;
    }
  } else {
    // CN region
    baseUrl = BASE_URL_CN;
    aid = DEFAULT_ASSISTANT_ID_CN;
    region = REGION_CN;
  }

  const origin = new URL(baseUrl).origin;

  // 反检测：应用 per-token 速率限制
  acquireRateLimit(tokenWithRegion);

  // 反检测：每次请求独立生成设备标识
  const webId = generateWebId();

  const fullUrl = `${baseUrl}${uri}`;
  const requestParams = options.noDefaultParams ? (options.params || {}) : {
    aid: aid,
    device_platform: "web",
    region: region,
    ...(isUS || isHK || isJP || isSG || isVN ? {} : { webId: webId }),
    da_version: DA_VERSION,
    os: "mac",
    web_component_open_flag: 1,
    web_version: WEB_VERSION,
    aigc_features: "app_lip_sync",
    ...(options.params || {}),
  };

  // 反检测：随机选择 UA，构建匹配的请求头
  const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  const chromeVersion = extractChromeVersion(ua);

  const boundCookie = db.getAccountCookieByToken(refreshToken) || db.getAccountCookieByToken(tokenWithRegion) || "";
  const requestCookie = boundCookie || generateCookie(tokenWithRegion);
  const cookieMsToken = boundCookie ? getCookieValue(boundCookie, "msToken") : undefined;
  const cookieSvWebId = boundCookie ? getCookieValue(boundCookie, "s_v_web_id") : undefined;

  if (cookieMsToken && !requestParams.msToken) requestParams.msToken = cookieMsToken;
  if (cookieSvWebId) {
    if (!requestParams.verifyFp) requestParams.verifyFp = cookieSvWebId;
    if (!requestParams.fp) requestParams.fp = cookieSvWebId;
  }

  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-language": (isVN ? "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5" : "zh-CN,zh;q=0.9"),
    "Cache-control": "no-cache",
    Appvr: VERSION_CODE,
    Pragma: "no-cache",
    Priority: "u=1, i",
    Pf: PLATFORM_CODE,
    "Sec-Ch-Ua": `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not_A Brand";v="99"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": SEC_CH_UA_PLATFORM,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": ua,
    Origin: origin,
    Referer: origin,
    "App-Sdk-Version": "48.0.0",
    Appid: aid,
    Cookie: requestCookie,
    "Device-Time": deviceTime,
    Lan: isUS ? "en" : isJP ? "ja" : (isHK || isSG || isVN) ? "en" : "zh-Hans",
    Loc: isUS ? "us" : isJP ? "jp" : isHK ? "hk" : (isSG || isVN) ? "sg" : "cn",
    Sign: sign,
    "Sign-Ver": "1",
    Tdid: "",
    ...(options.headers || {}),
  };

  // 日志脱敏：不记录完整 URL（含 token）、Cookie、请求体
  const uriOnly = uri;
  logger.info(`发送请求: ${method.toUpperCase()} ${uriOnly}`);
  if (proxyUrl) {
    const maskedProxyUrl = proxyUrl.replace(/\/\/([^@/]+)@/i, "//***@");
    logger.info(`使用代理: ${maskedProxyUrl}`);
  }
  if (boundCookie) {
    logger.info(`使用账号绑定 Cookie${cookieMsToken ? " + msToken" : ""}${cookieSvWebId ? " + verifyFp" : ""}`);
  }

  const proxyAgent = proxyUrl
    ? (proxyUrl.toLowerCase().startsWith("socks")
      ? new SocksProxyAgent(proxyUrl)
      : new HttpsProxyAgent(proxyUrl))
    : undefined;

  // 添加重试逻辑
  let retries = 0;
  const maxRetries = RETRY_CONFIG.MAX_RETRY_COUNT;
  let lastError = null;

  while (retries <= maxRetries) {
    try {
      if (retries > 0) {
        logger.info(`第 ${retries} 次重试请求: ${method.toUpperCase()} ${uriOnly}`);
        // 重试前等待一段时间
        await new Promise(resolve => setTimeout(resolve, RETRY_CONFIG.RETRY_DELAY));
      }

      let response: any;
      const useBrowserProxy = method.toLowerCase() === "post" && (
        uri === "/mweb/v1/aigc_draft/generate" || uri === "/mweb/v1/get_history_by_ids"
      );
      if (useBrowserProxy) {
        const qs = new URLSearchParams(requestParams as any).toString();
        const browserUrl = `${fullUrl}${qs ? `?${qs}` : ""}`;
        const browserData = (options as any).data || {};
        const browserBody = await browserFetchJson(browserUrl, browserData);
        response = { status: 200, statusText: "OK", data: browserBody };
      } else {
        response = await axios.request({
          method,
          url: fullUrl,
          params: requestParams,
          headers: headers,
          timeout: 45000, // 增加超时时间到45秒
          validateStatus: () => true, // 允许任何状态码
          ..._.omit(options, "params", "headers", "noDefaultParams"),
          ...(proxyAgent ? { httpAgent: proxyAgent, httpsAgent: proxyAgent, proxy: false } : {}),
        });
      }

      // 日志脱敏：仅记录状态码，不记录响应数据
      logger.debug(`响应状态: ${response.status} ${response.statusText}`);

      // 流式响应直接返回response
      if (options.responseType == "stream") return response;

      // 检查HTTP状态码
      if (response.status >= 400) {
        logger.warn(`HTTP错误: ${response.status} ${response.statusText}`);
        if (retries < maxRetries) {
          retries++;
          continue;
        }
      }

      return checkResult(response);
    }
    catch (error) {
      lastError = error;
      logger.error(`请求失败 (尝试 ${retries + 1}/${maxRetries + 1}): ${error.message}`);

      // 如果是网络错误或超时，尝试重试
      // 包含常见的网络错误：ECONNRESET（连接重置）、ENOTFOUND（DNS解析失败）、
      // ECONNREFUSED（连接被拒绝）、EAI_AGAIN（DNS临时失败）、EPIPE（管道破裂）
      const retryableErrorCodes = [
        'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND',
        'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'
      ];
      const isRetryableError = retryableErrorCodes.includes(error.code) ||
        error.message.includes('timeout') ||
        error.message.includes('network') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('socket hang up') ||
        error.message.includes('Proxy connection');

      if (isRetryableError && retries < maxRetries) {
        retries++;
        continue;
      }

      // 其他错误直接抛出
      break;
    }
  }

  // 所有重试都失败了，抛出最后一个错误
  if (lastError) {
    logger.error(`请求失败，已重试 ${retries} 次: ${lastError.message}`);
    if (lastError.response) {
      logger.error(`响应状态: ${lastError.response.status}`);
    }
    throw lastError;
  } else {
    // 这种情况理论上不应该发生，但为了安全起见
    const error = new Error(`请求失败，已重试 ${retries} 次，但没有具体错误信息`);
    logger.error(error.message);
    throw error;
  }
 }

/**
 * 检测上传图片内容合规性（仅国内站）
 * 调用 algo_proxy 接口进行图片安全检测，不通过则抛出异常
 *
 * @param imageUri 已上传图片的 URI
 * @param refreshToken 刷新令牌
 * @param regionInfo 区域信息
 */
export async function checkImageContent(
  imageUri: string,
  refreshToken: string,
  regionInfo: RegionInfo
): Promise<void> {
  // 仅国内站需要内容检测
  if (regionInfo.isInternational) return;

  const babiParam = JSON.stringify({
    scenario: "image_video_generation",
    feature_key: "aigc_to_image",
    feature_entrance: "to-generate",
    feature_entrance_detail: "to-generate-algo_proxy",
  });

  logger.info(`开始图片内容安全检测: ${imageUri}`);

  try {
    await request("post", "/mweb/v1/algo_proxy", refreshToken, {
      params: {
        babi_param: babiParam,
      },
      data: {
        scene: "image_face_ip",
        options: { ip_check: true },
        req_key: "benchmark_test_user_upload_image_input",
        file_list: [{ file_uri: imageUri }],
        req_params: {},
      },
    });
    logger.info(`图片内容安全检测通过: ${imageUri}`);
  } catch (error: any) {
    // 区分内容违规(ret=2003等) vs 网络/服务异常
    const isContentViolation = error.message && (
      error.message.includes('2003') ||
      error.message.includes('risk not pass') ||
      error.message.includes('detected risk')
    );
    if (isContentViolation) {
      logger.error(`图片内容安全检测未通过: ${imageUri}, ${error.message}`);
      throw new APIException(
        EX.API_REQUEST_FAILED,
        `图片内容检测未通过，该图片可能包含违规内容`
      );
    }
    // 网络/服务异常不阻塞，仅记录警告
    logger.warn(`图片内容安全检测服务异常(不阻塞): ${imageUri}, ${error.message}`);
  }
}

 /**
  * 预检查文件URL有效性
  *
  * @param fileUrl 文件URL
  */
 export async function checkFileUrl(fileUrl: string) {
  if (util.isBASE64Data(fileUrl)) return;
  const result = await axios.head(fileUrl, {
    timeout: 15000,
    validateStatus: () => true,
  });
  if (result.status >= 400)
    throw new APIException(
      EX.API_FILE_URL_INVALID,
      `File ${fileUrl} is not valid: [${result.status}] ${result.statusText}`
    );
  // 检查文件大小
  if (result.headers && result.headers["content-length"]) {
    const fileSize = parseInt(result.headers["content-length"], 10);
    if (fileSize > FILE_MAX_SIZE)
      throw new APIException(
        EX.API_FILE_EXECEEDS_SIZE,
        `File ${fileUrl} is not valid`
      );
  }
}

/**
 * 上传文件
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param fileUrl 文件URL或BASE64数据
 * @param isVideoImage 是否是用于视频图像
 * @returns 上传结果，包含image_uri
 */
export async function uploadFile(
  refreshToken: string,
  fileUrl: string,
  isVideoImage: boolean = false
) {
  try {
    logger.info(`开始上传文件: ${fileUrl}, 视频图像模式: ${isVideoImage}`);

    // 预检查远程文件URL可用性
    await checkFileUrl(fileUrl);

    let filename, fileData, mimeType;
    // 如果是BASE64数据则直接转换为Buffer
    if (util.isBASE64Data(fileUrl)) {
      mimeType = util.extractBASE64DataFormat(fileUrl);
      const ext = mime.getExtension(mimeType);
      filename = `${util.uuid()}.${ext}`;
      fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
      logger.info(`处理BASE64数据，文件名: ${filename}, 类型: ${mimeType}, 大小: ${fileData.length}字节`);
    }
    // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
    else {
      filename = path.basename(fileUrl);
      logger.info(`开始下载远程文件: ${fileUrl}`);
      ({ data: fileData } = await axios.get(fileUrl, {
        responseType: "arraybuffer",
        // 100M限制
        maxContentLength: FILE_MAX_SIZE,
        // 60秒超时
        timeout: 60000,
      }));
      logger.info(`文件下载完成，文件名: ${filename}, 大小: ${fileData.length}字节`);
    }

    // 获取文件的MIME类型
    mimeType = mimeType || mime.getType(filename);
    logger.info(`文件MIME类型: ${mimeType}`);

    // 构建FormData
    const formData = new FormData();
    const blob = new Blob([fileData], { type: mimeType });
    formData.append('file', blob, filename);

    // 获取上传凭证
    logger.info(`请求上传凭证，场景: ${isVideoImage ? 'video_cover' : 'aigc_image'}`);
    const uploadProofUrl = 'https://imagex.bytedanceapi.com/';
    const proofResult = await request(
      'POST',
      '/mweb/v1/get_upload_image_proof',
      refreshToken,
      {
        data: {
          scene: isVideoImage ? 'video_cover' : 'aigc_image',
          file_name: filename,
          file_size: fileData.length,
        }
      }
    );

    if (!proofResult || !proofResult.proof_info) {
      logger.error(`获取上传凭证失败: ${JSON.stringify(proofResult)}`);
      throw new APIException(EX.API_REQUEST_FAILED, '获取上传凭证失败');
    }

    logger.info(`获取上传凭证成功`);

    // 上传文件
    const { proof_info } = proofResult;
    logger.info(`开始上传文件到: ${uploadProofUrl}`);

    const uploadResult = await axios.post(
      uploadProofUrl,
      formData,
      {
        headers: {
          ...proof_info.headers,
          'Content-Type': 'multipart/form-data',
        },
        params: proof_info.query_params,
        timeout: 60000,
        validateStatus: () => true, // 允许任何状态码以便详细处理
      }
    );

    logger.info(`上传响应状态: ${uploadResult.status}`);

    if (!uploadResult || uploadResult.status !== 200) {
      logger.error(`上传文件失败: 状态码 ${uploadResult?.status}, 响应: ${JSON.stringify(uploadResult?.data)}`);
      throw new APIException(EX.API_REQUEST_FAILED, `上传文件失败: 状态码 ${uploadResult?.status}`);
    }

    // 验证 proof_info.image_uri 是否存在
    if (!proof_info.image_uri) {
      logger.error(`上传凭证中缺少 image_uri: ${JSON.stringify(proof_info)}`);
      throw new APIException(EX.API_REQUEST_FAILED, '上传凭证中缺少 image_uri');
    }

    logger.info(`文件上传成功: ${proof_info.image_uri}`);

    // 返回上传结果
    return {
      image_uri: proof_info.image_uri,
      uri: proof_info.image_uri,
    }
  } catch (error) {
    logger.error(`文件上传过程中发生错误: ${error.message}`);
    throw error;
  }
}

/**
 * 检查请求结果
 *
 * @param result 结果
 */
export function checkResult(result: AxiosResponse) {
  const { ret, errmsg, data } = result.data;
  if (!_.isFinite(Number(ret))) return result.data;
  if (ret === '0') return data;

  // 使用统一错误处理器
  JimengErrorHandler.handleApiResponse(result.data as JimengErrorResponse, {
    context: '即梦API请求',
    operation: '请求'
  });
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
export function tokenSplit(authorization: string) {
  const rawTokens = authorization.replace(/^Bearer\s+/i, "").split(",");

  return rawTokens.map((rawToken) => {
    const trimmedToken = rawToken.trim();
    if (!trimmedToken) return trimmedToken;

    // 管理后台生成的 API Key 以 jm- 开头。主生成接口需要先把 API Key
    // 转换成绑定的即梦 sessionid；否则会把 jm-xxxx 当成即梦 sessionid
    // 发给上游，导致 check login error。
    if (!trimmedToken.startsWith("jm-")) {
      return trimmedToken;
    }

    const validation = db.validateApiKey(trimmedToken);
    if (!validation.valid) {
      throw new APIException(EX.API_TOKEN_EXPIRES, "API Key 无效或已禁用");
    }

    let sessionToken: string | null = null;
    if (validation.accountId) {
      sessionToken = db.getAccountToken(validation.accountId);
    } else {
      sessionToken = db.getRandomAccountToken();
    }

    if (!sessionToken) {
      throw new APIException(EX.API_TOKEN_EXPIRES, "API Key 未绑定可用的即梦账号");
    }

    if (validation.keyId) {
      try {
        db.incrementApiKeyUsage(validation.keyId);
      } catch (e) {
        logger.warn("更新 API Key 调用次数失败:", e.message);
      }
    }

    return sessionToken;
  });
}

/**
 * 获取Token存活状态
 */
export async function getTokenLiveStatus(refreshToken: string) {
  try {
    const result = await request(
      "POST",
      "/passport/account/info/v2",
      refreshToken,
      {
        params: {
          account_sdk_source: "web",
        },
      }
    );
    // request 内部已调用 checkResult，直接使用返回值
    return !!result?.user_id;
  } catch (err) {
    return false;
  }
}
