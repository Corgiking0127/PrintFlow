# PrintFlow 部署指南

本文档覆盖 PrintFlow 云端站点和 X2D MQTT 局域网桥接器的生产部署。当前可直接发布的云端目标是 OpenAI Sites；站点运行时依赖 Cloudflare Workers 和 D1。

## 1. 发布前检查

环境要求：

- Node.js `>= 22.13.0`
- npm
- 已配置的 OpenAI Sites 项目
- `.openai/hosting.json` 中声明 D1 绑定 `DB`

安装依赖并完成检查：

```bash
npm ci
npm run lint
npm test
```

`npm test` 会执行完整部署构建和自动化测试。发布前还应确认：

- Git 工作区没有未提交的目标变更。
- 仓库中不存在 `.env`、LAN Access Code、Bark Key 或桥接明文凭证。
- `app/page.tsx` 不包含演示项目或伪造设备状态。
- 如果修改过 `db/schema.ts`，已经运行 `npm run db:generate` 并检查新增迁移。

## 2. Sites 生产发布

项目通过 `.openai/hosting.json` 绑定到既有 Sites 项目：

```json
{
  "project_id": "appgprj_6a918e14326c8191966cd99e24356210",
  "d1": "DB",
  "r2": null
}
```

推荐在 Codex 中从项目根目录发起发布：

> 使用 Sites 构建、保存新版本，并以私有访问方式部署当前 PrintFlow 项目。

标准发布流程会完成以下工作：

1. 构建 Cloudflare Worker 兼容产物。
2. 提交并推送与构建产物完全一致的源码版本。
3. 将 `dist/`、托管声明和 `drizzle/` 迁移打包为 Sites 版本。
4. 保存不可变版本。
5. 以 owner-only 私有访问策略发布。
6. 等待部署成功并返回生产 URL。

不要把 `dist/client` 当作纯静态站点单独上传；项目的 API、D1 和服务端渲染需要 Worker 运行时。

### 数据库迁移

数据库结构定义位于 `db/schema.ts`，迁移文件位于 `drizzle/`。修改结构后执行：

```bash
npm run db:generate
```

检查迁移中没有删除或覆盖用户数据的语句，再随站点版本一起发布。API 路由还会以 `CREATE TABLE IF NOT EXISTS` 方式保证基础表存在，但这不能代替正式迁移审查。

### 发布后验收

1. 打开生产 URL，完成 ChatGPT 私有站点登录。
2. 确认项目库为空时只显示空状态，不出现演示项目。
3. 导入一个真实 MakerWorld 链接，核对名称、盘数和每盘时间。
4. 切换整项目/逐盘排产，确认队列随之变化。
5. 配置 Bark Key 并发送测试通知。
6. 配置 X2D，启动桥接器，确认页面在 90 秒内显示在线状态。
7. 核对打印进度、层数、双喷嘴温度和 AMS 槽位数据。

## 3. MQTT 桥接器生产部署

桥接器必须运行在与 X2D 相同的局域网中。云端服务器无论部署在 Sites 还是阿里云，都不应直接暴露或穿透打印机 MQTT 端口。

### 网络要求

- 桥接主机可以访问打印机的 TCP `8883`。
- 桥接主机可以通过 HTTPS `443` 访问 PrintFlow 生产 URL。
- 不需要开放任何公网入站端口。
- 建议为打印机设置 DHCP 地址保留，避免局域网 IP 变化。

### 安装

在 PrintFlow“打印机”页面保存设备后，下载：

- `printflow-x2d.env`
- `printflow-x2d-bridge.mjs`

将文件保存到专用目录，例如 `/opt/printflow-bridge`，然后运行：

```bash
cd /opt/printflow-bridge
npm install mqtt
chmod 600 printflow-x2d.env
node --env-file=printflow-x2d.env printflow-x2d-bridge.mjs
```

### 使用 systemd 常驻运行

创建 `/etc/systemd/system/printflow-x2d-bridge.service`：

```ini
[Unit]
Description=PrintFlow X2D MQTT Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/printflow-bridge
ExecStart=/usr/bin/node --env-file=/opt/printflow-bridge/printflow-x2d.env /opt/printflow-bridge/printflow-x2d-bridge.mjs
Restart=always
RestartSec=5
User=printflow
Group=printflow

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now printflow-x2d-bridge
sudo systemctl status printflow-x2d-bridge
```

查看日志：

```bash
journalctl -u printflow-x2d-bridge -f
```

当局域网地址、LAN Access Code 或桥接凭证变化时，在 PrintFlow 中重新保存设备并下载新的 `.env`，替换旧文件后重启服务。

## 4. 备份与回滚

- 云端代码通过 Sites 的不可变版本回滚到上一成功版本。
- 数据库迁移应采用向前修复，不要在回滚代码时自动删除新表或新列。
- 发布重要结构变化前，通过平台提供的 D1 导出或快照能力备份生产数据。
- 桥接器更新前保留上一份脚本；`.env` 包含机密信息，不要提交到 Git 或放入普通备份共享目录。

## 5. 阿里云部署边界

当前仓库不是可直接运行在阿里云 ECS 普通 Node.js 进程中的版本，原因是 API 和数据库层使用 `cloudflare:workers`、Cloudflare D1 与 Sites 构建插件。直接运行 `dist/server/index.js` 或把静态文件上传 OSS，会导致 API、数据库和 MQTT 状态写入不可用。

若必须迁移到阿里云，需要先完成平台适配：

1. 将 D1/Drizzle D1 驱动替换为阿里云 RDS PostgreSQL 或 MySQL 驱动。
2. 将 `cloudflare:workers` 环境绑定改为普通服务器环境变量。
3. 将 vinext Cloudflare Worker 构建切换为受支持的 Node.js 服务端构建。
4. 把现有 D1 迁移转换为目标数据库迁移并执行数据迁移。
5. 在 SLB、ALB 或 Nginx 配置 HTTPS、访问控制和健康检查。
6. 保留局域网桥接器；不要让阿里云主机直接连接家庭或工作室内的 MQTT 服务。

在上述适配完成前，生产站点应继续部署到 Sites。阿里云可以承载未来的 Node.js/API 与 RDS 版本，但不应把当前 Worker 产物当作可直接部署包。

## 6. 故障排查

### 页面显示“桥接离线”

- 检查桥接服务是否运行。
- 检查打印机 IP、序列号和 LAN Access Code。
- 确认桥接主机可以访问打印机 `8883` 和站点 `443`。
- 如果重新保存过设备配置，必须替换 `.env` 中的一次性桥接凭证。

### 站点返回 401

- 访问网页时重新完成 ChatGPT 私有站点登录。
- 桥接器返回 401 时，在打印机设置页轮换凭证并重新下载 `.env`。

### 数据库接口失败

- 确认 `.openai/hosting.json` 的 D1 逻辑绑定仍为 `DB`。
- 确认最新版本包含全部 `drizzle/` 迁移。
- 不要在本地使用不带 Cloudflare 绑定的普通 Node 生产启动方式验证数据库 API；使用 `npm run dev` 或已部署的 Sites 环境。
