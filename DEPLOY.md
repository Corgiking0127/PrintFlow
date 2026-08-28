# PrintFlow 本地部署指南

PrintFlow 的推荐生产方式是把网页、API、D1 数据库和 X2D 云端 MQTT Adapter 部署到同一台设备。打印机保持拓竹云端模式，因此 Bambu Handy 可以继续使用。

## 1. 环境与网络

- Node.js `>= 22.13.0`
- npm
- macOS、Linux、NAS 或长期运行的 PC
- 国际区账号可访问 `api.bambulab.com:443` 和 `us.mqtt.bambulab.com:8883`
- 中国区账号可访问 `api.bambulab.cn:443` 和 `cn.mqtt.bambulab.com:8883`
- 主机可以通过 HTTPS `443` 访问 MakerWorld 与 Bark
- 局域网防火墙允许客户端访问 TCP `8082`
- 不需要开放任何公网入站端口

PrintFlow 主机不需要与打印机位于同一局域网，也不需要固定打印机 IP。

## 2. 首次安装

```bash
git clone <repository-url> /opt/printflow
cd /opt/printflow
npm ci
npm run lint
npm test
npm run local
```

启动日志会列出可用的局域网地址，例如 `http://192.168.1.50:8082`。在同一局域网的电脑或手机打开该地址；第一次启动时项目和打印机列表为空。

### 连接拓竹云端 MQTT

1. 确保 X2D 已在 Bambu Handy 中绑定，并保持 LAN Only 关闭。
2. 在 PrintFlow“打印机”页面选择国际区或中国区。
3. 中国区填写注册手机号，密码留空；国际区填写账号邮箱，可填写密码或使用验证码。
4. 点击账号旁的“获取验证码”，收到短信或邮件后填写验证码，再保存并连接。
5. 页面显示“云端已连接”后，实时状态会自动同步。

账号、密码和验证码仅用于当次登录，不会写入配置文件。Adapter 会保存 Access Token 供重启后继续连接；Token 失效后重新登录即可。云端 MQTT 是社区兼容协议，参考：<https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md>

## 3. 本地端口与持久化

| 项目 | 默认值 | 说明 |
| --- | --- | --- |
| PrintFlow 一体服务 | `0.0.0.0:8082` | 网页、API 与 Adapter 共用的局域网入口 |
| 拓竹云端 MQTT | `us.mqtt.bambulab.com:8883` 或 `cn.mqtt.bambulab.com:8883` | Adapter 主动连接云端 |
| 本地数据 | `.data/` | D1、Wrangler 状态与 Adapter 配置 |

可通过环境变量修改监听地址和端口：

```bash
PRINTFLOW_WEB_IP=0.0.0.0 PRINTFLOW_WEB_PORT=8082 npm run local:start
```

## 4. 使用 systemd 常驻运行

先完成构建：

```bash
cd /opt/printflow
npm ci
npm run build
```

创建专用账户并确保其拥有项目及 `.data` 目录：

```bash
sudo useradd --system --home /opt/printflow --shell /usr/sbin/nologin printflow
sudo mkdir -p /opt/printflow/.data
sudo chown -R printflow:printflow /opt/printflow
```

创建 `/etc/systemd/system/printflow.service`：

```ini
[Unit]
Description=PrintFlow Local Web and X2D MQTT Adapter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/printflow
ExecStart=/usr/bin/npm run local:start
Restart=always
RestartSec=5
User=printflow
Group=printflow
Environment=PRINTFLOW_WEB_PORT=8082
Environment=PRINTFLOW_WEB_IP=0.0.0.0

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now printflow
sudo systemctl status printflow
```

查看日志：

```bash
journalctl -u printflow -f
```

## 5. 更新

```bash
cd /opt/printflow
sudo systemctl stop printflow
git pull --ff-only
npm ci
npm run lint
npm test
sudo systemctl start printflow
```

数据库迁移位于 `drizzle/`。修改 `db/schema.ts` 后必须运行 `npm run db:generate` 并检查迁移内容。

## 6. 备份与恢复

停止服务后备份整个 `.data/`：

```bash
sudo systemctl stop printflow
tar -czf printflow-data-backup.tar.gz -C /opt/printflow .data
sudo systemctl start printflow
```

`.data/printer-config.json` 包含拓竹 Access Token 和 PrintFlow 内部凭证，备份必须加密并限制访问。它不包含拓竹账号、密码或验证码。恢复时将 `.data/` 放回项目根目录，确认所有者为 `printflow:printflow` 后启动服务。

## 7. 阿里云边界

云端 MQTT 不要求服务器访问家庭或工作室局域网，因此 Adapter 可以运行在本机、NAS 或阿里云 ECS。若运行在远程服务器，必须使用专用账户、限制配置文件权限并加密备份，因为服务器会持有拓竹 Access Token。

当前 API 数据层使用 Cloudflare D1。若要把完整网页/API 迁移到阿里云 ECS 的普通 Node.js 服务，需要先把 D1 驱动替换为 RDS PostgreSQL/MySQL，并调整 Worker 构建；当前本地一体模式不需要这项迁移。

## 8. 故障排查

### 页面显示“Adapter 离线”

- 必须使用 `npm run local` 或 `npm run local:start`，而不是只运行 `npm run dev`。
- 确认局域网地址使用的是 PrintFlow 服务器 IP，而不是访问设备的 IP。
- 确认防火墙允许访问 TCP `8082`。

### Adapter 一直显示“正在连接”

- 确认账号区域正确：中国区与国际区不能混用。
- 确认序列号属于当前拓竹账号的已绑定设备。
- 确认 LAN Only 已关闭，打印机在 Bambu Handy 中显示在线。
- 检查主机能否访问对应 API 的 `443` 和 MQTT 的 `8883`。
- 若提示认证失败或 Token 过期，在设置页重新输入账号密码登录。

### 数据库接口失败

- 确认使用 `wrangler.local.jsonc` 启动本地 Worker。
- 确认服务账户可以读写 `.data/`。
- 确认构建产物包含 `dist/server/index.js` 和 `dist/client/`。
