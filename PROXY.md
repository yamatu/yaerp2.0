# XTLS / Mihomo 代理（YaERP 2.0）

在 ERP 内部管理一条 XTLS / Clash.Meta（Mihomo）出站通道：导入订阅 → 节点测速 → 连接代理 →
按业务分别决定 **AI 接口 / WhatsApp / 邮箱** 是否走代理。

- 管理页面：`/proxy`（管理员可见，入口在“管理后台”导航中的 **XTLS 代理**）
- 代理内核：`proxy` 容器（`metacubex/mihomo`），由后端通过 external controller REST API 驱动
- 配置存储：单行表 `proxy_settings`（迁移 `049_proxy_core.sql`）

## 架构

```
                 ┌───────────────────────────────┐
 浏览器 /proxy ──►│ 后端 handler /admin/proxy/*   │
                 └──────────────┬────────────────┘
                                │ PUT /configs、/proxies、/proxies/{n}/delay
                                ▼
                 ┌───────────────────────────────┐
                 │ proxy 容器 (mihomo)           │  mixed-port :7890 (HTTP + SOCKS5)
                 └──────────────┬────────────────┘
                                │ 出站（vless/vmess/trojan/ss/hysteria2/tuic）
                                ▼
                          订阅节点 → Internet

 消费者（仅在开关打开且已连接时使用 127.0.0.1:7890 等价的代理入口）：
   AI 接口      → AIService.aiHTTPClient()      HTTP 代理
   WhatsApp     → whatsapp 容器的 puppeteer     HTTP 代理（proxy-chain）
   邮箱         → IMAP/SMTP/网页邮箱              SOCKS5 代理
```

后端只保存“订阅 → 生成配置”的结果，并把配置推给内核；节点的真实连接、测速、负载都由内核完成。

## 快速开始

1. 启动（`proxy` 已加入 `docker-compose.yml`）：

   ```bash
   docker compose up -d proxy backend whatsapp
   ```

   `proxy` 的配置目录是命名卷 `mihomo_config`。首次启动时 mihomo 会自动写入一份最小
   `config.yaml`（仅 `mixed-port: 7890`），随后由后端把真正的配置推送进去；`-ext-ctl
   0.0.0.0:9090` 让其它容器可以访问内核的 controller。

2. 打开 `/proxy`，粘贴订阅链接（或直接粘贴 Clash YAML / base64 节点链接），点击 **导入订阅**。
3. 点击 **测试全部延迟** 确认节点可用，然后 **连接代理**。
4. 在 **业务分流** 中按需打开 AI / WhatsApp / 邮箱开关。
   - 打开 WhatsApp 开关后会自动调用 sidecar 的 `/configure` 并重启已登录的会话
     （puppeteer 的 `--proxy-server` 只在启动浏览器时生效）。

## 支持与不支持

| 能力 | 说明 |
| --- | --- |
| Clash / Mihomo YAML | 保留 `proxy-providers`，其余 `proxy-groups` / `rules` 会被替换为受管分组 |
| 只有 `proxies:` 的 provider 文件 | 直接可用（无需 `mixed-port` 等字段） |
| base64 节点列表 | 支持标准 / URL-safe、带或不带 padding、单层或双层编码 |
| JSON 节点列表 | `["vless://..."]` 或 `{"servers":[...]}` 都会被识别 |
| 纯文本节点列表 | 换行、空格、Tab 分隔均可 |
| 暂不支持 | `ssr://`、`snell` 等需要额外插件的协议会被跳过（不影响其它节点导入）；协议全部不受支持时会在页面提示具体协议名 |

导入时的容错逻辑：

1. 先按原样请求订阅链接；若返回内容无法解析，且链接里没有 `flag=` / `target=`
   参数，会自动再追加 `flag=clash` 重试一次（追加在原始 query 之后，不会重编码
   `token` 里的 `+` / `%2B`）。
2. 兼容“base64 里面再套一层 Clash YAML”的订阅：先按节点链接解析，再解一层 base64 后
   按 YAML 解析。
3. 解析失败时会尽量在错误里说明原因，例如“proxies 是空列表”（订阅过期 / 流量用尽）、
   “返回的是网页内容（登录页或错误页）”，并附上内容片段方便排查。

导入后生成的配置固定为：

```yaml
mode: rule
proxy-groups:
  - name: PROXY        # select，成员为全部节点 + DIRECT
    type: select
    proxies: [...]
rules:
  - MATCH,PROXY
```

因此“选择节点”永远只操作 `PROXY` 分组，不会被订阅自带的策略组干扰。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MIHOMO_ENABLED` | `true` | 关闭后整个代理功能不可用（页面会提示内核离线） |
| `MIHOMO_MIXED_ADDR` | `127.0.0.1:7890` | **消费者**访问内核的地址；容器内部署请在 `.env` 中设为 `proxy:7890`，宿主机开发保持默认 |
| `MIHOMO_CONTROLLER_URL` | `http://127.0.0.1:9090` | 内核 external controller 地址；容器内部署请在 `.env` 中设为 `http://proxy:9090` |
| `MIHOMO_CONTROLLER_SECRET` | 空 | 同时作为 `proxy` 容器的 `CLASH_OVERRIDE_SECRET` |
| `MIHOMO_TEST_URL` | `http://www.gstatic.com/generate_204` | 测速目标 |
| `MIHOMO_ALLOW_PRIVATE_SUBSCRIPTION` | `false` | 是否允许导入指向内网/本机的订阅地址 |
| `MIHOMO_PUBLISH_PORT` | `7890` | 映射到宿主机的 mixed 端口（仅监听 `127.0.0.1`） |

> 后端不通过 `HTTP_PROXY` 环境变量出网，避免把数据库、Redis 等内部流量也送进代理；
> AI / WhatsApp / 邮箱三条链路各自显式使用代理。控制器的 REST 调用与节点测速也强制直连，
> 因此即使宿主机给容器注入了 `HTTP_PROXY` / `ALL_PROXY` 也不影响内核识别。
>
> 若配置的 `MIHOMO_CONTROLLER_URL` / `MIHOMO_MIXED_ADDR` 不可达（常见于“改了 `.env` 但没重建
> backend 容器”），后端会自动尝试另一侧的地址（容器内 `proxy:9090`、宿主机 `127.0.0.1:9090`）
> 并把实际使用地址写进日志与页面，因此不会因为环境变量过期而直接不可用。

### 修改 `.env` 后必须重建容器

Compose 只在**创建**容器时读取 `env_file`，因此新增 `MIHOMO_*` 变量后必须重建 backend：

```bash
 docker compose up -d --build backend proxy    # 或 docker compose up -d --force-recreate backend
 docker compose exec backend env | grep MIHOMO # 确认变量已注入
```

## 本地（非 Docker）开发

`.env` 中把消费者地址指向宿主机映射端口即可：

```env
MIHOMO_MIXED_ADDR=127.0.0.1:7890
MIHOMO_CONTROLLER_URL=http://127.0.0.1:9090
```

`docker compose up -d proxy` 已把 `7890` / `9090` 绑定到 `127.0.0.1`，因此宿主机上的
后端进程可以直接访问。Windows 上可用 `curl -x http://127.0.0.1:7890 http://www.gstatic.com/generate_204`
验证混合端口是否可用作 HTTP 代理。

## 安全说明

- 管理接口全部挂在 `RequireAdmin` 之下，仅管理员可用。
- 订阅下载默认拒绝内网 / 环回地址，避免管理员权限被用于探测内网（可用
  `MIHOMO_ALLOW_PRIVATE_SUBSCRIPTION=true` 显式放开）。
- 内核的 mixed 端口只发布到宿主机 `127.0.0.1`，不会暴露到局域网。
- 生产环境请把 `MIHOMO_CONTROLLER_SECRET` 设为随机串：它通过
  `CLASH_OVERRIDE_SECRET` 传给内核，因此重启后依然生效。

## 常见问题

### 页面提示“内核离线”

页面会直接显示失败原因（控制器地址 + 已经尝试过的全部地址 + dial 错误），按下面顺序排查：

```bash
# 1. 容器是否真的在跑、控制器端口是否监听（healthcheck 会直接反映这一点）
docker compose ps proxy          # 期望：Up (healthy)
docker compose logs --tail=50 proxy

# 2. 从容器内部直接问内核要版本（返回 {"meta":true,"version":"..."} 即正常）
docker compose exec proxy wget -qO- http://127.0.0.1:9090/version

# 3. 后端实际用了哪个地址、报了什么错
docker compose logs --tail=100 backend | grep 'proxy:'
```

日志里 `proxy: 代理内核不可用: ...` 会列出后端尝试的所有地址；`proxy: 代理内核已连接
version=... controller=...` 表示已恢复。如果 `docker compose ps` 显示容器是
`Up (unhealthy)`，说明 9090 端口没有在监听，通常是 `command` 里的 `-ext-ctl` 被覆盖或容器是用旧的
`docker-compose.yml` 创建的 —— 执行 `docker compose up -d --force-recreate proxy` 即可。

### 其他

| 现象 | 处理 |
| --- | --- |
| 页面提示“内核离线” | 见上一节；页面会显示真实错误与尝试过的地址 |
| “内核在线”但 AI/邮箱仍直连 | 页面会同时提示“后端无法连接代理入口”，按提示修正 `MIHOMO_MIXED_ADDR` 后重建 backend |
| 导入成功但节点为空 | 如果订阅基于 `proxy-providers`，节点由内核联网拉取，需先启动内核；错误提示里会带上识别到的格式与内容片段 |
| 连接成功但 WhatsApp 仍然直连 | 打开 WhatsApp 开关后会自动重启会话；若仍失败请重启该员工账号 |
| 邮箱打不开 | 邮箱走 SOCKS5（内核 mixed 端口）。关闭邮箱开关即可恢复直连 |
| 切换节点无效果 | 节点必须属于 `PROXY` 分组；测速超时的节点切换后依然不可用 |
| 想重置内核状态 | `docker compose down proxy && docker volume rm yaerp2.0_mihomo_config`，然后重新导入订阅 |
