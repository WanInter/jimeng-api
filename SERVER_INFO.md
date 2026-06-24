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
- 当前镜像：`hub.cs.waypeak.work/jimeng-api/jimeng-api:prod-node18-websocket-20260624110113`
- 当前镜像 digest：`sha256:ff5e1fcb2997f8e220378f8887836da5f41232dd3a3f3f3ba7734d88015a8881`
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
- 已验证根页面包含 `登录/修复`、`高级`、`远程 BitBrowser 设置`；Pod 可通过 Tailscale 访问本机 `http://100.103.52.37:54345/browser/list`。


## 远程 BitBrowser / Tailscale 连接

- 本机 BitBrowser Tailscale IP：`100.103.52.37`
- 线上后台 `远程浏览器` 设置已写入：`BitBrowser API 地址 = http://100.103.52.37:54345`
- CDP 地址无需手动配置：服务调用 `/browser/open` 时会附加 `--remote-debugging-address=0.0.0.0`，并根据返回端口自动推导 `http://100.103.52.37:<cdp-port>`。
- 已验证远程 k3s 节点和 `jimeng-api` Pod 可访问：
  - `http://100.103.52.37:54345/browser/list`
  - `/browser/open` 返回的 CDP 端口，例如 `http://100.103.52.37:59186/json/version`
- 已加入 Tailscale 的 k3s 节点：`node196=100.71.5.102`、`node4=100.100.223.4`、`node53=100.74.68.124`、`node2/company=100.83.241.120`、`node204=100.94.246.89`、`node224=100.67.198.35`。
- 安全注意：BitBrowser API/CDP 仅通过 Tailscale IP 使用，不建议暴露到公网。

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
