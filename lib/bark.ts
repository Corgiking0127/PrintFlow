export const DEFAULT_BARK_ENDPOINT = "https://api.day.app";

export type BarkPushOptions = {
  endpoint?: string;
  key?: string;
  title?: string;
  body?: string;
};

export function normalizeBarkEndpoint(value?: string) {
  const input = value?.trim() || DEFAULT_BARK_ENDPOINT;
  const candidate = input.includes("://") ? input : `https://${input}`;
  const url = new URL(candidate);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Bark 端点仅支持 HTTP 或 HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Bark 端点不能包含账号或密码");
  }
  if (url.search || url.hash) {
    throw new Error("Bark 端点不能包含查询参数或锚点");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

export function normalizeBarkKey(value?: string) {
  const key = value?.trim().replace(/^https?:\/\/api\.day\.app\//, "").replace(/\/$/, "");
  if (!key || !/^[A-Za-z0-9_-]{6,}$/.test(key)) {
    throw new Error("请填写有效的 Bark Key");
  }
  return key;
}

export function buildBarkPushUrl(options: BarkPushOptions) {
  const endpoint = normalizeBarkEndpoint(options.endpoint);
  const key = normalizeBarkKey(options.key);
  const title = encodeURIComponent(options.title || "PrintFlow 测试通知");
  const body = encodeURIComponent(options.body || "Bark 已连接，打印提醒可以正常送达。");
  const url = new URL(`${endpoint}/${key}/${title}/${body}`);

  url.searchParams.set("group", "PrintFlow");
  url.searchParams.set("sound", "bell");
  url.searchParams.set("level", "timeSensitive");
  return url;
}
