export type MakerWorldPlate = {
  index?: number;
  name?: string;
  prediction?: number | string;
  filaments?: Array<{ type?: string; color?: string }>;
};

export type MakerWorldModelInfo = {
  compatibility?: { devProductName?: string };
  plates?: MakerWorldPlate[];
};

export type MakerWorldInstance = {
  id?: number | string;
  profileId?: number | string;
  title?: string;
  extention?: {
    modelInfo?: MakerWorldModelInfo;
    otherCompatibilityModelInfo?: Array<{
      id?: number | string;
      profileId?: number | string;
      modelInfo?: MakerWorldModelInfo;
    }>;
  };
};

export type MakerWorldDesign = {
  title?: string;
  defaultInstanceId?: number | string;
  instances?: MakerWorldInstance[];
};

export type MakerWorldFetchAttempt = {
  source: "official" | "proxy";
  url: string;
  method: "GET";
  requestHeaders: Record<string, string>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timeoutMs: number;
  reason: string;
  referenceId?: string;
  error: unknown;
  response?: MakerWorldHttpResponseLog;
};

export type MakerWorldHttpResponseLog = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyLength: number;
  body: string;
  bodyTruncated: boolean;
};

export type MakerWorldFetchOptions = {
  officialTimeoutMs?: number;
  proxyTimeoutMs?: number;
};

class MakerWorldAttemptError extends Error {
  attempt: MakerWorldFetchAttempt;

  constructor(attempt: MakerWorldFetchAttempt) {
    super(attempt.reason);
    this.name = "MakerWorldAttemptError";
    this.attempt = attempt;
  }
}

class MakerWorldTimeoutError extends Error {
  timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`请求在 ${timeoutMs}ms 内未完成，已主动中止`);
    this.name = "MakerWorldTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

class MakerWorldResponseError extends Error {
  response: MakerWorldHttpResponseLog;

  constructor(message: string, response: MakerWorldHttpResponseLog, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MakerWorldResponseError";
    this.response = response;
  }
}

export class MakerWorldFetchError extends Error {
  code = "MAKERWORLD_FETCH_FAILED" as const;
  attempts: MakerWorldFetchAttempt[];

  constructor(attempts: MakerWorldFetchAttempt[]) {
    super(`MakerWorld 结构化数据读取失败：${attempts.map((attempt) => `${attempt.source === "official" ? "官方接口" : "备用接口"} ${attempt.url}：${attempt.reason}`).join("；")}`);
    this.name = "MakerWorldFetchError";
    this.attempts = attempts;
  }
}

function isMakerWorldDesign(value: unknown): value is MakerWorldDesign {
  return Boolean(value && typeof value === "object" && Array.isArray((value as MakerWorldDesign).instances));
}

function serializeDiagnosticValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= 6) return `[MaxDepth:${value.constructor?.name || "Object"}]`;
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.toString();
  if (Array.isArray(value)) return value.map((item) => serializeDiagnosticValue(item, seen, depth + 1));

  const output: Record<string, unknown> = {
    type: value.constructor?.name || Object.prototype.toString.call(value),
  };
  for (const key of Object.getOwnPropertyNames(value)) {
    try {
      output[key] = serializeDiagnosticValue((value as Record<string, unknown>)[key], seen, depth + 1);
    } catch (propertyError) {
      output[key] = `[读取属性失败: ${propertyError instanceof Error ? propertyError.message : String(propertyError)}]`;
    }
  }
  return output;
}

export function serializeErrorForDiagnostics(error: unknown) {
  return serializeDiagnosticValue(error, new WeakSet<object>(), 0);
}

function responseLog(response: Response, body: string): MakerWorldHttpResponseLog {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    bodyLength: body.length,
    body,
    bodyTruncated: false,
  };
}

export function parseMakerWorldProxyDocument(document: string) {
  const marker = "Markdown Content:";
  const markerIndex = document.indexOf(marker);
  let payload = markerIndex >= 0 ? document.slice(markerIndex + marker.length).trim() : document.trim();
  if (payload.startsWith("```")) {
    payload = payload.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  }
  try {
    const design = JSON.parse(payload) as unknown;
    return isMakerWorldDesign(design) ? design : null;
  } catch {
    return null;
  }
}

function describeFetchError(error: unknown) {
  if (error instanceof MakerWorldTimeoutError) return error.message;
  if (error instanceof Error) {
    const cause = error.cause && typeof error.cause === "object" ? error.cause as { code?: unknown; message?: unknown } : null;
    const causeParts = [cause?.code, cause?.message].filter(Boolean).map(String);
    return `${error.name}: ${error.message}${causeParts.length ? `（底层原因：${causeParts.join(" / ")}）` : ""}`;
  }
  return String(error);
}

async function runWithTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new MakerWorldTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchOfficialDesign(apiUrl: string, timeoutMs: number, fetcher: typeof fetch) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const requestHeaders = { Accept: "application/json" };
  try {
    return await runWithTimeout(timeoutMs, async (signal) => {
      const response = await fetcher(apiUrl, { headers: requestHeaders, signal });
      const body = await response.text();
      const responseDetails = responseLog(response, body);
      if (!response.ok) {
        throw new MakerWorldResponseError(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`, responseDetails);
      }
      let design: unknown;
      try {
        design = JSON.parse(body) as unknown;
      } catch (error) {
        throw new MakerWorldResponseError(`HTTP 200，但响应不是有效 JSON：${describeFetchError(error)}；Content-Type=${response.headers.get("content-type") || "未提供"}`, responseDetails, error);
      }
      if (!isMakerWorldDesign(design)) throw new MakerWorldResponseError("HTTP 200 且 JSON 可解析，但缺少 instances 数组", responseDetails);
      return design;
    });
  } catch (error) {
    const finishedAtMs = Date.now();
    const reason = describeFetchError(error);
    const referenceId = reason.match(/reference\s*=\s*([a-z0-9_-]+)/i)?.[1];
    throw new MakerWorldAttemptError({
      source: "official",
      url: apiUrl,
      method: "GET",
      requestHeaders,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      timeoutMs,
      reason,
      ...(referenceId ? { referenceId } : {}),
      error: serializeErrorForDiagnostics(error),
      ...(error instanceof MakerWorldResponseError ? { response: error.response } : {}),
    });
  }
}

async function fetchProxyDesign(apiUrl: string, timeoutMs: number, fetcher: typeof fetch) {
  // Cloudflare Workers can reject the otherwise valid api.bambulab.cn chain with
  // "unable to get local issuer certificate". The proxy connection stays HTTPS;
  // only its public upstream URL starts as HTTP and follows Bambu's own HTTPS redirect.
  const proxyUpstreamUrl = apiUrl.startsWith("https://api.bambulab.cn/")
    ? apiUrl.replace("https://", "http://")
    : apiUrl;
  const proxyUrl = `https://r.jina.ai/${proxyUpstreamUrl}`;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const requestHeaders = { Accept: "text/plain" };
  try {
    return await runWithTimeout(timeoutMs, async (signal) => {
      const response = await fetcher(proxyUrl, { headers: requestHeaders, signal });
      const document = await response.text();
      const responseDetails = responseLog(response, document);
      if (!response.ok) {
        throw new MakerWorldResponseError(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`, responseDetails);
      }
      const contentType = response.headers.get("content-type") || "未提供";
      const design = parseMakerWorldProxyDocument(document);
      if (!design) throw new MakerWorldResponseError(`HTTP 200，但响应无法解析为 MakerWorld JSON；Content-Type=${contentType}；响应长度=${document.length} 字符`, responseDetails);
      return design;
    });
  } catch (error) {
    const finishedAtMs = Date.now();
    const reason = describeFetchError(error);
    const referenceId = reason.match(/reference\s*=\s*([a-z0-9_-]+)/i)?.[1];
    throw new MakerWorldAttemptError({
      source: "proxy",
      url: proxyUrl,
      method: "GET",
      requestHeaders,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      timeoutMs,
      reason,
      ...(referenceId ? { referenceId } : {}),
      error: serializeErrorForDiagnostics(error),
      ...(error instanceof MakerWorldResponseError ? { response: error.response } : {}),
    });
  }
}

export async function fetchMakerWorldDesign(
  apiUrl: string,
  fetcher: typeof fetch = fetch,
  options: MakerWorldFetchOptions = {},
) {
  const attempts = [
    fetchOfficialDesign(apiUrl, options.officialTimeoutMs ?? 10000, fetcher),
    fetchProxyDesign(apiUrl, options.proxyTimeoutMs ?? 22000, fetcher),
  ];
  try {
    return await Promise.any(attempts);
  } catch (error) {
    const failures = error instanceof AggregateError
      ? error.errors.filter((failure): failure is MakerWorldAttemptError => failure instanceof MakerWorldAttemptError)
      : [];
    const details = failures.map((failure) => failure.attempt).sort((left, right) => left.source === "official" ? -1 : right.source === "official" ? 1 : 0);
    if (details.length) throw new MakerWorldFetchError(details);
    const now = new Date().toISOString();
    throw new MakerWorldFetchError([{
      source: "official",
      url: apiUrl,
      method: "GET",
      requestHeaders: { Accept: "application/json" },
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      timeoutMs: options.officialTimeoutMs ?? 10000,
      reason: describeFetchError(error),
      error: serializeErrorForDiagnostics(error),
    }]);
  }
}

type ProfileCandidate = {
  instanceId: number | null;
  profileId: number | null;
  compatibilityId: number | null;
  title: string;
  printer: string;
  modelInfo: MakerWorldModelInfo;
  primary: boolean;
};

function numericId(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function makerWorldApiHost(target: URL) {
  if (/(^|\.)makerworld\.com\.cn$/i.test(target.hostname)) return "api.bambulab.cn";
  if (/(^|\.)makerworld\.com$/i.test(target.hostname)) return "api.bambulab.com";
  return null;
}

export function requestedMakerWorldProfileId(target: URL) {
  const fragment = target.hash.match(/(?:^#|[&#])(?:profileId|instanceId)(?:-|=)(\d+)/i)?.[1];
  return numericId(fragment || target.searchParams.get("profileId") || target.searchParams.get("instanceId"));
}

function profileCandidates(design: MakerWorldDesign) {
  return (design.instances || []).flatMap((instance): ProfileCandidate[] => {
    const instanceId = numericId(instance.id);
    const primary = instance.extention?.modelInfo ? [{
      instanceId,
      profileId: numericId(instance.profileId),
      compatibilityId: null,
      title: instance.title || "默认打印配置",
      printer: instance.extention.modelInfo.compatibility?.devProductName || "默认设备",
      modelInfo: instance.extention.modelInfo,
      primary: true,
    }] : [];
    const compatible = (instance.extention?.otherCompatibilityModelInfo || [])
      .filter((profile): profile is typeof profile & { modelInfo: MakerWorldModelInfo } => Boolean(profile.modelInfo))
      .map((profile) => ({
        instanceId,
        profileId: numericId(profile.profileId),
        compatibilityId: numericId(profile.id),
        title: instance.title || "兼容打印配置",
        printer: profile.modelInfo.compatibility?.devProductName || "兼容设备",
        modelInfo: profile.modelInfo,
        primary: false,
      }));
    return [...primary, ...compatible];
  });
}

function selectProfile(design: MakerWorldDesign, requestedId: number | null) {
  const candidates = profileCandidates(design);
  if (requestedId) {
    // MakerWorld 分享链接里的 profileId 通常是页面 instance.id；API 内另有 profileId。
    // 先按页面实例匹配主配置，再兼容 API profileId 和兼容机型配置 ID。
    return candidates.find((candidate) => candidate.primary && candidate.instanceId === requestedId)
      || candidates.find((candidate) => candidate.profileId === requestedId || candidate.compatibilityId === requestedId)
      || null;
  }

  const defaultInstanceId = numericId(design.defaultInstanceId);
  return candidates.find((candidate) => candidate.primary && candidate.instanceId === defaultInstanceId)
    || candidates.find((candidate) => candidate.primary)
    || candidates[0]
    || null;
}

export class MakerWorldProfileNotFoundError extends Error {
  code = "MAKERWORLD_PROFILE_NOT_FOUND" as const;
  profileId: number;

  constructor(profileId: number) {
    super(`链接指定的打印配置（${profileId}）已失效或不存在，请从 MakerWorld 打印配置页面重新复制链接`);
    this.name = "MakerWorldProfileNotFoundError";
    this.profileId = profileId;
  }
}

export function parseMakerWorldDesign(design: MakerWorldDesign, target: URL) {
  const requestedId = requestedMakerWorldProfileId(target);
  const selected = selectProfile(design, requestedId);
  if (requestedId && !selected) throw new MakerWorldProfileNotFoundError(requestedId);

  const plates = (selected?.modelInfo.plates || []).filter((plate) => Number(plate.prediction) > 0);
  if (!design.title || !selected || !plates.length) return null;

  // prediction 的单位是秒。按最接近的整分钟保存，避免逐盘向上取整造成总时长虚高。
  const plateDurations = plates.map((plate) => Math.max(1, Math.round(Number(plate.prediction) / 60)));
  const plateNames = plates.map((plate, index) => plate.name?.trim() || `打印盘 ${plate.index || index + 1}`);
  const material = plates.flatMap((plate) => plate.filaments || []).find((filament) => filament.type)?.type || "PLA";

  return {
    project: {
      name: design.title,
      sourceUrl: target.toString(),
      plates: plates.length,
      durationMinutes: plateDurations.reduce((sum, minutes) => sum + minutes, 0),
      plateDurations,
      plateNames,
      splitByPlate: plates.length > 1,
      material,
      color: "自然色",
    },
    profile: {
      id: selected.profileId,
      instanceId: selected.instanceId,
      printer: selected.printer,
      title: selected.title,
    },
  };
}
