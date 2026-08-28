# PrintFlow X2D MQTT 桥接器

桥接器运行在与打印机同一局域网的 Mac、PC 或 NAS 上，只订阅设备状态，并把标准化前的 MQTT 状态安全转发给 PrintFlow。打印机 LAN Access Code 只保存在本地 `.env`，不会上传到站点数据库。

1. 在 PrintFlow 的“打印机”页面保存设备配置。
2. 下载 `.env` 和 `printflow-x2d-bridge.mjs` 到同一文件夹。
3. 在该文件夹运行 `npm install mqtt`。
4. 使用 Node.js 22 运行 `node --env-file=.env printflow-x2d-bridge.mjs`。

桥接器会订阅 `device/{serial}/report`，并将状态发送到站点的 `/api/printers/ingest` 接口。云端仅保存桥接凭证的 SHA-256 摘要。
