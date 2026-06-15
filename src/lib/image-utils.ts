import { request } from "@/api/controllers/core.ts";
import logger from "@/lib/logger.ts";

/**
 * 图片URL提取工具
 * 统一从不同格式的响应中提取图片URL
 */

/**
 * 从API响应项中提取图片URL
 * @param item API响应中的单个项目
 * @param index 项目索引（用于日志）
 * @returns 图片URL或null
 */
export function extractImageUrl(item: any, index?: number): string | null {
  const logPrefix = index !== undefined ? `图片 ${index + 1}` : '图片';

  // 只提取 large_images
  if (item?.image?.large_images?.[0]?.image_url) {
    let imageUrl = item.image.large_images[0].image_url;
    // 将URL中的 \u0026 转换为 &
    imageUrl = imageUrl.replace(/\\u0026/g, '&');
    logger.debug(`${logPrefix}: 使用 large_images URL`);
    return imageUrl;
  }

  // 无法提取URL，记录警告
  logger.warn(`${logPrefix}: 无法提取URL，缺少 image.large_images[0].image_url 字段。item结构: ${JSON.stringify(item, null, 2)}`);
  return null;
}

/**
 * 从项目列表中批量提取图片URLs
 * @param itemList 项目列表
 * @returns 图片URL数组
 */
export function extractImageUrls(itemList: any[]): string[] {
  return itemList
    .map((item, index) => extractImageUrl(item, index))
    .filter((url): url is string => url !== null);
}

/**
 * 从视频响应项中提取视频URL
 * @param item 视频响应项
 * @returns 视频URL或null
 */
export function extractVideoUrl(item: any): string | null {
  // 优先尝试 common_attr.transcoded_video (亚太站结构)
  if (item?.common_attr?.transcoded_video?.origin?.video_url) {
    return item.common_attr.transcoded_video.origin.video_url;
  }
  // 尝试 video.transcoded_video (国内站结构)
  if (item?.video?.transcoded_video?.origin?.video_url) {
    return item.video.transcoded_video.origin.video_url;
  }
  // 尝试 play_url
  if (item?.video?.play_url) {
    return item.video.play_url;
  }
  // 尝试 download_url
  if (item?.video?.download_url) {
    return item.video.download_url;
  }
  // 尝试 url
  if (item?.video?.url) {
    return item.video.url;
  }

  return null;
}

/**
 * 通过 get_local_item_list API 获取高质量视频下载URL
 * 浏览器下载视频时使用此API获取高码率版本（~6297 vs 预览版 ~1152）
 *
 * @param itemId 视频项目ID
 * @param refreshToken 刷新令牌
 * @returns 高质量视频URL，失败时返回 null
 */
export async function fetchHighQualityVideoUrl(itemId: string, refreshToken: string): Promise<string | null> {
  try {
    logger.info(`尝试获取高质量视频下载URL，item_id: ${itemId}`);

    const result = await request("post", "/mweb/v1/get_local_item_list", refreshToken, {
      data: {
        item_id_list: [itemId],
        pack_item_opt: {
          scene: 1,
          need_data_integrity: true,
        },
        is_for_video_download: true,
      },
    });

    const responseStr = JSON.stringify(result);
    logger.info(`get_local_item_list 响应大小: ${responseStr.length} 字符`);

    // 策略0（最优先）: 从 video_model 字段提取无水印视频URL
    // video_model 是 JSON 字符串，其中 video_list.*.main_url 为 Base64 编码的无水印链接
    const itemList = result.item_list || result.local_item_list || [];
    if (itemList.length > 0) {
      const item = itemList[0];
      const videoModelStr = item?.video?.video_model;
      if (videoModelStr && typeof videoModelStr === "string") {
        try {
          const videoModel = JSON.parse(videoModelStr);
          const videoList = videoModel?.video_list;
          if (videoList && typeof videoList === "object") {
            // 按清晰度优先级尝试提取：
            // 4K(video_4) > 2K(video_3) > 1080p(video_2) > 720p(video_1)
            // 目前只抓包到video_1
            const priorityKeys = ["video_4", "video_3", "video_2", "video_1"];
            for (const key of priorityKeys) {
              const mainUrlB64 = videoList[key]?.main_url;
              if (mainUrlB64 && typeof mainUrlB64 === "string") {
                // Base64 解码得到真实无水印URL（Node.js 16+ 全局支持 atob）
                const decodedUrl = atob(mainUrlB64);
                if (decodedUrl.startsWith("http")) {
                  const definition = videoList[key]?.definition || key;
                  logger.info(`从video_model提取到无水印视频URL (${definition}): ${decodedUrl}`);
                  return decodedUrl;
                }
              }
            }
          }
        } catch (e) {
          logger.warn(`解析video_model JSON失败: ${e.message}`);
        }
      }
    }

    // 策略1: 从结构化字段中提取视频URL（可能带水印，作为降级方案）
    if (itemList.length > 0) {
      const item = itemList[0];
      const videoUrl =
        item?.common_attr?.transcoded_video?.origin?.video_url ||
        item?.video?.transcoded_video?.origin?.video_url ||
        item?.video?.download_url ||
        item?.video?.play_url ||
        item?.video?.url;

      if (videoUrl) {
        logger.info(`从get_local_item_list结构化字段获取到高清视频URL(可能含水印): ${videoUrl}`);
        return videoUrl;
      }
    }

    // 策略2: 正则匹配 dreamnia.jimeng.com 高质量URL
    const hqUrlMatch = responseStr.match(/https:\/\/v[0-9]+-dreamnia\.jimeng\.com\/[^"\s\\]+/);
    if (hqUrlMatch && hqUrlMatch[0]) {
      logger.info(`正则提取到高质量视频URL (dreamnia): ${hqUrlMatch[0]}`);
      return hqUrlMatch[0];
    }

    // 策略3: 匹配任何 jimeng.com 域名的视频URL
    const jimengUrlMatch = responseStr.match(/https:\/\/v[0-9]+-[^"\\]*\.jimeng\.com\/[^"\s\\]+/);
    if (jimengUrlMatch && jimengUrlMatch[0]) {
      logger.info(`正则提取到jimeng视频URL: ${jimengUrlMatch[0]}`);
      return jimengUrlMatch[0];
    }

    // 策略4: 匹配任何视频URL（兜底）
    const anyVideoUrlMatch = responseStr.match(/https:\/\/v[0-9]+-[^"\\]*\.(vlabvod|jimeng)\.com\/[^"\s\\]+/);
    if (anyVideoUrlMatch && anyVideoUrlMatch[0]) {
      logger.info(`从get_local_item_list提取到视频URL: ${anyVideoUrlMatch[0]}`);
      return anyVideoUrlMatch[0];
    }

    logger.warn(`未能从get_local_item_list响应中提取到视频URL`);
    return null;
  } catch (error) {
    logger.warn(`获取高质量视频下载URL失败: ${error.message}`);
    return null;
  }
}
