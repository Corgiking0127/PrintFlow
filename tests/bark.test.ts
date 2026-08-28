import assert from "node:assert/strict";
import test from "node:test";
import { buildBarkPushUrl, normalizeBarkEndpoint } from "../lib/bark";

test("Bark push URL defaults to the official endpoint", () => {
  const url = buildBarkPushUrl({ key: "AbCdEf123456", title: "换盘提醒", body: "第 2 盘" });

  assert.equal(url.origin, "https://api.day.app");
  assert.equal(decodeURIComponent(url.pathname), "/AbCdEf123456/换盘提醒/第 2 盘");
  assert.equal(url.searchParams.get("group"), "PrintFlow");
});

test("Bark push URL supports custom endpoints and nested base paths", () => {
  const url = buildBarkPushUrl({ endpoint: "http://bark.lan:8080/push/", key: "custom_key", title: "Test", body: "Ready" });

  assert.equal(url.origin, "http://bark.lan:8080");
  assert.equal(url.pathname, "/push/custom_key/Test/Ready");
});

test("Bark endpoint accepts a hostname and assumes HTTPS", () => {
  assert.equal(normalizeBarkEndpoint("bark.example.com/notify/"), "https://bark.example.com/notify");
});

test("Bark endpoint rejects unsupported protocols and URL parameters", () => {
  assert.throws(() => normalizeBarkEndpoint("file:///tmp/bark"), /HTTP/);
  assert.throws(() => normalizeBarkEndpoint("https://bark.example.com?token=secret"), /查询参数/);
});
