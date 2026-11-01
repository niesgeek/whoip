import { COMMON_HEADERS } from "./edge.js";

export const WHOIS_PREFIX = "/api/whois";
const MAX_BODY = 1_000_000;

function jsonError(status, code, message, query = "") {
  const headers = {
    ...COMMON_HEADERS,
    "content-type": "application/json; charset=utf-8",
  };
  if (status === 405) headers.allow = "GET, HEAD, OPTIONS";
  return new Response(JSON.stringify({ error: { code, message, query } }), { status, headers });
}

export function cleanDomain(raw) {
  let value = String(raw || "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      /* keep the original text and let the checks below reject it */
    }
  }
  value = value.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
  try {
    value = value.normalize("NFC");
  } catch {
    /* normalize is optional */
  }
  return value;
}

export function isDomainish(value) {
  if (!value || value.length > 253 || !value.includes(".")) return false;
  if (value.includes("..") || value.startsWith(".") || value.startsWith("-") || value.endsWith("-")) return false;
  if (/[\s\\@/?#:%]/.test(value)) return false;
  return /^[\p{L}\p{N}][\p{L}\p{N}.-]*[\p{L}\p{N}]$/u.test(value);
}

export function parseWhoisTarget(requestUrl) {
  const url = new URL(requestUrl);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== WHOIS_PREFIX && !path.startsWith(`${WHOIS_PREFIX}/`)) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "未知路径" };
  }
  let rest = "";
  try {
    rest = decodeURIComponent(path.slice(WHOIS_PREFIX.length)).replace(/^\/+/, "");
  } catch {
    return { ok: false, status: 400, code: "INVALID_DOMAIN", message: "域名路径无法解码" };
  }
  if (rest.includes("/")) {
    return { ok: false, status: 400, code: "INVALID_DOMAIN", message: "域名路径不合法" };
  }
  if (!rest) {
    const domains = (url.searchParams.get("domains") || "")
      .split(",")
      .map((item) => cleanDomain(item))
      .filter(Boolean);
    if (!domains.length) {
      return { ok: false, status: 400, code: "INVALID_DOMAIN", message: "缺少域名" };
    }
    if (domains.length > 10) {
      return { ok: false, status: 400, code: "INVALID_DOMAIN", message: "一次最多 10 个域名" };
    }
    if (domains.some((item) => !isDomainish(item))) {
      return { ok: false, status: 400, code: "INVALID_DOMAIN", message: "域名格式不正确" };
    }
    return { ok: true, kind: "multi", domains };
  }
  const domain = cleanDomain(rest);
  if (!isDomainish(domain)) {
    return { ok: false, status: 400, code: "INVALID_DOMAIN", message: "域名格式不正确" };
  }
  return { ok: true, kind: "one", domain, raw: url.searchParams.get("raw") === "true" };
}

export function whoisUpstreamUrl(base, target) {
  const root = String(base || "").trim().replace(/\/+$/, "");
  if (!root) return "";
  if (target.kind === "multi") {
    return `${root}/multi?domains=${encodeURIComponent(target.domains.join(","))}`;
  }
  const query = target.raw ? "?raw=true" : "";
  return `${root}/v1/whois/${encodeURIComponent(target.domain)}${query}`;
}

export async function handleWhoisRequest(request, env, fetchImpl = globalThis.fetch) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...COMMON_HEADERS,
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "*",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, "METHOD_NOT_ALLOWED", "method not allowed");
  }

  const target = parseWhoisTarget(request.url);
  if (!target.ok) return jsonError(target.status, target.code, target.message, "");

  const base = String(env?.WHOIS_API_BASE || "").trim();
  if (!base) return jsonError(503, "NOT_CONFIGURED", "WHOIS API 未配置。请设置环境变量 WHOIS_API_BASE。");
  let upstream;
  try {
    upstream = new URL(whoisUpstreamUrl(base, target));
  } catch {
    return jsonError(500, "INTERNAL_ERROR", "WHOIS_API_BASE 不是合法 URL");
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    return jsonError(500, "INTERNAL_ERROR", "WHOIS_API_BASE 只接受 http 或 https");
  }

  const headers = { accept: target.raw ? "*/*" : "application/json", "user-agent": "WhoIP/whois-proxy" };
  if (env?.WHOIS_API_KEY) headers.authorization = `Bearer ${env.WHOIS_API_KEY}`;

  let response;
  try {
    response = await fetchImpl(upstream, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return jsonError(502, "UPSTREAM_ERROR", "连不上 WHOIS API", target.domain || target.domains?.join(",") || "");
  }
  if (response.status >= 300 && response.status < 400) {
    return jsonError(502, "UPSTREAM_ERROR", "WHOIS API 返回了重定向，已拒绝跟随");
  }

  const buf = await response.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return jsonError(502, "UPSTREAM_ERROR", "WHOIS API 响应过大");
  const type = response.headers.get("content-type") || "application/json; charset=utf-8";
  return new Response(request.method === "HEAD" ? null : buf, {
    status: response.status,
    headers: {
      ...COMMON_HEADERS,
      "content-type": type,
    },
  });
}
