# PrintFlow X2D 独立云端 MQTT Adapter

本地部署请直接在项目根目录运行 `npm run local`，网页与云端 MQTT Adapter 会一体启动，通常不需要独立脚本。

需要分离运行时可使用 `public/printflow-x2d-bridge.mjs`。它连接拓竹云端 MQTT，不要求与打印机处于同一局域网。`.env` 需要以下字段：

```dotenv
BAMBU_REGION=global
BAMBU_USER_ID=123456789
BAMBU_ACCESS_TOKEN=your_access_token
PRINTER_SERIAL=your_printer_serial
PRINTER_ADAPTER=bambu-x2d-ams2pro
PRINTFLOW_SITE_URL=https://your-printflow-site.example
PRINTFLOW_PRINTER_ID=your_printflow_printer_id
PRINTFLOW_BRIDGE_TOKEN=your_printflow_bridge_token
```

`BAMBU_REGION` 可设为 `global` 或 `china`。Access Token 和 User ID 可通过拓竹云端登录与账号偏好接口取得；协议参考 <https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md>。

安装 `mqtt` 后，使用 Node.js 22 运行：

```bash
node --env-file=.env printflow-x2d-bridge.mjs
```

Adapter 只订阅 `device/{serial}/report`，并将状态发送到 PrintFlow 的 `/api/printers/ingest`。`.env` 包含高敏感 Token，必须设置为仅服务账户可读且不得提交到 Git。
