import Koa from 'koa';
import KoaRouter from 'koa-router';
import koaRange from 'koa-range';
import koaCors from "koa2-cors";
import koaBody from 'koa-body';
import _ from 'lodash';

import Exception from './exceptions/Exception.ts';
import Request from './request/Request.ts';
import Response from './response/Response.js';
import FailureBody from './response/FailureBody.ts';
import EX from './consts/exceptions.ts';
import logger from './logger.ts';
import config from './config.ts';
import db from './database.ts';
import {
    DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL,
    IMAGE_MODEL_MAP, IMAGE_MODEL_MAP_US, IMAGE_MODEL_MAP_ASIA,
    VIDEO_MODEL_MAP, VIDEO_MODEL_MAP_US, VIDEO_MODEL_MAP_ASIA,
    RESOLUTION_OPTIONS,
} from '@/api/consts/common.ts';

const knownModels = new Set([
    ...Object.keys(IMAGE_MODEL_MAP), ...Object.keys(IMAGE_MODEL_MAP_US), ...Object.keys(IMAGE_MODEL_MAP_ASIA),
    ...Object.keys(VIDEO_MODEL_MAP), ...Object.keys(VIDEO_MODEL_MAP_US), ...Object.keys(VIDEO_MODEL_MAP_ASIA),
]);
const knownResolutions = new Set(['1k', '2k', '4k', '480p', '720p', '1080p']);
const knownRatios = new Set(Object.keys(RESOLUTION_OPTIONS['1k']));

// 仅提取经过白名单验证的标量和计数，绝不持久化原始 body、URL、headers 或响应内容。
function getRequestLogDetails(ctx: any, route: string, code: number | null) {
    const isImage = route === '/v1/images/generations' || route === '/v1/images/compositions';
    const isVideo = route === '/v1/videos/generations';
    const isChat = route === '/v1/chat/completions';
    if (!isImage && !isVideo && !isChat) return null;

    const body = ctx.request.body || {};
    const rawModel = body.model;
    const defaultModel = isVideo ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL;
    const model = rawModel === undefined ? defaultModel : typeof rawModel === 'string' ? rawModel : null;
    const modelParts = model?.split(':') || [];
    const safeModel = modelParts.length <= 2 && knownModels.has(modelParts[0]) &&
        (modelParts.length === 1 || /^\d{2,5}x\d{2,5}$/.test(modelParts[1])) ? model : null;
    let category: 'image' | 'video' | 'unknown' = isVideo ? 'video' : 'image';
    if (isChat) category = !safeModel ? 'unknown' : safeModel.startsWith('jimeng-video') ? 'video' : 'image';
    const details: Record<string, string | number | boolean | null> = {
        category,
        actualCredits: null,
        result: code !== null || ctx.status >= 400 ? 'failed'
            : isChat && body.stream ? 'stream_started' : isChat ? 'response_sent' : 'completed',
    };
    if (safeModel) details.model = safeModel;
    if (code !== null) details.errorCode = code;
    const resolution = body.resolution === undefined ? (category === 'video' ? '720p' : '2k') : body.resolution;
    if (knownResolutions.has(resolution)) details.requestedResolution = resolution;
    const ratio = body.ratio === undefined ? '1:1' : body.ratio;
    if (knownRatios.has(ratio)) details.requestedRatio = ratio;
    if (category === 'video') {
        const duration = body.duration === undefined ? 5 : Number(body.duration);
        if (Number.isInteger(duration) && duration >= 1 && duration <= 15) details.requestedDurationSeconds = duration;
    }
    if (isVideo && ['first_last_frames', 'omni_reference'].includes(body.functionMode || 'first_last_frames')) {
        details.functionMode = body.functionMode || 'first_last_frames';
        const fieldNames = new Set([...Object.keys(body), ...Object.keys(ctx.request.files || {})]);
        const paths = Array.isArray(body.filePaths) && body.filePaths.length > 0 ? body.filePaths
            : Array.isArray(body.file_paths) ? body.file_paths : [];
        details.inputImageCount = [...fieldNames].filter(name => /^image_file(_\d+)?$/.test(name)).length + paths.length;
        details.inputVideoCount = [...fieldNames].filter(name => /^video_file(_\d+)?$/.test(name)).length;
    }
    if (isChat) {
        if (Array.isArray(body.messages)) details.messageCount = body.messages.length;
        details.stream = Boolean(body.stream);
    } else {
        if (typeof body.prompt === 'string') details.promptLength = body.prompt.length;
        const responseFormat = body.response_format || 'url';
        if (responseFormat === 'url' || responseFormat === 'b64_json') details.responseFormat = responseFormat;
        if (route === '/v1/images/compositions') {
            const input = ctx.request.files?.images;
            details.inputImageCount = Array.isArray(body.images) ? body.images.length
                : Array.isArray(input) ? input.length : input ? 1 : 0;
        }
    }

    const reported = ctx.state.requestLogDetails || {};
    if (Number.isInteger(reported.accountId) && reported.accountId > 0) details.accountId = reported.accountId;
    if (Array.isArray(ctx.body?.data)) details.outputCount = ctx.body.data.length;
    // 规则预估并非上游实际扣费；校验失败的请求同样只表示“如果执行”的预计消耗。
    if (Number.isFinite(reported.estimatedCredits)) {
        details.estimatedCredits = reported.estimatedCredits;
    } else if (safeModel) {
        details.estimatedCredits = db.queryCostRule(category, {
            model: safeModel,
            resolution: details.requestedResolution as string,
            duration: details.requestedDurationSeconds as number,
        });
    }
    return details;
}

class Server {

    app;
    router;

    constructor() {
        this.app = new Koa();
        this.app.use(koaCors());
        // 范围请求支持
        this.app.use(koaRange);
        this.router = new KoaRouter({ prefix: config.service.urlPrefix });
        // 只记录 API 调用摘要；不将请求体、鉴权头或查询参数写入管理后台日志。
        this.app.use(async (ctx: any, next: Function) => {
            const startedAt = Date.now();
            await next();
            const prefix = config.service.urlPrefix || '';
            if (!config.system.requestLog ||
                (!ctx.path.startsWith(`${prefix}/v1/`) && !ctx.path.startsWith(`${prefix}/token/`))) return;

            // 部分业务错误以 HTTP 200 返回，需同时检查响应中的错误码。
            const code = typeof ctx.body?.code === 'number' && ctx.body.code < 0 ? ctx.body.code : null;
            const level = ctx.status >= 500 || code === EX.SYSTEM_ERROR[0] ? 'ERROR'
                : ctx.status >= 400 || code !== null ? 'WARN' : 'INFO';
            // 对不存在的路由也只记录通用标识，避免把误放在 URL 路径中的密钥写入数据库。
            const route = ctx._matchedRoute || (ctx.path.startsWith(`${prefix}/v1/`) ? `${prefix}/v1/[unmatched]` : `${prefix}/token/[unmatched]`);
            const message = `${ctx.method} ${route} ${ctx.status}${code === null ? '' : ` (code ${code})`} ${Date.now() - startedAt}ms`;
            let details;
            try {
                const relativeRoute = route.startsWith(prefix) ? route.slice(prefix.length) : route;
                details = getRequestLogDetails(ctx, relativeRoute, code) || undefined;
            } catch (err) {
                logger.warn('Failed to collect request log details:', err);
            }
            try {
                db.addLog(level, message, details);
            } catch (err) {
                logger.error('Failed to save request log:', err);
            }
        });
        // 前置处理异常拦截
        this.app.use(async (ctx: any, next: Function) => {
            if(ctx.request.type === "application/xml" || ctx.request.type === "application/ssml+xml")
                ctx.req.headers["content-type"] = "text/xml";
            try { await next() }
            catch (err) {
                logger.error(err);
                const failureBody = new FailureBody(err);
                new Response(failureBody).injectTo(ctx);
            }
        });
        // 自定义 JSON 解析中间件
        this.app.use(async (ctx: any, next: Function) => {
            if (ctx.is('application/json') && ['POST', 'PUT', 'PATCH'].includes(ctx.method)) {
                logger.debug('开始自定义 JSON 解析');
                const chunks: Buffer[] = [];

                await new Promise((resolve, reject) => {
                    ctx.req.on('data', (chunk: Buffer) => {
                        chunks.push(chunk);
                    });

                    ctx.req.on('end', () => {
                        resolve(null);
                    });

                    ctx.req.on('error', reject);
                });

                const body = Buffer.concat(chunks).toString('utf8');

                // 清理问题字符
                let cleanedBody = body
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n')
                    .replace(/\u00A0/g, ' ')
                    .replace(/[\u2000-\u200B]/g, ' ')
                    .replace(/\uFEFF/g, '')
                    .trim();

                // 预先处理尾随逗号问题
                cleanedBody = cleanedBody.replace(/,(\s*[\r\n]*\s*[}\]])/g, '$1');

                // 安全的JSON解析
                let parsedBody;
                try {
                    parsedBody = JSON.parse(cleanedBody);
                } catch (parseError) {
                    logger.error(`JSON解析失败: ${parseError.message}`);
                    logger.debug(`原始请求体: ${body.substring(0, 200)}...`);
                    logger.debug(`清理后请求体: ${cleanedBody.substring(0, 200)}...`);

                    // 尝试修复常见的JSON格式问题
                    let fixedBody = cleanedBody;
                    try {
                        // 修复单引号问题
                        fixedBody = fixedBody.replace(/'/g, '"');
                        // 修复属性名没有引号的问题
                        fixedBody = fixedBody.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
                        // 修复尾随逗号问题 - 更强的正则表达式
                        fixedBody = fixedBody.replace(/,(\s*[\r\n]*\s*[}\]])/g, '$1');
                        // 修复多个连续逗号
                        fixedBody = fixedBody.replace(/,+/g, ',');

                        parsedBody = JSON.parse(fixedBody);
                        logger.debug('JSON修复成功');
                    } catch (fixError) {
                        logger.error(`JSON修复也失败: ${fixError.message}`);
                        logger.debug(`修复后的JSON: ${fixedBody.substring(0, 200)}...`);
                        throw new Error(`无效的JSON格式: ${parseError.message}`);
                    }
                }

                logger.debug('JSON 解析成功，跳过 koa-body');

                ctx.request.body = parsedBody;
                ctx.request.rawBody = cleanedBody;

                // 标记已处理，避免 koa-body 再次处理
                ctx._jsonProcessed = true;
            }
            await next();
        });

        // 载荷解析器支持（只处理未被自定义解析器处理的请求）
        this.app.use(async (ctx: any, next: Function) => {
            if (!ctx._jsonProcessed) {
                await koaBody(Object.assign(_.clone(config.system.requestBody), {
                    multipart: true, // 开启multipart文件上传
                    formidable: {
                        maxFileSize: 100 * 1024 * 1024, // 限制最大100MB
                    },
                    enableTypes: ['json', 'form', 'text', 'xml'] // 确保form类型被启用
                }))(ctx, next);
            } else {
                await next();
            }
        });
        this.app.on("error", (err: any) => {
            // 忽略连接重试、中断、管道、取消错误
            if (["ECONNRESET", "ECONNABORTED", "EPIPE", "ECANCELED"].includes(err.code)) return;
            logger.error(err);
        });
        logger.success("Server initialized");
    }

    /**
     * 附加路由
     *
     * @param routes 路由列表
     */
    attachRoutes(routes: any[]) {
        routes.forEach((route: any) => {
            const prefix = route.prefix || "";
            for (let method in route) {
                if(method === "prefix") continue;
                if (!_.isObject(route[method])) {
                    logger.warn(`Router ${prefix} ${method} invalid`);
                    continue;
                }
                for (let uri in route[method]) {
                    this.router[method](`${prefix}${uri}`, async ctx => {
                        const { request, response } = await this.#requestProcessing(ctx, route[method][uri]);
                        if(response != null && config.system.requestLog) {
                            if (ctx.request.url.endsWith('/ping')) {
                                logger.debug(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
                            } else {
                                logger.info(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
                            }
                        }
                    });
                }
            }
            logger.info(`Route ${config.service.urlPrefix || ""}${prefix} attached`);
        });
        this.app.use(this.router.routes());
        this.app.use((ctx: any) => {
            const request = new Request(ctx);
            logger.debug(`-> ${ctx.request.method} ${ctx.request.url} request is not supported - ${request.remoteIP || "unknown"}`);
            // const failureBody = new FailureBody(new Exception(EX.SYSTEM_NOT_ROUTE_MATCHING, "Request is not supported"));
            // const response = new Response(failureBody);
            const message = `[请求有误]: 请检查API文档确认正确的请求路径，当前请求为 ${ctx.request.method} -> ${ctx.request.url} 请纠正`;
            logger.warn(message);
            const failureBody = new FailureBody(new Error(message));
            const response = new Response(failureBody);
            response.injectTo(ctx);
            if(config.system.requestLog)
                logger.info(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
        });
    }

    /**
     * 请求处理
     *
     * @param ctx 上下文
     * @param routeFn 路由方法
     */
    #requestProcessing(ctx: any, routeFn: Function): Promise<any> {
        return new Promise(resolve => {
            const request = new Request(ctx);
            try {
                if(config.system.requestLog) {
                    if (request.url === '/ping') {
                        logger.debug(`-> ${request.method} ${request.url}`);
                    } else {
                        logger.info(`-> ${request.method} ${request.url}`);
                    }
                }
                    routeFn(request)
                .then(response => {
                    try {
                        if(!Response.isInstance(response)) {
                            const _response = new Response(response);
                            _response.injectTo(ctx);
                            return resolve({ request, response: _response });
                        }
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                    catch(err) {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                })
                .catch(err => {
                    try {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                    catch(err) {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                });
            }
            catch(err) {
                logger.error(err);
                const failureBody = new FailureBody(err);
                const response = new Response(failureBody);
                response.injectTo(ctx);
                resolve({ request, response });
            }
        });
    }

    /**
     * 监听端口
     */
    async listen() {
        const host = config.service.host;
        const port = config.service.port;
        await Promise.all([
            new Promise((resolve, reject) => {
                if(host === "0.0.0.0" || host === "localhost" || host === "127.0.0.1")
                    return resolve(null);
                this.app.listen(port, "localhost", err => {
                    if(err) return reject(err);
                    resolve(null);
                });
            }),
            new Promise((resolve, reject) => {
                this.app.listen(port, host, err => {
                    if(err) return reject(err);
                    resolve(null);
                });
            })
        ]);
        logger.success(`Server listening on port ${port} (${host})`);
    }

}

export default new Server();
