import assert from "node:assert/strict";
import test from "node:test";
import { fetchMakerWorldForLocalGateway, makerWorldGatewayErrorPayload } from "../local/makerworld-import.mjs";

const design = { title: "大陆站两盘模型", defaultInstanceId: 22, instances: [{ id: 22, extention: { modelInfo: { plates: [{ prediction: 1200 }, { prediction: 1800 }] } } }] };

test("integrated gateway fetches a China model directly from the matching official API", async () => {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify(design), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const result = await fetchMakerWorldForLocalGateway("https://makerworld.com.cn/zh/models/2875585", fetcher);
  assert.deepEqual(result.design, design);
  assert.deepEqual(requests, ["https://api.bambulab.cn/v1/design-service/design/2875585"]);
});

test("integrated gateway never starts a fallback request", async () => {
  let requestCount = 0;
  const fetcher = (async () => {
    requestCount += 1;
    throw Object.assign(new Error("unable to get local issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" });
  }) as typeof fetch;

  await assert.rejects(
    () => fetchMakerWorldForLocalGateway("https://makerworld.com.cn/zh/models/2875585", fetcher),
    (error: unknown) => {
      const failure = makerWorldGatewayErrorPayload(error, "test-request", Date.now());
      assert.equal(failure.status, 502);
      assert.equal(failure.body.code, "MAKERWORLD_NETWORK_ERROR");
      assert.equal(failure.body.attempts.length, 1);
      assert.equal(failure.body.attempts[0].url, "https://api.bambulab.cn/v1/design-service/design/2875585");
      assert.match(JSON.stringify(failure.body.errorLog), /UNABLE_TO_GET_ISSUER_CERT_LOCALLY/);
      return true;
    },
  );
  assert.equal(requestCount, 1);
});

test("integrated gateway timeout covers a fetcher that ignores abort", async () => {
  const stalledFetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  await assert.rejects(
    () => fetchMakerWorldForLocalGateway("https://makerworld.com/en/models/123", stalledFetch, 10),
    (error: unknown) => {
      const failure = makerWorldGatewayErrorPayload(error, "timeout-request", Date.now());
      assert.equal(failure.status, 504);
      assert.equal(failure.body.code, "MAKERWORLD_UPSTREAM_TIMEOUT");
      assert.equal(failure.body.attempts[0].failureType, "timeout");
      return true;
    },
  );
});
