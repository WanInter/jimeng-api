# Jimeng API 集群部署信息

更新时间：2026-09-18 CST

## 集群部署（当前）

- Kubernetes context：`waninter`
- Kubernetes 发行版：k3s `v1.35.6+k3s1`
- 节点：`waninter-2`（control-plane,etcd，192.99.233.131）、`node-192-99-63-80`（192.99.63.80）
- Namespace：`jimeng-api`
- Workload：`deployment/jimeng-api`，副本 `1`，策略 `Recreate`
- Service：`service/jimeng-api`，ClusterIP `10.43.76.71`，端口 `5100`
- Ingress：`ingress/jimeng-api`，IngressClass `traefik`，地址 `192.99.63.80`
- TLS Secret：`jimeng-api-tls`
- Certificate：`certificate/jimeng-api-tls`，`Ready=True`，签发者 Let's Encrypt，有效期至 `2026-12-17`
- ClusterIssuer：`letsencrypt-prod`
- PVC：`jimeng-api-data`，`5Gi`，StorageClass `waninter-local-retain`（`rancher.io/local-path`，ReclaimPolicy `Retain`），状态 `Bound`
- SQLite 数据库路径：容器内 `/app/data/jimeng.db`，由 PVC 持久化
- 镜像仓库：`ghcr.io/waninter/jimeng-api`
- 当前镜像：`ghcr.io/waninter/jimeng-api:prod-20260918105526`
- 当前镜像 digest：`sha256:8fa8163a244464534c6ebbb1c765643ed7b39988a13658907e9526455979a740`
- imagePullSecret：`ghcr-pull`（`kubernetes.io/dockerconfigjson`，仅含 `ghcr.io`，从集群内既有 secret 复制）

## 访问地址

| 入口 | 地址 | 验证结果 |
|---|---|---|
| 管理后台 | `https://jimeng.relay.waninter.com/` | 200 OK，返回 `即梦 API 管理控制台` HTML |
| 健康检查 | `https://jimeng.relay.waninter.com/ping` | 200 OK，返回 `pong` |
| 初始化状态 | `https://jimeng.relay.waninter.com/dashboard/status` | 200 OK，当前 `{"setupComplete":false}` |
| OpenAI 兼容图片接口 | `https://jimeng.relay.waninter.com/v1/images/generations` | 需配置即梦账号或 Bearer session 后使用 |
| OpenAI 兼容视频接口 | `https://jimeng.relay.waninter.com/v1/videos/generations` | 需配置即梦账号或 Bearer session 后使用 |
| OpenAI 兼容 Chat 接口 | `https://jimeng.relay.waninter.com/v1/chat/completions` | 需配置即梦账号或 Bearer session 后使用 |

TLS 证书由 Let's Encrypt 正式签发，`curl` 默认校验即可通过，无需 `-k`。

## 管理后台初始化

首次访问 `https://jimeng.relay.waninter.com/` 会要求创建管理员账号。当前 `setupComplete=false`，即尚未初始化。

注意：不要把管理员密码、即梦 sessionid、API Key 写入本文档或提交到仓库。

## 本次部署记录

- 2026-09-18：在 `waninter` k3s 集群新建 `jimeng-api` namespace 并完成首次部署。
  - 镜像基于当前工作树（本地 HEAD `f892e91`，领先 `origin/main` 39 个提交，且含未提交改动）通过远程 Docker context `waninter` 以 `linux/amd64` 构建后推送 GHCR；GHCR 上此前不存在该镜像仓库。
  - 镜像：`ghcr.io/waninter/jimeng-api:prod-20260918105526`（同时推送 `latest`）
  - Digest：`sha256:8fa8163a244464534c6ebbb1c765643ed7b39988a13658907e9526455979a740`
  - Deployment Ready：`1/1`，Pod：`jimeng-api-6db4959449-fqlxx`
  - PVC `jimeng-api-data` 已 Bound，Certificate `jimeng-api-tls` 已 Ready
  - 健康检查：`/ping` 返回 `pong`，`/dashboard/status` 返回 `{"setupComplete":false}`，根路径返回管理后台 HTML

### 旧环境清理（同批完成）

原部署记录指向的 `ali` context / `hub.cs.waypeak.work` 私仓 / `jimeng.cs.waypeak.work` 域名 / `longhorn` StorageClass 均已失效，已按实测结果清理：

- `~/.kube` 中含 `ali` 集群凭据的备份文件 `config.bak.20260621112844` 已删除；当前 kubeconfig 仅有 `waninter` 一个 context。
- `hub.cs.waypeak.work` 与 `jimeng.cs.waypeak.work` 从本机 TLS 握手失败（`curl` exit 35 / 无响应），DNS 解析到 `198.18.40.x` 保留段。
- `scripts/deploy-k8s.sh`、`scripts/kaniko-build.sh` 默认值已改为 GHCR 镜像、`jimeng.relay.waninter.com`、`waninter-local-retain`、`ghcr-pull`。
- 本集群不使用 Kaniko 流程（无 `jimeng-api-build` namespace）；`scripts/kaniko-build.sh` 仅作为备用路径保留。

## 远程 BitBrowser 连接（待重新配置）

本版本的账号登录/检测能力依赖可访问的远程 BitBrowser API 与其 `/browser/open` 返回的 CDP 端口。

- 需在后台 `远程浏览器` 页面填写 `BitBrowser API 地址`，例如 `http://<bitbrowser-host>:54345`；CDP 地址由服务端按返回端口自动推导。
- 未验证：当前 `waninter` 集群节点到 BitBrowser 主机的网络可达性尚未测试（旧集群曾通过 Tailscale 打通，本集群节点是否加入 Tailscale 未确认）。使用前需先确认 Pod 能访问该 API 端口及 CDP 端口。
- 安全注意：BitBrowser API/CDP 不应暴露到公网。
- 可选环境变量：`BITBROWSER_API_TIMEOUT_MS`（默认 `120000`）、`DREAMINA_CDP_PORT`。

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
scripts/deploy-k8s.sh
scripts/kaniko-build.sh
.github/workflows/docker-publish.yml
```

`scripts/` 被 `.gitignore` 排除，不在版本控制内。

## 常用命令

### 查看线上状态

```bash
kubectl config use-context waninter
kubectl -n jimeng-api get deploy,pod,svc,ingress,pvc,certificate
kubectl -n jimeng-api logs deploy/jimeng-api --tail=100
```

### 健康检查

```bash
curl -fsS https://jimeng.relay.waninter.com/ping
curl -fsS https://jimeng.relay.waninter.com/dashboard/status
```

### 构建并推送镜像

CI 路径（推荐，构建 `origin/main` 上的代码）：

```bash
gh workflow run docker-publish.yml --ref main
```

本地路径（用远程 Docker context 构建当前工作树，产出 `linux/amd64`）：

```bash
TAG=prod-$(date +%Y%m%d%H%M%S)
docker --context waninter build --platform linux/amd64 \
  --build-arg VERSION="${TAG#prod-}" \
  -t ghcr.io/waninter/jimeng-api:$TAG \
  -t ghcr.io/waninter/jimeng-api:latest .
docker --context waninter push ghcr.io/waninter/jimeng-api:$TAG
docker --context waninter push ghcr.io/waninter/jimeng-api:latest
```

本机为 arm64，必须指定 `--platform linux/amd64` 或使用远程 amd64 Docker，否则镜像无法在集群运行。

### 部署 / 更新到 k3s

```bash
DOCKER_CONFIG_JSON=/nonexistent \
IMAGE=ghcr.io/waninter/jimeng-api:<tag>@<digest> \
  ./scripts/deploy-k8s.sh
```

`DOCKER_CONFIG_JSON=/nonexistent` 用于跳过脚本内的 imagePullSecret 生成，避免把本机 `~/.docker/config.json` 中其他仓库的凭据写入集群。`ghcr-pull` secret 已在 namespace 内存在，如需重建：

```bash
kubectl -n new-api-pool get secret ghcr-pull -o json \
  | jq '{apiVersion,kind,type,data,metadata:{name:"ghcr-pull",namespace:"jimeng-api"}}' \
  | kubectl apply -f -
```

部署前 dry-run：

```bash
DOCKER_CONFIG_JSON=/nonexistent \
IMAGE=ghcr.io/waninter/jimeng-api:<tag> ./scripts/deploy-k8s.sh --dry-run
```

脚本默认参数：

```bash
NAMESPACE=jimeng-api
IMAGE=ghcr.io/waninter/jimeng-api:latest
HOST=jimeng.relay.waninter.com
TLS_SECRET=jimeng-api-tls
CERT_ISSUER=letsencrypt-prod
INGRESS_CLASS=traefik
STORAGE_CLASS=waninter-local-retain
STORAGE_SIZE=5Gi
IMAGE_PULL_SECRET_NAME=ghcr-pull
```

### 回滚

```bash
kubectl -n jimeng-api rollout history deployment/jimeng-api
kubectl -n jimeng-api rollout undo deployment/jimeng-api
kubectl -n jimeng-api rollout status deployment/jimeng-api --timeout=300s
```

或直接指定镜像：

```bash
kubectl -n jimeng-api set image deployment/jimeng-api \
  jimeng-api=ghcr.io/waninter/jimeng-api:<tag>
kubectl -n jimeng-api rollout status deployment/jimeng-api --timeout=300s
```

## 持久化说明

- 后台管理员账号、Session、即梦账号、API Key、媒体记录、日志、积分规则均写入 SQLite。
- 数据库文件位于容器内 `/app/data/jimeng.db`，`/app/data` 挂载 PVC `jimeng-api-data`。
- StorageClass `waninter-local-retain` 是 local-path 且 `VolumeBindingMode=WaitForFirstConsumer`，卷绑定在具体节点上，Pod 会被约束到该节点。ReclaimPolicy 为 `Retain`，删除 PVC 不会立即删除数据。
- Deployment 使用 `Recreate` 策略，避免 SQLite 单库被多 Pod 同时写入。
- 副本数保持 `1`，不要水平扩容；如需多副本，需先改造为外部数据库。

## 备份建议

```bash
kubectl -n jimeng-api exec deploy/jimeng-api -- sh -c \
  'sqlite3 /app/data/jimeng.db ".backup /app/data/jimeng-backup.db" || cp /app/data/jimeng.db /app/data/jimeng-backup.db'

kubectl -n jimeng-api cp \
  jimeng-api/$(kubectl -n jimeng-api get pod -l app.kubernetes.io/name=jimeng-api -o jsonpath='{.items[0].metadata.name}'):/app/data/jimeng-backup.db \
  ./jimeng-backup-$(date +%Y%m%d%H%M%S).db
```

说明：镜像未安装 `sqlite3` CLI，上述命令会 fallback 到 `cp`（未验证：本次未实际执行备份）。

## 已验证命令摘要

```bash
kubectl create namespace jimeng-api
docker --context waninter build --platform linux/amd64 -t ghcr.io/waninter/jimeng-api:prod-20260918105526 .
docker --context waninter push ghcr.io/waninter/jimeng-api:prod-20260918105526
DOCKER_CONFIG_JSON=/nonexistent IMAGE=ghcr.io/waninter/jimeng-api:prod-20260918105526@sha256:8fa8163a... ./scripts/deploy-k8s.sh
kubectl -n jimeng-api get deploy,pod,svc,ingress,pvc,certificate
curl -fsS https://jimeng.relay.waninter.com/ping
curl -fsS https://jimeng.relay.waninter.com/dashboard/status
curl -fsS https://jimeng.relay.waninter.com/ | head
```

## 注意事项

- `.dockerignore` 曾排除 `public/` 导致管理后台缺失；当前 Dockerfile 从 builder stage 显式复制 `/app/public`，已验证根路径返回 HTML。
- 环境变量 `SERVER_ENV=dev` 只是为了复用 `configs/dev/*.yml` 配置目录名，不代表集群是开发环境。
- 线上镜像来自本地工作树而非 `origin/main`；未提交改动（`src/lib/bitbrowser.ts`、`.github/workflows/docker-publish.yml`）尚未推送到远端仓库，后续用 CI 重建镜像会得到不同内容。
- 首次配置后台后，需在后台添加即梦账号，再生成或管理 API Key。
- Ingress 对公网开放且应用自带管理后台鉴权；在完成管理员初始化前，`/` 处于可被任意访问者抢先创建管理员的状态，建议尽快初始化。
