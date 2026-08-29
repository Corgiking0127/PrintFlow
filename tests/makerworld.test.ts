import assert from "node:assert/strict";
import test from "node:test";
import { MakerWorldDesign, MakerWorldFetchError, MakerWorldProfileNotFoundError, fetchMakerWorldDesign, makerWorldApiHost, parseMakerWorldDesign, parseMakerWorldProxyDocument } from "../lib/makerworld";

const design: MakerWorldDesign = {
  title: "多盘测试模型",
  defaultInstanceId: 222,
  instances: [
    {
      id: 111,
      profileId: 9001,
      title: "单盘配置",
      extention: {
        modelInfo: {
          compatibility: { devProductName: "P1S" },
          plates: [{ index: 1, name: "单盘", prediction: 3601, filaments: [{ type: "PLA" }] }],
        },
      },
    },
    {
      id: 222,
      profileId: 9002,
      title: "三盘配置",
      extention: {
        modelInfo: {
          compatibility: { devProductName: "X2D" },
          plates: [
            { index: 1, name: "底座", prediction: 1201 },
            { index: 2, name: "外壳", prediction: 1800 },
            { index: 3, name: "配件", prediction: 2399 },
          ],
        },
        otherCompatibilityModelInfo: [{
          id: 333,
          profileId: 9102,
          modelInfo: {
            compatibility: { devProductName: "A1" },
            plates: [{ index: 1, name: "A1 合盘", prediction: 5400 }],
          },
        }],
      },
    },
  ],
};

test("global and China MakerWorld links use their matching official API", () => {
  assert.equal(makerWorldApiHost(new URL("https://makerworld.com/en/models/123")), "api.bambulab.com");
  assert.equal(makerWorldApiHost(new URL("https://makerworld.com.cn/zh/models/123")), "api.bambulab.cn");
  assert.equal(makerWorldApiHost(new URL("https://example.com/models/123")), null);
});

test("structured API JSON can be recovered from the read-only proxy document", () => {
  const proxyDocument = [
    "Title: ",
    "",
    "URL Source: https://api.bambulab.com/v1/design-service/design/123",
    "",
    "Markdown Content:",
    JSON.stringify(design),
  ].join("\n");
  assert.deepEqual(parseMakerWorldProxyDocument(proxyDocument), design);
  assert.equal(parseMakerWorldProxyDocument("Markdown Content:\nnot-json"), null);
});

test("structured import falls back to the proxy when direct Bambu access is blocked", async () => {
  const requests: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("https://api.bambulab.com/")) return new Response("blocked", { status: 403 });
    return new Response(`Title: \n\nMarkdown Content:\n${JSON.stringify(design)}`);
  };
  const result = await fetchMakerWorldDesign(
    "https://api.bambulab.com/v1/design-service/design/123",
    fetcher as typeof fetch,
  );
  assert.deepEqual(result, design);
  assert.deepEqual(requests, [
    "https://api.bambulab.com/v1/design-service/design/123",
    "https://r.jina.ai/https://api.bambulab.com/v1/design-service/design/123",
  ]);
});

test("China fallback avoids the Worker TLS-chain failure without disabling verification", async () => {
  const requests: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("https://api.bambulab.cn/")) {
      throw new Error("kj/compat/tls.c++:269: failed: TLS peer's certificate is not trusted; reason = unable to get local issuer certificate");
    }
    return new Response(`Title: \n\nMarkdown Content:\n${JSON.stringify(design)}`);
  };
  const result = await fetchMakerWorldDesign(
    "https://api.bambulab.cn/v1/design-service/design/2875585",
    fetcher as typeof fetch,
  );
  assert.deepEqual(result, design);
  assert.deepEqual(requests, [
    "https://api.bambulab.cn/v1/design-service/design/2875585",
    "https://r.jina.ai/http://api.bambulab.cn/v1/design-service/design/2875585",
  ]);
});

test("failed imports report the exact HTTP failure for both data sources", async () => {
  const fetcher = async (input: string | URL | Request) => String(input).startsWith("https://r.jina.ai/")
    ? new Response("upstream unavailable", { status: 502, statusText: "Bad Gateway" })
    : new Response("forbidden", { status: 403, statusText: "Forbidden" });
  await assert.rejects(
    () => fetchMakerWorldDesign("https://api.bambulab.com/v1/design-service/design/123", fetcher as typeof fetch),
    (error: unknown) => {
      assert.ok(error instanceof MakerWorldFetchError);
      assert.deepEqual(error.attempts.map(({ source, reason }) => ({ source, reason })), [
        { source: "official", reason: "MakerWorldResponseError: HTTP 403 Forbidden" },
        { source: "proxy", reason: "MakerWorldResponseError: HTTP 502 Bad Gateway" },
      ]);
      assert.match(error.message, /api\.bambulab\.com.*HTTP 403 Forbidden/);
      assert.match(error.message, /r\.jina\.ai.*HTTP 502 Bad Gateway/);
      assert.equal(error.attempts[0].method, "GET");
      assert.equal(error.attempts[0].requestHeaders.Accept, "application/json");
      assert.equal(error.attempts[0].timeoutMs, 10000);
      assert.equal(typeof error.attempts[0].durationMs, "number");
      assert.equal(error.attempts[0].response?.status, 403);
      assert.equal(error.attempts[0].response?.body, "forbidden");
      assert.equal(error.attempts[0].response?.bodyTruncated, false);
      assert.match(JSON.stringify(error.attempts[0].error), /MakerWorldResponseError/);
      assert.match(JSON.stringify(error.attempts[0].error), /stack/);
      return true;
    },
  );
});

test("platform internal-error references and original stacks are preserved", async () => {
  const internalError = new Error("internal error; reference = sdv7v5jj4993ijt45e7rsqef");
  internalError.stack = "Error: internal error\n    at cloudflareFetch (worker.js:42:7)";
  const fetcher = async (input: string | URL | Request) => {
    if (!String(input).startsWith("https://r.jina.ai/")) throw internalError;
    return new Response("gateway timeout", { status: 504, statusText: "Gateway Timeout", headers: { "cf-ray": "test-ray" } });
  };
  await assert.rejects(
    () => fetchMakerWorldDesign("https://api.bambulab.cn/v1/design-service/design/2875585", fetcher as typeof fetch),
    (error: unknown) => {
      assert.ok(error instanceof MakerWorldFetchError);
      assert.equal(error.attempts[0].referenceId, "sdv7v5jj4993ijt45e7rsqef");
      assert.match(JSON.stringify(error.attempts[0].error), /cloudflareFetch/);
      assert.equal(error.attempts[1].response?.headers["cf-ray"], "test-ray");
      assert.equal(error.attempts[1].response?.body, "gateway timeout");
      return true;
    },
  );
});

test("stalled imports stop at configured deadlines and name both timeouts", async () => {
  const stalledFetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  await assert.rejects(
    () => fetchMakerWorldDesign(
      "https://api.bambulab.cn/v1/design-service/design/123",
      stalledFetch,
      { officialTimeoutMs: 10, proxyTimeoutMs: 15 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof MakerWorldFetchError);
      assert.deepEqual(error.attempts.map(({ source, reason }) => ({ source, reason })), [
        { source: "official", reason: "请求在 10ms 内未完成，已主动中止" },
        { source: "proxy", reason: "请求在 15ms 内未完成，已主动中止" },
      ]);
      return true;
    },
  );
});

test("timeouts also cover a response body that starts but never finishes", async () => {
  const stalledBodyFetch = (async () => new Response(new ReadableStream({ start() { /* intentionally left open */ } }))) as typeof fetch;
  await assert.rejects(
    () => fetchMakerWorldDesign(
      "https://api.bambulab.com/v1/design-service/design/123",
      stalledBodyFetch,
      { officialTimeoutMs: 10, proxyTimeoutMs: 15 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof MakerWorldFetchError);
      assert.match(error.attempts[0].reason, /10ms/);
      assert.match(error.attempts[1].reason, /15ms/);
      return true;
    },
  );
});

test("shared profileId fragment selects MakerWorld instance.id instead of the first profile", () => {
  const result = parseMakerWorldDesign(design, new URL("https://makerworld.com.cn/zh/models/123#profileId-222"));
  assert.ok(result);
  assert.equal(result.project.plates, 3);
  assert.deepEqual(result.project.plateDurations, [20, 30, 40]);
  assert.equal(result.project.durationMinutes, 90);
  assert.equal(result.profile.instanceId, 222);
  assert.equal(result.profile.id, 9002);
});

test("API profileId and compatibility profileId links remain supported", () => {
  const primary = parseMakerWorldDesign(design, new URL("https://makerworld.com/en/models/123?profileId=9001"));
  const compatible = parseMakerWorldDesign(design, new URL("https://makerworld.com/en/models/123#profileId-9102"));
  assert.equal(primary?.project.plates, 1);
  assert.equal(primary?.project.durationMinutes, 60);
  assert.equal(compatible?.project.plates, 1);
  assert.equal(compatible?.project.durationMinutes, 90);
  assert.equal(compatible?.profile.printer, "A1");
});

test("model-only links select defaultInstanceId rather than array order", () => {
  const result = parseMakerWorldDesign(design, new URL("https://makerworld.com/en/models/123"));
  assert.equal(result?.profile.instanceId, 222);
  assert.equal(result?.project.plates, 3);
});

test("unknown requested profile is rejected instead of silently using another profile", () => {
  assert.throws(
    () => parseMakerWorldDesign(design, new URL("https://makerworld.com/en/models/123#profileId-999999")),
    MakerWorldProfileNotFoundError,
  );
});

test("plate seconds are rounded to the nearest minute instead of always rounded up", () => {
  const result = parseMakerWorldDesign(design, new URL("https://makerworld.com/en/models/123#profileId-111"));
  assert.equal(result?.project.durationMinutes, 60);
});

test("Spring Gun V5 shared link selects its 4.3 hour, 2-plate default profile", () => {
  const springGun: MakerWorldDesign = {
    title: "Spring Gun V5 - Shoots fake bullets with magazine",
    defaultInstanceId: 1613981,
    instances: [
      {
        id: 1613981,
        profileId: 334226728,
        title: "Spring Gun V5",
        extention: {
          modelInfo: {
            compatibility: { devProductName: "P1S" },
            plates: [{ index: 1, prediction: 8075 }, { index: 2, prediction: 7391 }],
          },
        },
      },
      { id: 1614029, profileId: 332853185, title: "3x Bullets Bicolor", extention: { modelInfo: { plates: [{ index: 1, prediction: 1483 }] } } },
      { id: 1613990, profileId: 332843999, title: "Target with points", extention: { modelInfo: { plates: [{ index: 1, prediction: 4818 }, { index: 2, prediction: 3588 }] } } },
      { id: 2613719, profileId: 646582634, title: "PETG · A1 Mini", extention: { modelInfo: { plates: [{ index: 1, prediction: 8089 }, { index: 2, prediction: 7129 }] } } },
    ],
  };
  const result = parseMakerWorldDesign(
    springGun,
    new URL("https://makerworld.com/zh/models/1538231-spring-gun-v5-shoots-fake-bullets-with-magazine?from=search#profileId-1613981"),
  );
  assert.equal(springGun.instances?.length, 4);
  assert.equal(result?.profile.instanceId, 1613981);
  assert.equal(result?.project.plates, 2);
  assert.deepEqual(result?.project.plateDurations, [135, 123]);
  assert.equal(result?.project.durationMinutes, 258);
});
