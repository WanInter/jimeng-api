# 更新日志

本项目所有重要变更均记录于此文件。

版本号遵循语义化版本规范 vMAJOR.MINOR.PATCH。

## [v1.14.0] - 2026-06-18 22:00
**版本代号**: 反检测安全加固版

### 🔒 安全加固
#### 设备标识随机化 ⭐
- **问题**: `DEVICE_ID`、`WEB_ID`、`USER_ID` 进程启动时生成一次，所有请求共享同一设备指纹
- **修复**: 每次请求独立生成设备标识，模拟真实浏览器行为
- **文件**: `src/api/controllers/core.ts`

#### Cookie 完整性修复 ⭐
- **问题**: 缺少 `ttwid`、`odin_tt`、`fpk1`、`s_v_web_id`、`passport_csrf_token` 等关键追踪 Cookie
- **修复**: 补充全部字节跳动追踪 Cookie，每次请求随机生成
- **修复**: `sid_guard` 过期时间从硬编码 2025-02 改为动态计算（当前+60天）
- **修复**: `store-region` 从硬编码 `cn-gd` 改为根据 token 地区动态设置
- **文件**: `src/api/controllers/core.ts`

#### User-Agent 随机化 ⭐
- **问题**: 所有请求使用同一个静态 UA，可通过统计分析识别
- **修复**: 维护 7 个真实浏览器 UA 池，每次请求随机选择，`Sec-Ch-Ua` 版本号自动匹配
- **文件**: `src/api/controllers/core.ts`

#### 平台一致性修复 ⭐
- **问题**: `Sec-Ch-Ua-Platform` 声称 Windows，但服务器可能运行在 Linux
- **修复**: 启动时检测实际 OS，动态设置 `Sec-Ch-Ua-Platform` 和 `os` 请求参数
- **文件**: `src/api/controllers/core.ts`

#### 请求频率限制 ⭐
- **问题**: 无任何速率限制，高频请求可触发即梦风控
- **修复**: 实现 per-token 令牌桶限流（5 并发/秒补充 1 令牌），防止同一 token 过度请求
- **文件**: `src/api/controllers/core.ts`

#### 日志脱敏 ⭐
- **问题**: 日志记录完整请求 URL（含 token）、Cookie、请求体、响应数据
- **修复**: 仅记录 URI 路径，移除敏感数据输出，响应数据不再记录
- **文件**: `src/api/controllers/core.ts`

#### 账号保活安全优化 ⭐
- **问题**: 保活检测频率过高（30分钟），固定顺序，易被识别为自动化行为
- **修复**: 检测间隔延长至 2 小时，积分同步延长至 12 小时
- **修复**: 检测顺序随机打乱，账号间随机延迟 3-8 秒
- **修复**: 启动延迟 30 秒再执行首次检测
- **文件**: `src/lib/account-keeper.ts`

### 📚 文件变更
- `src/api/controllers/core.ts` — 核心反检测改造
- `src/lib/account-keeper.ts` — 保活安全优化

---

## [v1.13.0] - 2026-06-18 21:00
**版本代号**: 账号保活与健康检测版

### 🆕 新增功能
#### 账号保活定时任务 ⭐
- **功能**: 自动定时检测账号存活状态，防止 session 过期导致请求失败
- **检测**: 每 30 分钟调用 `/passport/account/info/v2` 验证 token 是否有效
- **标记**: 连续 3 次检测失败自动标记为 `expired` 状态
- **恢复**: 检测恢复正常后自动标记为 `active`
- **文件**: `src/lib/account-keeper.ts` `src/index.ts`

#### 积分定时同步 ⭐
- **功能**: 定时刷新所有账号的积分缓存，保持积分数据准确
- **间隔**: 每 6 小时自动同步一次
- **文件**: `src/lib/account-keeper.ts`

#### 手动触发 API ⭐
- **POST** `/dashboard/accounts/health-check` — 手动触发所有账号存活检测
- **POST** `/dashboard/accounts/sync-credits` — 手动触发所有账号积分同步
- **文件**: `src/api/routes/dashboard.ts`

#### 账号状态管理
- **状态值**: `active`（正常）、`warning`（检测失败）、`expired`（连续 3 次失败）、`error`（API 异常）、`unknown`（未检测）
- **日志**: 每次检测结果记录到日志，失败原因可追溯
- **文件**: `src/lib/database.ts` `src/lib/account-keeper.ts`

### 📚 文件变更
- `src/lib/account-keeper.ts` — 新建账号保活模块
- `src/lib/database.ts` — 新增 `getAllAccountTokens()` 函数
- `src/api/routes/dashboard.ts` — 新增手动触发 API
- `src/index.ts` — 服务启动时初始化定时任务

---

## [v1.12.0] - 2026-06-18 20:00
**版本代号**: 可配置积分规则与代理绑定版

### 🆕 新增功能
#### 可配置积分消耗规则 ⭐
- **功能**: 积分消耗规则存储于 DB `cost_rules` 表，支持通过管理后台增删改查，无需修改代码
- **匹配**: 按 task_type + model_pattern + region + resolution + duration 范围 + priority 优先级匹配
- **默认**: 内置 15+ 条默认规则覆盖所有即梦视频/图片模型
- **文件**: `src/lib/database.ts` `src/api/routes/dashboard.ts`

#### 账号级代理绑定 ⭐
- **功能**: 每个即梦账号可绑定独立代理 URL（HTTP/SOCKS5），该账号所有请求自动走绑定代理
- **格式**: 代理自动拼接为 `proxy_url@token` 格式，token 自带代理优先不覆盖
- **管理**: 管理后台支持设置/更新账号代理
- **文件**: `src/lib/database.ts` `src/lib/load-balancer.ts` `src/api/routes/dashboard.ts`

#### 积分消耗规则管理接口
- **GET** `/dashboard/cost-rules` - 获取所有规则
- **POST** `/dashboard/cost-rules/add` - 添加规则
- **POST** `/dashboard/cost-rules/update` - 更新规则
- **POST** `/dashboard/cost-rules/delete` - 删除规则
- **POST** `/dashboard/accounts/proxy` - 设置账号代理

### 🐛 Bug 修复
#### Dashboard 路由语法错误 ⭐
- **问题**: `dashboard.ts` 存在重复的 `post:` 代码块，导致编译警告
- **修复**: 清理残留代码，合并为单一 `post:` 块

### 📚 文件变更
- `src/lib/database.ts` — 新增 cost_rules 表、proxy_url 列、规则 CRUD 函数
- `src/lib/load-balancer.ts` — 重写为使用 DB 规则 + 代理绑定
- `src/api/routes/images.ts` — 集成 selectToken 返回的 proxyToken
- `src/api/routes/videos.ts` — 集成 selectToken 返回的 proxyToken
- `src/api/routes/chat.ts` — 集成 selectToken 返回的 proxyToken
- `src/api/routes/dashboard.ts` — 新增代理/规则管理端点

---

## [v1.11.0] - 2026-06-15 18:00
**版本代号**: 积分感知负载均衡版

### 🆕 新增功能
#### 积分感知负载均衡 ⭐
- **功能**: 多账号场景下智能选择 token，基于积分余额优化账号使用
- **策略**: 生图（低成本任务）优先用完小余额账号；生视频（高成本任务）优先用大余额账号
- **重试**: 积分不足导致生成失败时，自动切换到下一个账号重试（最多 3 次）
- **估算**: 内置积分消耗预估（生图 ~5积分/张，生视频 25-75积分/次）
- **缓存**: 优先使用 DB 缓存积分数据，缺失时实时查询即梦 API
- **文件**: `src/lib/load-balancer.ts` `src/lib/database.ts` `src/api/routes/images.ts` `src/api/routes/videos.ts` `src/api/routes/chat.ts`

---

## [v1.10.0] - 2026-06-15 15:30
**版本代号**: 管理后台集成版

### 🆕 新增功能
#### SQLite 管理后台 ⭐
- **功能**: 集成完整的 Web 管理后台，包含账号管理、API Key 管理、统计信息、实时日志、媒体库六大模块
- **位置**: `public/index.html` + `src/api/routes/dashboard.ts` + `src/lib/database.ts`
- **文件**: `src/lib/database.ts` `src/api/routes/dashboard.ts` `public/index.html`

#### Chat 对话接口（OpenAI 兼容） ⭐
- **功能**: 新增 `/v1/chat/completions` 接口，支持图像/视频模型自动判别
- **位置**: `src/api/controllers/chat.ts` + `src/api/routes/chat.ts`
- **文件**: `src/api/controllers/chat.ts` `src/api/routes/chat.ts`

#### 智能比例检测
- **功能**: 从 prompt 中自动提取宽高比关键词，匹配对应分辨率
- **位置**: `src/api/controllers/images.ts`
- **文件**: `src/api/controllers/images.ts`

#### 分辨率/时长自动降级
- **功能**: 积分不足时自动回退到更低分辨率或更短时长，提升生成成功率
- **位置**: `src/api/controllers/images.ts` `src/api/controllers/videos.ts`
- **文件**: `src/api/controllers/images.ts` `src/api/controllers/videos.ts`

### 🐛 Bug 修复
#### 管理后台鉴权状态码错误 ⭐
- **问题**: 未登录访问 dashboard 受保护接口时错误返回 HTTP 200
- **原因**: `requireAuth` 抛出 Response 对象，被 server 层 FailureBody 包装后无法识别，状态码默认回退为 200
- **修复**: 改为抛出带 `.setHTTPStatusCode(401)` 的 Exception，正确返回 HTTP 401 与错误码 -1003
- **文件**: `src/api/routes/dashboard.ts` `src/lib/consts/exceptions.ts`

### 📚 文档更新
- 重写 `README.md` / `README.CN.md`：移除旧仓库与联系信息，仅保留参考项目标注，补充管理后台、Chat 接口等新功能说明，更新镜像地址为 `ghcr.io/icysaintdx/jimeng-api`

---
