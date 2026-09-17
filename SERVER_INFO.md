# Jimeng API Server / Cluster Deployment Info

更新时间：2026-06-24 CST

## 集群部署

- Kubernetes context：`ali`
- Kubernetes 发行版：k3s
- Namespace：`jimeng-api`
- Workload：`deployment/jimeng-api`
- Service：`service/jimeng-api`，ClusterIP，端口 `5100`
- Ingress：`ingress/jimeng-api`
- IngressClass：`traefik`
- TLS Secret：`jimeng-api-tls`
- Certificate：`certificate/jimeng-api-tls`，状态 `Ready=True`
- PVC：`jimeng-api-data`，`5Gi`，StorageClass `longhorn`
- SQLite 数据库路径：容器内 `/app/data/jimeng.db`，由 PVC 持久化
- 当前镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-dreamina-email-regex-fix-20260624210238`
- 当前镜像 digest：`sha256:1d21b88996c4c907b1cc27f373d1247a8b00bd6756da9ffd15f1d82a9c4cf4ff`
- 镜像仓库：`hub.cs.waypeak.work/jimeng-api/jimeng-api`
- Kaniko 构建 Namespace：`jimeng-api-build`
- Kaniko registry Secret：`jimeng-api-registry-auth`

## 访问地址

| 入口 | 地址 | 验证结果 |
|---|---|---|
| 管理后台 | `https://jimeng.cs.waypeak.work/` | 200 OK，返回 `即梦 API 管理控制台` HTML |
| 健康检查 | `https://jimeng.cs.waypeak.work/ping` | 200 OK，返回 `pong` |
| 初始化状态 | `https://jimeng.cs.waypeak.work/dashboard/status` | 200 OK，当前 `{"setupComplete":false}` |
| OpenAI 兼容图片接口 | `https://jimeng.cs.waypeak.work/v1/images/generations` | 需配置即梦账号或 Bearer session 后使用 |
| OpenAI 兼容视频接口 | `https://jimeng.cs.waypeak.work/v1/videos/generations` | 需配置即梦账号或 Bearer session 后使用 |
| OpenAI 兼容 Chat 接口 | `https://jimeng.cs.waypeak.work/v1/chat/completions` | 需配置即梦账号或 Bearer session 后使用 |

## 管理后台初始化

首次访问 `https://jimeng.cs.waypeak.work/` 时会要求创建管理员账号。

注意：不要把管理员密码、即梦 sessionid、API Key 写入本文档或提交到仓库。

## 本次部署记录

- 2026-06-20：新增 K8s/Kaniko 部署资产并完成首次集群部署。
- 修正 Dockerfile：生产镜像复制 `public/`，确保根路径管理后台可访问；创建 `/app/data`，配合 PVC 持久化 SQLite。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-20260620032006`
- Deployment Ready：`1/1`
- PVC：`jimeng-api-data` 已 Bound
- TLS Certificate：`jimeng-api-tls` 已 Ready


- 2026-06-20：修复后台生成的 `jm-...` API Key 未转换为绑定即梦 session 的问题。此前主接口会把 `jm-...` 当作即梦 sessionid 发送到上游，导致 `check login error`。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-apikey-auth-20260620141706`
- Digest：`sha256:9cff3d9c946fb85060869d3b2ccad2fe92dbeab668ab5ef6f2fbca4abeb3697b`


- 2026-06-20：新增实验性越南区域 `vn-` 支持：`store-region=vn`、`Loc=vn`、`Lan=vi`、`region=VN`，其余 API 域名沿用亚太/SG Dreamina 链路。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-vn-region-20260620142444`
- Digest：`sha256:e86b25e46c034af2a8f369bbf76095ced125049d8e41aa536106f5b04fa61440`
- 已将当前测试账号从 `sg-` 前缀切换为 `vn-` 前缀。


- 2026-06-23：部署页面 secsdk 复用签名器版本。受 Dreamina `shark not pass reject (-6)` 影响，受保护接口改为通过已打开页面的 secsdk/webmssdk 生成 `msToken`、`X-Bogus`、`X-Gnarly` 后再由服务端请求上游。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-browser-signer-20260623230331`
- Digest：`sha256:3b5b58a861266636453e0341c1507351c19cdd9fd3942bbdc2eb96a06ca34213`
- Deployment Ready：`1/1`
- 健康检查：`/ping` 返回 `pong`，`/dashboard/status` 返回 `{"setupComplete":true}`
- 注意：该版本线上生成能力依赖可访问的 Dreamina 页面 CDP 签名环境；默认端口为 `DREAMINA_CDP_PORT` 或 `64896`。


- 2026-06-24：部署远程 BitBrowser 编排版本。后台新增“远程浏览器”设置，仅需填写 `BitBrowser API 地址`；CDP 地址会根据 `/browser/open` 返回端口自动从 BitBrowser API host 推导。支持批量导入账号密码、自动/半自动登录、检测时持久化 CDP/Profile 绑定，以及账号级页面 secsdk 签名。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-remote-bitbrowser-20260624094011`
- Digest：`sha256:2159dd6787e28b1e8967f236fee567ef5d39d4c534e470e93cf584849aff328c`
- Deployment Ready：`1/1`
- 健康检查：`/ping` 返回 `pong`，`/dashboard/status` 返回 `{"setupComplete":true}`，根路径返回 `即梦 API 管理控制台` HTML。
- 使用说明：远程部署时在后台 `远程浏览器` 页面保存本地 BitBrowser API 地址，例如 `http://<bitbrowser-host>:54345`；本地机器需允许集群访问该 API 端口以及 `/browser/open` 返回的 CDP 端口。


- 2026-06-24：部署账号操作按钮简化版本。账号行主操作收敛为 `登录/修复`、`检测`、`查积分`、`高级`；`绑定 Profile`、`仅打开窗口`、`删除账号` 移入高级操作，降低正式批量登录/检测流程误操作。远程浏览器设置仍只需填写 `BitBrowser API 地址`，CDP 继续由服务端自动推导。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-ui-actions-20260624101925`
- Digest：`sha256:b752719a5bf18900e42d4379e3de40e44a4ceaba55cd064b88aceb24ebb2a99a`
- Deployment Ready：`1/1`，Pod：`jimeng-api-d78bbdb4d-zzh9q`。
- 健康检查：`/ping` 返回 `pong`，`/dashboard/status` 返回 `{"setupComplete":true}`。
- 已验证根页面包含 `登录/修复`、`高级`、`远程 BitBrowser 设置`；Pod 可通过 Tailscale 访问本机 `http://100.91.75.54:54345/browser/list`。


- 2026-06-24：部署 BitBrowser API 超时修复版本。将后端连接 BitBrowser API 的默认超时从固定 `30000ms` 提高为可配置，默认 `120000ms`，支持通过 `BITBROWSER_API_TIMEOUT_MS` 覆盖，避免 BitBrowser 打开/启动窗口较慢时出现 `timeout of 30000ms exceeded` 导致登录失败。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-bitbrowser-timeout-20260624145358`
- Digest：`sha256:99aa5273212dc42ca1e63fabf94b615b51cd24bcb030f34d1297853194d20ba0`
- Deployment Ready：`1/1`，Pod：`jimeng-api-65464d8fbf-nt4cw`。
- 健康检查：`/ping` 返回 `pong`，`/dashboard/status` 返回 `{"setupComplete":true}`，根路径返回 `即梦 API 管理控制台` HTML。


- 2026-06-24：部署 CDP Runtime.evaluate 超时容错版本。修复 `cdpCall` 响应后未清理 timeout；自动填表阶段若因点击登录/提交触发页面跳转导致 `Runtime.evaluate` 不返回，不再直接判定登录失败，而是记录 warning、保持浏览器打开并继续检测/等待人工处理；最终检测会重新发现当前 Dreamina page WebSocket，避免复用跳转前旧 target。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-cdp-runtime-tolerant-20260624174840`
- Digest：`sha256:a9c3e81c53e0eb0ad031c1add87d2157bf71fd04abe185a6627e32d548d9dc2b`
- Deployment Ready：`1/1`，Pod：`jimeng-api-d9d6896f6-h5gzk`。
- 健康检查：`/ping` 返回 `pong`，`/dashboard/status` 返回 `{"setupComplete":true}`。




- 2026-06-24 本地调试更新：根据 Dreamina/CapCut 邮箱登录实测流程调整自动登录逻辑：默认打开 `https://dreamina.capcut.com/ai-tool/home?need_login=true`；优先真实 CDP 鼠标点击 `使用電子郵件繼續/使用邮箱继续/Continue with email`；如果已在邮箱/密码表单则跳过登录方式选择，避免重复点击导致退回选择页；提交后等待时间默认 30s；若出现 `發生錯誤/重新整理/重試` 等错误弹窗，会自动点击重新整理/重试或 reload，再等待 25s 后重新检测 cookies。已在本地 BitBrowser profile 中确认 `onyxholmesrwet@outlook.com` 登录态可检测，DB 状态为 `ok`。该修复已通过 `npm run build`，本地服务用 Node v22.22.1 启动验证；线上镜像待下一次 Kaniko 构建部署。



- 2026-06-24：部署 Dreamina 邮箱登录恢复增强版本。包含本地调试确认的邮箱登录状态机、真实 CDP 鼠标点击、已在邮箱/密码页时跳过方式选择、提交后错误弹窗 `發生錯誤/重新整理/重試` 自动恢复、重新检测 session cookies 等修复。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-dreamina-email-login-recovery-20260624202452`
- Digest：`sha256:645ff900c9768896305aaacb5c6283630752608a9e309450c7929e2c8d2a35e9`
- Deployment Ready：`1/1`，Pod：`jimeng-api-67df6c684f-rnpdl`。
- 健康检查：`/ping` 返回 `pong`，`/dashboard/status` 返回 `{"setupComplete":true}`，根路径返回管理后台 HTML。



- 2026-06-24：部署 Dreamina 英文邮箱按钮点击修复版本。修复英文弹窗中上层容器文本同时包含 Google/TikTok/Facebook/email 时，点击候选可能误选第一个第三方按钮的问题；现在只优先选择自身文本匹配 `Continue with email` 的最小可点击元素/按钮。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-dreamina-email-click-fix-20260624204715`
- Digest：`sha256:7189ec49d534323281126c82e03598fb18b3df8419e003a04f129f9ad2ec4888`
- Deployment Ready：`1/1`，Pod：`jimeng-api-578f68d8bd-r5qrx`。
- 健康检查：`/ping` 返回 `pong`，`/dashboard/status` 返回 `{"setupComplete":true}`。



- 2026-06-24：部署 Dreamina 登录注入脚本正则语法修复版本。上一版英文按钮点击修复中，注入页面执行的 JS 使用 `split(/\n+/)` 在模板字符串内被转义成非法跨行正则，线上日志出现 `SyntaxError: Invalid regular expression: missing /`，导致自动填表逻辑未继续执行；本版改为 `split(String.fromCharCode(10))`，已本地验证注入脚本不再 SyntaxError。
- 镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-dreamina-email-regex-fix-20260624210238`
- Digest：`sha256:1d21b88996c4c907b1cc27f373d1247a8b00bd6756da9ffd15f1d82a9c4cf4ff`
- Deployment Ready：`1/1`，Pod：`jimeng-api-75c68b56d4-cdzw7`。
- 健康检查：`/ping` 返回 `pong`，`/dashboard/status` 返回 `{"setupComplete":true}`。

## 远程 BitBrowser / Tailscale 连接

- 本机 BitBrowser Tailscale IP：`100.91.75.54`
- 线上后台 `远程浏览器` 设置已写入：`BitBrowser API 地址 = http://100.91.75.54:54345`
- CDP 地址无需手动配置：服务调用 `/browser/open` 时会附加 `--remote-debugging-address=0.0.0.0`，并根据返回端口自动推导 `http://100.91.75.54:<cdp-port>`。
- 已验证远程 k3s 节点和 `jimeng-api` Pod 可访问：
  - `http://100.91.75.54:54345/browser/list`
  - `/browser/open` 返回的 CDP 端口，例如 `http://100.91.75.54:52060/json/version`
- 已加入 Tailscale 的 k3s 节点：`node196=100.71.5.102`、`node4=100.100.223.4`、`node53=100.74.68.124`、`node2/company=100.83.241.120`、`node204=100.94.246.89`、`node224=100.67.198.35`。
- 安全注意：BitBrowser API/CDP 仅通过 Tailscale IP 使用，不建议暴露到公网。


- 2026-06-24：BitBrowser Tailscale 地址修正：旧地址 `100.103.52.37` 对应设备已离线，导致线上调用 `/browser/open` 卡住直到 `timeout of 120000ms exceeded` 且无法拉起浏览器；已将后台 `bitbrowser_api_base` 改为当前在线的 `http://100.91.75.54:54345`，并验证 Pod 可访问 `/browser/list` 与 CDP `http://100.91.75.54:52060/json/version`。

## 关键文件

```text
Dockerfile
SERVER_INFO.md
deploy/k8s/00-namespace.yaml
deploy/k8s/10-pvc.yaml
deploy/k8s/20-configmap.yaml
deploy/k8s/30-deployment.yaml
deploy/k8s/40-service.yaml
deploy/k8s/50-ingress.yaml
scripts/kaniko-build.sh
scripts/deploy-k8s.sh
```

## 常用命令

### 查看线上状态

```bash
kubectl config use-context ali
kubectl -n jimeng-api get deploy,pod,svc,ingress,pvc,certificate
kubectl -n jimeng-api logs deploy/jimeng-api --tail=100
```

### 健康检查

```bash
curl -k -fsS https://jimeng.cs.waypeak.work/ping
curl -k -fsS https://jimeng.cs.waypeak.work/dashboard/status
```

### 使用 Kaniko 构建镜像

默认会推送两个 tag：指定的 `IMAGE_TAG` 和 `latest`。

```bash
IMAGE_TAG=prod-$(date +%Y%m%d%H%M%S) ./scripts/kaniko-build.sh
```

默认参数：

```bash
IMAGE=hub.cs.waypeak.work/jimeng-api/jimeng-api
BUILD_NAMESPACE=jimeng-api-build
REGISTRY_SECRET_NAME=jimeng-api-registry-auth
DOCKER_CONFIG_JSON=$HOME/.docker/config.json
KANIKO_IMAGE=gcr.io/kaniko-project/executor:debug
BUILD_PLATFORM=linux/amd64
```

### 部署 / 更新到 k3s

```bash
IMAGE=hub.cs.waypeak.work/jimeng-api/jimeng-api:<tag> ./scripts/deploy-k8s.sh
```

部署前 dry-run：

```bash
IMAGE=hub.cs.waypeak.work/jimeng-api/jimeng-api:<tag> ./scripts/deploy-k8s.sh --dry-run
```

默认参数：

```bash
NAMESPACE=jimeng-api
HOST=jimeng.cs.waypeak.work
TLS_SECRET=jimeng-api-tls
CERT_ISSUER=letsencrypt-prod
INGRESS_CLASS=traefik
STORAGE_CLASS=longhorn
STORAGE_SIZE=5Gi
```

### 回滚

查看历史版本：

```bash
kubectl -n jimeng-api rollout history deployment/jimeng-api
```

回滚到上一版：

```bash
kubectl -n jimeng-api rollout undo deployment/jimeng-api
kubectl -n jimeng-api rollout status deployment/jimeng-api --timeout=300s
```

或直接指定镜像：

```bash
kubectl -n jimeng-api set image deployment/jimeng-api \
  jimeng-api=hub.cs.waypeak.work/jimeng-api/jimeng-api:<tag>
kubectl -n jimeng-api rollout status deployment/jimeng-api --timeout=300s
```

## 持久化说明

- 后台管理员账号、Session、即梦账号、API Key、媒体记录、日志、积分规则均写入 SQLite。
- 数据库文件位于容器内 `/app/data/jimeng.db`。
- `/app/data` 挂载 PVC `jimeng-api-data`。
- Deployment 使用 `Recreate` 策略，避免 SQLite 单库被多 Pod 同时挂载/写入。
- 当前副本数保持 `1`，不要直接水平扩容；如需多副本，应先改造数据库为外部数据库或处理 SQLite 写入一致性。

## 备份建议

临时手动备份 SQLite：

```bash
kubectl -n jimeng-api exec deploy/jimeng-api -- sh -c \
  'sqlite3 /app/data/jimeng.db ".backup /app/data/jimeng-backup.db" || cp /app/data/jimeng.db /app/data/jimeng-backup.db'

kubectl -n jimeng-api cp \
  deploy/jimeng-api:/app/data/jimeng-backup.db \
  ./jimeng-backup-$(date +%Y%m%d%H%M%S).db
```

说明：当前镜像未显式安装 `sqlite3` CLI，上述命令会 fallback 到 `cp`。更严谨的在线备份可后续增加专用 backup Job。

## 已验证命令摘要

```bash
./scripts/deploy-k8s.sh --dry-run
IMAGE_TAG=prod-20260620032006 ./scripts/kaniko-build.sh
IMAGE=hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-20260620032006 ./scripts/deploy-k8s.sh
kubectl -n jimeng-api get deploy,pod,svc,ingress,pvc,certificate
curl -k -fsS https://jimeng.cs.waypeak.work/ping
curl -k -fsS https://jimeng.cs.waypeak.work/dashboard/status
curl -k -fsS https://jimeng.cs.waypeak.work/ | head
```

## 注意事项

- `.dockerignore` 原先排除了 `public/` 间接导致管理后台不能进入镜像；当前 Dockerfile 已从 builder stage 显式复制 `/app/public`，并已验证线上根路径返回 HTML。
- 项目运行环境变量 `SERVER_ENV=dev` 是为了复用现有 `configs/dev/*.yml`。这只是配置目录名，不代表集群是开发环境。
- 首次配置后台后，请在后台添加即梦账号，再生成或管理 API Key。
- 当前代码里 API Key 与 session token 的主接口鉴权转换逻辑建议后续再复核；直接 Bearer 即梦 session 仍可按原项目逻辑使用。
