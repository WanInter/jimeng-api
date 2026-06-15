import _ from "lodash";
import { PassThrough } from "stream";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import db from "@/lib/database.ts";
import { generateImagesWithRetry, DEFAULT_MODEL } from "./images.ts";
import { generateVideo, DEFAULT_MODEL as DEFAULT_VIDEO_MODEL } from "./videos.ts";
import { getCredit } from "./core.ts";

// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;

/**
 * 解析模型
 *
 * @param model 模型名称
 * @returns 模型信息
 */
function parseModel(model: string) {
  const [_model, size] = model.split(":");
  const [_, width, height] = /(\d+)[\W\w](\d+)/.exec(size) ?? [];
  return {
    model: _model,
    width: size ? Math.ceil(parseInt(width) / 2) * 2 : 1024,
    height: size ? Math.ceil(parseInt(height) / 2) * 2 : 1024,
  };
}

/**
 * 检测是否为视频生成请求
 *
 * @param model 模型名称
 * @returns 是否为视频生成请求
 */
function isVideoModel(model: string) {
  return model.startsWith("jimeng-video");
}

/**
 * 从消息中提取图片URL列表
 * 支持 OpenAI 格式的多模态消息
 *
 * @param messages 消息数组
 * @returns 图片URL或Base64数据数组
 */
function extractImagesFromMessages(messages: any[]): string[] {
  const images: string[] = [];

  for (const message of messages) {
    if (!message.content) continue;

    // 如果 content 是数组（OpenAI 多模态格式）
    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item.type === 'image_url' && item.image_url) {
          const url = item.image_url.url || item.image_url;
          if (url && typeof url === 'string') {
            images.push(url);
          }
        } else if (item.type === 'image' && item.url) {
          images.push(item.url);
        }
      }
    }
  }

  logger.info(`从消息中提取到 ${images.length} 张图片`);
  return images;
}

/**
 * 从消息中提取文本提示词
 *
 * @param message 消息对象
 * @returns 提示词文本
 */
function extractTextFromMessage(message: any): string {
  if (!message.content) return "";

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n');
  }

  return "";
}

/**
 * 同步对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param _model 模型名称
 * @param retryCount 重试次数
 */
export async function createCompletion(
  messages: any[],
  refreshToken: string,
  _model = DEFAULT_MODEL,
  retryCount = 0
) {
  return (async () => {
    if (messages.length === 0)
      throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "消息不能为空");

    const { model, width, height } = parseModel(_model);
    logger.info(`收到 ${messages.length} 条消息`);

    const imageUrls = extractImagesFromMessages(messages);
    const lastMessage = messages[messages.length - 1];
    const promptText = extractTextFromMessage(lastMessage);

    if (isVideoModel(_model)) {
      try {
        logger.info(`开始生成视频，模型: ${_model}，图片数量: ${imageUrls.length}`);

        let creditsBefore = 0;
        try {
          const beforeCredit = await getCredit(refreshToken);
          creditsBefore = beforeCredit.totalCredit;
        } catch (e) { /* 忽略积分查询错误 */ }

        const videoUrl = await generateVideo(
          _model,
          promptText || lastMessage.content,
          {
            width,
            height,
            resolution: "720p",
            filePaths: imageUrls,
          },
          refreshToken
        );

        logger.info(`视频生成成功，URL: ${videoUrl}`);

        let creditsUsed = 0;
        let remainingCredits = 0;
        try {
          const afterCredit = await getCredit(refreshToken);
          remainingCredits = afterCredit.totalCredit;
          creditsUsed = Math.max(0, creditsBefore - remainingCredits);
        } catch (e) { /* 忽略积分查询错误 */ }

        try {
          db.recordCall(refreshToken, _model, creditsUsed, remainingCredits);
          if (videoUrl) db.saveMedia('video', videoUrl, _model, promptText || lastMessage.content, refreshToken);
        } catch (e) { /* 忽略数据库错误 */ }

        return {
          id: util.uuid(),
          model: _model,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `![video](${videoUrl})\n`,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: util.unixTimestamp(),
        };
      } catch (error) {
        logger.error(`视频生成失败: ${error.message}`);
        if (error instanceof APIException) throw error;

        return {
          id: util.uuid(),
          model: _model,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `生成视频失败: ${error.message}\n\n请前往即梦官网查看您的视频。`,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: util.unixTimestamp(),
        };
      }
    } else {
      let creditsBefore = 0;
      try {
        const beforeCredit = await getCredit(refreshToken);
        creditsBefore = beforeCredit.totalCredit;
      } catch (e) { /* 忽略积分查询错误 */ }

      const generatedImageUrls = await generateImagesWithRetry(
        model,
        promptText || lastMessage.content,
        {
          ratio: "1:1",
          resolution: "2k",
        },
        refreshToken
      );

      let creditsUsed = 0;
      let remainingCredits = 0;
      try {
        const afterCredit = await getCredit(refreshToken);
        remainingCredits = afterCredit.totalCredit;
        creditsUsed = Math.max(0, creditsBefore - remainingCredits);
      } catch (e) { /* 忽略积分查询错误 */ }

      try {
        db.recordCall(refreshToken, _model || model, creditsUsed, remainingCredits);
        generatedImageUrls.forEach(url => {
          if (url) db.saveMedia('image', url, _model || model, promptText || lastMessage.content, refreshToken);
        });
      } catch (e) { /* 忽略数据库错误 */ }

      return {
        id: util.uuid(),
        model: _model || model,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: generatedImageUrls.reduce(
                (acc, url, i) => acc + `![image_${i}](${url})\n`,
                ""
              ),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: util.unixTimestamp(),
      };
    }
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(messages, refreshToken, _model, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param messages 参考gpt系列消息格式
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param _model 模型名称
 * @param retryCount 重试次数
 */
export async function createCompletionStream(
  messages: any[],
  refreshToken: string,
  _model = DEFAULT_MODEL,
  retryCount = 0
) {
  return (async () => {
    const { model, width, height } = parseModel(_model);
    logger.info(`收到 ${messages.length} 条消息`);

    const imageUrls = extractImagesFromMessages(messages);
    const lastMessage = messages[messages.length - 1];
    const promptText = extractTextFromMessage(lastMessage);

    const stream = new PassThrough();

    if (messages.length === 0) {
      logger.warn("消息为空，返回空流");
      stream.end("data: [DONE]\n\n");
      return stream;
    }

    if (isVideoModel(_model)) {
      stream.write(
        "data: " +
        JSON.stringify({
          id: util.uuid(),
          model: _model,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: "🎬 视频生成中，请稍候...\n这可能需要1-2分钟，请耐心等待" }, finish_reason: null }],
        }) +
        "\n\n"
      );

      logger.info(`开始生成视频，提示词: ${promptText.substring(0, 50)}...`);

      generateVideo(
        _model,
        promptText || lastMessage.content,
        { width, height, resolution: "720p", filePaths: imageUrls },
        refreshToken
      )
        .then((videoUrl) => {
          logger.info(`视频生成成功，URL: ${videoUrl}`);

          try {
            db.recordCall(refreshToken, _model, 0);
            if (videoUrl) db.saveMedia('video', videoUrl, _model, promptText || lastMessage.content, refreshToken);
          } catch (e) { /* 忽略数据库错误 */ }

          stream.write(
            "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model,
              object: "chat.completion.chunk",
              choices: [{ index: 1, delta: { role: "assistant", content: `\n\n✅ 视频生成完成！\n\n![video](${videoUrl})\n\n下载链接: ${videoUrl}` }, finish_reason: null }],
            }) +
            "\n\n"
          );

          stream.write(
            "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model,
              object: "chat.completion.chunk",
              choices: [{ index: 2, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
            }) +
            "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        })
        .catch((err) => {
          logger.error(`视频生成失败: ${err.message}`);
          stream.write(
            "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model,
              object: "chat.completion.chunk",
              choices: [{ index: 1, delta: { role: "assistant", content: `\n\n⚠️ 视频生成失败: ${err.message}\n\n请前往即梦官网查看您的视频: https://jimeng.jianying.com/ai-tool/video/generate` }, finish_reason: "stop" }],
            }) +
            "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        });
    } else {
      stream.write(
        "data: " +
        JSON.stringify({
          id: util.uuid(),
          model: _model || model,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: "🎨 图像生成中，请稍候..." }, finish_reason: null }],
        }) +
        "\n\n"
      );

      generateImagesWithRetry(
        model,
        promptText || lastMessage.content,
        { ratio: "1:1", resolution: "2k" },
        refreshToken
      )
        .then((generatedUrls) => {
          try {
            db.recordCall(refreshToken, _model || model, 0);
            generatedUrls.forEach(url => {
              if (url) db.saveMedia('image', url, _model || model, promptText || lastMessage.content, refreshToken);
            });
          } catch (e) { /* 忽略数据库错误 */ }

          for (let i = 0; i < generatedUrls.length; i++) {
            const url = generatedUrls[i];
            stream.write(
              "data: " +
              JSON.stringify({
                id: util.uuid(),
                model: _model || model,
                object: "chat.completion.chunk",
                choices: [{ index: i + 1, delta: { role: "assistant", content: `![image_${i}](${url})\n` }, finish_reason: i < generatedUrls.length - 1 ? null : "stop" }],
              }) +
              "\n\n"
            );
          }
          stream.write(
            "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model || model,
              object: "chat.completion.chunk",
              choices: [{ index: generatedUrls.length + 1, delta: { role: "assistant", content: "图像生成完成！" }, finish_reason: "stop" }],
            }) +
            "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        })
        .catch((err) => {
          stream.write(
            "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model || model,
              object: "chat.completion.chunk",
              choices: [{ index: 1, delta: { role: "assistant", content: `生成图片失败: ${err.message}` }, finish_reason: "stop" }],
            }) +
            "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        });
    }
    return stream;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(messages, refreshToken, _model, retryCount + 1);
      })();
    }
    throw err;
  });
}
