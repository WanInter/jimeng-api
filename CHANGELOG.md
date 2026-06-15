# 更新日志

本项目所有重要变更均记录于此文件。

版本号遵循语义化版本规范 vMAJOR.MINOR.PATCH。

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
