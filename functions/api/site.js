import { COMMON_HEADERS } from "../_lib/edge.js";

const PLACEHOLDER_EMAIL = "hello@example.com";

export function safeEmail(value) {
  const email = String(value || "").trim();
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return PLACEHOLDER_EMAIL;
  return email;
}

export function safeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function sitePayload(env = {}) {
  const url = safeHttpUrl(env.CONTACT_URL);
  return {
    brand: "WhoIP",
    contact: {
      email: safeEmail(env.CONTACT_EMAIL),
      url,
      urlLabel: String(env.CONTACT_URL_LABEL || "相关链接").trim().slice(0, 80) || "相关链接",
    },
    whoisConfigured: Boolean(String(env.WHOIS_API_BASE || "").trim()),
  };
}

export function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...COMMON_HEADERS,
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "*",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8", allow: "GET, HEAD, OPTIONS" },
    });
  }
  const body = `${JSON.stringify(sitePayload(env))}\n`;
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}
