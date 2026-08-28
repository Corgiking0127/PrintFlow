import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildConfiguration } from "../local/adapter-service.mjs";

const localAdapter = readFileSync(new URL("../local/adapter-service.mjs", import.meta.url), "utf8");
const standaloneAdapter = readFileSync(new URL("../public/printflow-x2d-bridge.mjs", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("integrated adapter uses the Bambu cloud MQTT brokers with verified TLS", () => {
  assert.match(localAdapter, /us\.mqtt\.bambulab\.com/);
  assert.match(localAdapter, /cn\.mqtt\.bambulab\.com/);
  assert.match(localAdapter, /username: `u_\$\{next\.userId\}`/);
  assert.match(localAdapter, /rejectUnauthorized: true/);
  assert.doesNotMatch(localAdapter, /username: "bblp"/);
  assert.doesNotMatch(localAdapter, /rejectUnauthorized: false/);
});

test("printer settings no longer require LAN-only credentials", () => {
  assert.doesNotMatch(pageSource, /LAN Access Code/);
  assert.doesNotMatch(pageSource, /局域网地址/);
  assert.match(pageSource, /拓竹账号密码/);
  assert.match(pageSource, /Bambu Handy 可继续使用/);
});

test("standalone adapter also uses cloud credentials", () => {
  assert.match(standaloneAdapter, /BAMBU_USER_ID/);
  assert.match(standaloneAdapter, /BAMBU_ACCESS_TOKEN/);
  assert.doesNotMatch(standaloneAdapter, /PRINTER_ACCESS_CODE/);
  assert.doesNotMatch(standaloneAdapter, /PRINTER_HOST/);
});

test("cloud token is resolved to a user id and checked against bound printers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/design-user-service/my/preference")) {
      return Response.json({ uid: 123456789 });
    }
    if (url.endsWith("/v1/iot-service/api/user/bind")) {
      return Response.json({ devices: [{ dev_id: "X2D123456" }] });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  try {
    const config = await buildConfiguration({
      name: "X2D 工作站",
      serial: "X2D123456",
      region: "global",
      accessToken: "a".repeat(32),
      siteUrl: "http://localhost:8082",
      printerId: "printer-1",
      bridgeToken: "bridge-token",
      adapter: "bambu-x2d-ams2pro",
    });
    assert.equal(config.userId, "123456789");
    assert.equal(config.accessToken, "a".repeat(32));
    assert.equal(config.region, "global");
    assert.equal("account" in config, false);
    assert.equal("password" in config, false);
    assert.equal("verificationCode" in config, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("email verification is surfaced without persisting a password", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ loginType: "verifyCode" });
  try {
    await assert.rejects(() => buildConfiguration({
      name: "X2D 工作站",
      serial: "X2D123456",
      region: "global",
      account: "owner@example.com",
      password: "not-saved",
      siteUrl: "http://localhost:8082",
      printerId: "printer-1",
      bridgeToken: "bridge-token",
      adapter: "bambu-x2d-ams2pro",
    }), /邮箱验证码/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
