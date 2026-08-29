const DEFAULT_TIMEOUT_MS = 10_000;

class MakerWorldGatewayError extends Error {
  constructor(message, code, status, attempt) {
    super(message);
    this.name = "MakerWorldGatewayError";
    this.code = code;
    this.status = status;
    this.attempt = attempt;
  }
}

function serializeError(error, seen = new WeakSet(), depth = 0) {
  if (error === null || error === undefined || ["string", "number", "boolean"].includes(typeof error)) return error;
  if (typeof error !== "object") return String(error);
  if (seen.has(error)) return "[Circular]";
  if (depth >= 6) return `[MaxDepth:${error.constructor?.name || "Object"}]`;
  seen.add(error);
  if (Array.isArray(error)) return error.map((item) => serializeError(item, seen, depth + 1));
  const result = { type: error.constructor?.name || "Object" };
  for (const key of Object.getOwnPropertyNames(error)) {
    try {
      result[key] = serializeError(error[key], seen, depth + 1);
    } catch (propertyError) {
      result[key] = `[读取属性失败: ${propertyError instanceof Error ? propertyError.message : String(propertyError)}]`;
    }
  }
  return result;
}

function officialApiUrl(pageUrl) {
  const target = new URL(pageUrl);
  const designId = target.pathname.match(/\/models\/(\d+)/)?.[1];
  if (!designId) throw new Error(`链接路径 ${target.pathname} 中未找到 /models/<数字模型ID>`);
  let apiHost = null;
  if (/(^|\.)makerworld\.com\.cn$/i.test(target.hostname)) apiHost = "api.bambulab.cn";
  if (/(^|\.)makerworld\.com$/i.test(target.hostname)) apiHost = "api.bambulab.com";
  if (!apiHost) throw new Error(`不支持的 MakerWorld 域名：${target.hostname}`);
  return `https://${apiHost}/v1/design-service/design/${designId}`;
}

function failureDetails(error) {
  if (error?.name === "AbortError" || error?.code === "PRINTFLOW_TIMEOUT") {
    return { failureType: "timeout", code: "MAKERWORLD_UPSTREAM_TIMEOUT", status: 504 };
  }
  if (error?.response) {
    return {
      failureType: error.response.ok ? "payload" : "http",
      code: error.response.ok ? "MAKERWORLD_INVALID_RESPONSE" : "MAKERWORLD_UPSTREAM_HTTP_ERROR",
      status: 502,
    };
  }
  return { failureType: "network", code: "MAKERWORLD_NETWORK_ERROR", status: 502 };
}

export async function fetchMakerWorldForLocalGateway(pageUrl, fetcher = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const apiUrl = officialApiUrl(pageUrl);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const requestHeaders = { Accept: "application/json" };
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const timeoutError = Object.assign(new Error(`请求在 ${timeoutMs}ms 内未完成，已主动中止`), { code: "PRINTFLOW_TIMEOUT" });
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  let responseLog;

  try {
    return await Promise.race([(async () => {
      const response = await fetcher(apiUrl, { headers: requestHeaders, signal: controller.signal });
      const body = await response.text();
      responseLog = {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        bodyLength: body.length,
        body,
        bodyTruncated: false,
        ok: response.ok,
      };
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`), { response: responseLog });
      let design;
      try {
        design = JSON.parse(body);
      } catch (cause) {
        throw Object.assign(new Error(`HTTP 200，但响应不是有效 JSON：${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`), { response: responseLog, cause });
      }
      if (!design || typeof design !== "object" || !Array.isArray(design.instances)) {
        throw Object.assign(new Error("HTTP 200 且 JSON 可解析，但缺少 instances 数组"), { response: responseLog });
      }
      return { apiUrl, design };
    })(), deadline]);
  } catch (caughtError) {
    const error = controller.signal.aborted && controller.signal.reason ? controller.signal.reason : caughtError;
    const finishedAtMs = Date.now();
    const classification = failureDetails(error);
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const attempt = {
      source: "official",
      failureType: classification.failureType,
      url: apiUrl,
      method: "GET",
      requestHeaders,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      timeoutMs,
      reason,
      error: serializeError(error),
      ...(responseLog ? { response: responseLog } : {}),
    };
    throw new MakerWorldGatewayError(`MakerWorld 官方结构化接口读取失败：${apiUrl}：${reason}`, classification.code, classification.status, attempt);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function makerWorldGatewayErrorPayload(error, requestId, startedAtMs) {
  const finishedAtMs = Date.now();
  if (error instanceof MakerWorldGatewayError) {
    const errorLog = {
      requestId,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      runtime: { userAgent: `Node.js ${process.version}`, executionPath: "integrated-local-gateway" },
      request: { method: "POST", endpoint: "/api/import" },
      error: serializeError(error),
      attempts: [error.attempt],
    };
    return {
      status: error.status,
      body: { error: error.message, code: error.code, attempts: [error.attempt], errorLog },
    };
  }
  const errorLog = {
    requestId,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    runtime: { userAgent: `Node.js ${process.version}`, executionPath: "integrated-local-gateway" },
    request: { method: "POST", endpoint: "/api/import" },
    error: serializeError(error),
    attempts: [],
  };
  return {
    status: 400,
    body: { error: error instanceof Error ? error.message : String(error), code: "MAKERWORLD_IMPORT_INVALID_REQUEST", errorLog },
  };
}
