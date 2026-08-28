import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildConfiguration } from "../local/adapter-service.mjs";

const localAdapter = readFileSync(new URL("../local/adapter-service.mjs", import.meta.url), "utf8");
const localStart = readFileSync(new URL("../local/start.mjs", import.meta.url), "utf8");
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
  assert.doesNotMatch(pageSource, /本地安全限制/);
  assert.doesNotMatch(pageSource, /仅限本地配置/);
  assert.doesNotMatch(pageSource, /adapter-note/);
  assert.doesNotMatch(pageSource, /127\.0\.0\.1/);
  assert.doesNotMatch(pageSource, /8790/);
  assert.match(pageSource, /\/api\/adapter\/status/);
  assert.match(pageSource, /\/api\/adapter\/configure/);
  assert.match(pageSource, /中国区支持注册手机号/);
  assert.match(pageSource, /手机号验证码登录可留空/);
  assert.match(pageSource, /Bambu Handy 可继续使用/);
});

test("LAN deployment exposes one same-origin PrintFlow service", () => {
  assert.match(localStart, /PRINTFLOW_WEB_IP \|\| "0\.0\.0\.0"/);
  assert.match(localStart, /\/api\/adapter\/status/);
  assert.match(localStart, /\/api\/adapter\/configure/);
  assert.match(localStart, /configureAdapter/);
  assert.doesNotMatch(localAdapter, /createServer/);
  assert.doesNotMatch(localAdapter, /PRINTFLOW_ADAPTER_PORT/);
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
      siteUrl: "https://printflow.example.com",
      printerId: "printer-1",
      bridgeToken: "bridge-token",
      adapter: "bambu-x2d-ams2pro",
    });
    assert.equal(config.userId, "123456789");
    assert.equal(config.accessToken, "a".repeat(32));
    assert.equal(config.region, "global");
    assert.equal(config.siteUrl, "https://printflow.example.com");
    assert.equal("account" in config, false);
    assert.equal("password" in config, false);
    assert.equal("verificationCode" in config, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("password login can request email verification without persisting a password", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body });
    if (url.endsWith("/v1/user-service/user/login")) return Response.json({ loginType: "verifyCode" });
    if (url.endsWith("/v1/user-service/user/sendemail/code")) return Response.json({ success: true });
    throw new Error(`unexpected request: ${url}`);
  };
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
    }), /验证码已发送到账号邮箱/);
    assert.deepEqual(requests.map(({ url, body }) => ({ path: new URL(url).pathname, body })), [
      { path: "/v1/user-service/user/login", body: { account: "owner@example.com", password: "not-saved" } },
      { path: "/v1/user-service/user/sendemail/code", body: { email: "owner@example.com", type: "codeLogin" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("China phone account requests an SMS code when the password is blank", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body });
    return Response.json({ success: true });
  };
  try {
    await assert.rejects(() => buildConfiguration({
      name: "X2D 工作站",
      serial: "X2D123456",
      region: "china",
      account: "13800138000",
      siteUrl: "http://localhost:8082",
      printerId: "printer-1",
      bridgeToken: "bridge-token",
      adapter: "bambu-x2d-ams2pro",
    }), /验证码已发送到账号手机/);
    assert.deepEqual(requests.map(({ url, body }) => ({ host: new URL(url).host, path: new URL(url).pathname, body })), [
      {
        host: "bambulab.cn",
        path: "/api/v1/user-service/user/sendsmscode",
        body: { phone: "13800138000", type: "codeLogin" },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("China phone verification code produces a token-only saved configuration", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/user-service/user/login")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { account: "13800138000", code: "654321" });
      return Response.json({ accessToken: "b".repeat(32), expiresIn: 3600 });
    }
    if (url.endsWith("/v1/design-user-service/my/preference")) return Response.json({ uid: 987654321 });
    if (url.endsWith("/v1/iot-service/api/user/bind")) return Response.json({ devices: [{ dev_id: "X2D123456" }] });
    throw new Error(`unexpected request: ${url}`);
  };
  try {
    const config = await buildConfiguration({
      name: "X2D 工作站",
      serial: "X2D123456",
      region: "china",
      account: "13800138000",
      verificationCode: "654321",
      siteUrl: "http://localhost:8082",
      printerId: "printer-1",
      bridgeToken: "bridge-token",
      adapter: "bambu-x2d-ams2pro",
    });
    assert.equal(config.userId, "987654321");
    assert.equal(config.accessToken, "b".repeat(32));
    assert.equal("account" in config, false);
    assert.equal("password" in config, false);
    assert.equal("verificationCode" in config, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
