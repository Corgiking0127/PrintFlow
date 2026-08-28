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
  constructor(profileId: number) {
    super(`链接指定的打印配置（${profileId}）已失效或不存在，请从 MakerWorld 打印配置页面重新复制链接`);
    this.name = "MakerWorldProfileNotFoundError";
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
