import _ from 'lodash';
import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import Exception from '@/lib/exceptions/Exception.ts';
import EX from '@/lib/consts/exceptions.ts';
import HTTP_STATUS_CODES from '@/lib/http-status-codes.ts';
import db from '@/lib/database.ts';
import { getCredit, request as jimengRequest } from '@/api/controllers/core.ts';
import { triggerHealthCheck, triggerCreditsSync } from '@/lib/account-keeper.ts';

// 验证登录状态的辅助函数
function getSessionUserId(request: Request): number | null {
  const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
  if (!sessionId) return null;
  return db.validateSession(sessionId);
}

function requireAuth(request: Request): number {
  const userId = getSessionUserId(request);
  if (!userId) {
    throw new Exception(EX.SYSTEM_UNAUTHORIZED).setHTTPStatusCode(HTTP_STATUS_CODES.UNAUTHORIZED);
  }
  return userId;
}

export default {
  prefix: '/dashboard',

  get: {
    // 检查是否需要初始化设置
    '/status': async (request: Request) => {
      return {
        setupComplete: db.isSetupComplete()
      };
    },

    // 获取统计数据
    '/stats': async (request: Request) => {
      requireAuth(request);
      return db.getStats();
    },

    // 获取日志
    '/logs': async (request: Request) => {
      requireAuth(request);
      const level = request.query.level as string;
      const limit = parseInt(request.query.limit as string) || 100;
      return db.getLogs(level, limit);
    },

    // 获取媒体列表（分页）
    '/media': async (request: Request) => {
      requireAuth(request);
      const page = parseInt(request.query.page as string) || 1;
      const limit = parseInt(request.query.limit as string) || 20;
      const type = request.query.type as string;
      return db.getMedia(page, limit, type);
    },

    // 获取指定Key的积分
    '/credits': async (request: Request) => {
      requireAuth(request);
      const key = request.query.key as string;
      if (!key) {
        return { error: '缺少Key参数' };
      }
      try {
        const credits = await getCredit(key);
        return credits;
      } catch (e) {
        return { error: '查询失败', message: e.message };
      }
    },

    // 获取即梦账号列表
    '/accounts': async (request: Request) => {
      requireAuth(request);
      return db.getAccounts();
    },

    // 获取API Key列表
    '/api-keys': async (request: Request) => {
      requireAuth(request);
      return db.getApiKeys();
    },

    // 获取积分消耗规则列表
    '/cost-rules': async (request: Request) => {
      requireAuth(request);
      return db.getCostRules();
    }
  },

  post: {
    // 初始化设置账号密码
    '/setup': async (request: Request) => {
      if (db.isSetupComplete()) {
        return new Response({ error: '已完成初始化设置' }, { statusCode: 400 });
      }
      const { username, password } = request.body;
      if (!username || !password) {
        return new Response({ error: '用户名和密码不能为空' }, { statusCode: 400 });
      }
      if (password.length < 6) {
        return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      }
      db.createUser(username, password);
      return { success: true, message: '设置成功' };
    },

    // 登录
    '/login': async (request: Request) => {
      const { username, password } = request.body;
      const userId = db.validateUser(username, password);
      if (!userId) {
        return new Response({ error: '用户名或密码错误' }, { statusCode: 401 });
      }
      const sessionId = db.createSession(userId);
      return new Response(
        { success: true },
        {
          statusCode: 200,
          headers: { 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400` }
        }
      );
    },

    // 登出
    '/logout': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (sessionId) {
        db.deleteSession(sessionId);
      }
      return new Response(
        { success: true },
        {
          statusCode: 200,
          headers: { 'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0' }
        }
      );
    },

    // 修改密码
    '/password': async (request: Request) => {
      const userId = requireAuth(request);
      const { newPassword } = request.body;
      if (!newPassword || newPassword.length < 6) {
        return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      }
      db.changePassword(userId, newPassword);
      return { success: true, message: '密码修改成功' };
    },

    // 添加即梦账号
    '/accounts': async (request: Request) => {
      requireAuth(request);
      const { name, token, region, proxy_url } = request.body;
      if (!name || !token) {
        return new Response({ error: '名称和Token不能为空' }, { statusCode: 400 });
      }
      try {
        const id = db.addAccount(name, token, region || 'cn', proxy_url || '');
        return { success: true, id, message: '账号添加成功' };
      } catch (e) {
        return new Response({ error: '添加失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 更新账号代理
    '/accounts/proxy': async (request: Request) => {
      requireAuth(request);
      const { id, proxy_url } = request.body;
      if (!id) {
        return new Response({ error: '缺少账号ID' }, { statusCode: 400 });
      }
      try {
        db.updateAccountProxy(id, proxy_url || '');
        return { success: true, message: '代理设置已更新' };
      } catch (e) {
        return new Response({ error: '更新失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 获取积分消耗规则
    '/cost-rules': async (request: Request) => {
      requireAuth(request);
      return db.getCostRules();
    },

    // 添加积分消耗规则
    '/cost-rules/add': async (request: Request) => {
      requireAuth(request);
      const { task_type, model_pattern, region, resolution, duration_min, duration_max, credits_cost, priority, description } = request.body;
      if (!task_type || !credits_cost) {
        return new Response({ error: 'task_type 和 credits_cost 不能为空' }, { statusCode: 400 });
      }
      try {
        const id = db.addCostRule({ task_type, model_pattern, region, resolution, duration_min, duration_max, credits_cost, priority, description });
        return { success: true, id, message: '规则添加成功' };
      } catch (e) {
        return new Response({ error: '添加失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 更新积分消耗规则
    '/cost-rules/update': async (request: Request) => {
      requireAuth(request);
      const { id, ...fields } = request.body;
      if (!id) {
        return new Response({ error: '缺少规则ID' }, { statusCode: 400 });
      }
      try {
        db.updateCostRule(id, fields);
        return { success: true, message: '规则已更新' };
      } catch (e) {
        return new Response({ error: '更新失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 删除积分消耗规则
    '/cost-rules/delete': async (request: Request) => {
      requireAuth(request);
      const { id } = request.body;
      if (!id) {
        return new Response({ error: '缺少规则ID' }, { statusCode: 400 });
      }
      try {
        db.deleteCostRule(id);
        return { success: true, message: '规则已删除' };
      } catch (e) {
        return new Response({ error: '删除失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 检查即梦账号积分
    '/accounts/check': async (request: Request) => {
      requireAuth(request);
      const { id } = request.body;
      if (!id) {
        return new Response({ error: '缺少账号ID' }, { statusCode: 400 });
      }
      const token = db.getAccountToken(id);
      if (!token) {
        return new Response({ error: '账号不存在' }, { statusCode: 404 });
      }
      try {
        const credits = await getCredit(token);
        db.updateAccountCredits(id, credits.totalCredit, credits.totalCredit);
        db.updateAccountStatus(id, 'active');
        return { success: true, credits };
      } catch (e) {
        db.updateAccountStatus(id, 'error');
        return { success: false, error: e.message };
      }
    },

    // 生成API Key
    '/api-keys': async (request: Request) => {
      requireAuth(request);
      const { name, account_id } = request.body;
      if (!name) {
        return new Response({ error: '名称不能为空' }, { statusCode: 400 });
      }
      try {
        const apiKey = db.generateApiKey(name, account_id);
        return { success: true, api_key: apiKey, message: 'API Key生成成功' };
      } catch (e) {
        return new Response({ error: '生成失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 切换API Key状态
    '/api-keys/toggle': async (request: Request) => {
      requireAuth(request);
      const { id, is_active } = request.body;
      if (!id) {
        return new Response({ error: '缺少Key ID' }, { statusCode: 400 });
      }
      db.toggleApiKey(id, is_active);
      return { success: true, message: is_active ? '已启用' : '已禁用' };
    },

    // 手动触发账号存活检测
    '/accounts/health-check': async (request: Request) => {
      requireAuth(request);
      try {
        const result = await triggerHealthCheck();
        return { success: true, message: '存活检测完成', ...result };
      } catch (e) {
        return new Response({ error: '检测失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 手动触发积分同步
    '/accounts/sync-credits': async (request: Request) => {
      requireAuth(request);
      try {
        const result = await triggerCreditsSync();
        return { success: true, message: '积分同步完成', ...result };
      } catch (e) {
        return new Response({ error: '同步失败: ' + e.message }, { statusCode: 500 });
      }
    }
  },

  delete: {
    // 清理日志
    '/logs': async (request: Request) => {
      requireAuth(request);
      db.clearLogs();
      return { success: true, message: '日志已清理' };
    },

    // 删除即梦账号
    '/accounts': async (request: Request) => {
      requireAuth(request);
      const id = parseInt(request.query.id as string);
      if (!id) {
        return new Response({ error: '缺少账号ID' }, { statusCode: 400 });
      }
      db.deleteAccount(id);
      return { success: true, message: '账号已删除' };
    },

    // 删除API Key
    '/api-keys': async (request: Request) => {
      requireAuth(request);
      const id = parseInt(request.query.id as string);
      if (!id) {
        return new Response({ error: '缺少Key ID' }, { statusCode: 400 });
      }
      db.deleteApiKey(id);
      return { success: true, message: 'API Key已删除' };
    }
  }
};
