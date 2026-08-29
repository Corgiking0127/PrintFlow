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
  reason: string;
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
  try {
    return await runWithTimeout(timeoutMs, async (signal) => {
      const response = await fetcher(apiUrl, { headers: { Accept: "application/json" }, signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      }
      let design: unknown;
      try {
        design = await response.json();
      } catch (error) {
        throw new Error(`HTTP 200，但响应不是有效 JSON：${describeFetchError(error)}；Content-Type=${response.headers.get("content-type") || "未提供"}`);
      }
      if (!isMakerWorldDesign(design)) throw new Error("HTTP 200 且 JSON 可解析，但缺少 instances 数组");
      return design;
    });
  } catch (error) {
    throw new MakerWorldAttemptError({ source: "official", url: apiUrl, reason: describeFetchError(error) });
  }
}

async function fetchProxyDesign(apiUrl: string, timeoutMs: number, fetcher: typeof fetch) {
  const proxyUrl = `https://r.jina.ai/${apiUrl}`;
  try {
    return await runWithTimeout(timeoutMs, async (signal) => {
      const response = await fetcher(proxyUrl, { headers: { Accept: "text/plain" }, signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      }
      const contentType = response.headers.get("content-type") || "未提供";
      const document = await response.text();
      const design = parseMakerWorldProxyDocument(document);
      if (!design) throw new Error(`HTTP 200，但响应无法解析为 MakerWorld JSON；Content-Type=${contentType}；响应长度=${document.length} 字符`);
      return design;
    });
  } catch (error) {
    throw new MakerWorldAttemptError({ source: "proxy", url: proxyUrl, reason: describeFetchError(error) });
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
    throw new MakerWorldFetchError(details.length ? details : [{ source: "official", url: apiUrl, reason: describeFetchError(error) }]);
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
