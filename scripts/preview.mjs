// Local static server that runs the same Pages Functions as Cloudflare.
// Use this when WHOIS_API_BASE points at 127.0.0.1: the Workers runtime
// often refuses loopback, and this process does not.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { onRequest as rootPage } from "../functions/index.js";
import { onRequest as jsonApi } from "../functions/json.js";
import { onRequest as whoami } from "../functions/api/whoami.js";
import { onRequest as whois } from "../functions/api/whois/[[path]].js";
import { onRequest as site } from "../functions/api/site.js";

const root = join(import.meta.dirname, "..");
const publicDir = join(root, "public");
const port = Number(process.env.PORT || process.env.PREVIEW_PORT || 8788);

function parseEnvFile(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, eq).trim()] = value;
  }
  return env;
}

async function loadEnv() {
  const keys = ["WHOIS_API_BASE", "WHOIS_API_KEY", "CONTACT_EMAIL", "CONTACT_URL", "CONTACT_URL_LABEL"];
  let fileEnv = {};
  try {
    fileEnv = parseEnvFile(await readFile(join(root, ".dev.vars"), "utf8"));
  } catch {
    /* .dev.vars is optional */
  }
  const env = {};
  for (const key of keys) env[key] = process.env[key] || fileEnv[key] || "";
  return env;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function insidePublic(file) {
  const normal = normalize(file);
  return normal === publicDir || normal.startsWith(publicDir + sep);
}

async function readStatic(pathname) {
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\0")) return null;
  const candidates = decoded.endsWith("/") ? [decoded + "index.html"] : [decoded];
  if (!extname(decoded)) candidates.push(`${decoded.replace(/\/$/, "")}/index.html`);
  for (const rel of candidates) {
    const file = normalize(join(publicDir, rel));
    if (!insidePublic(file)) return null;
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      return {
        body: await readFile(file),
        type: TYPES[extname(file)] || "application/octet-stream",
      };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function handlerFor(pathname) {
  if (pathname === "/") return rootPage;
  if (pathname === "/json" || pathname.startsWith("/json/")) return jsonApi;
  if (pathname === "/api/whoami" || pathname.startsWith("/api/whoami/")) return whoami;
  if (pathname === "/api/whois" || pathname.startsWith("/api/whois/")) return whois;
  if (pathname === "/api/site" || pathname.startsWith("/api/site/")) return site;
  return null;
}

function toRequest(req) {
  const host = req.headers.host || `127.0.0.1:${port}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value != null) headers.set(key, value);
  }
  return new Request(`http://${host}${req.url}`, { method: req.method, headers });
}

const envPromise = loadEnv();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const env = await envPromise;
    env.ASSETS = {
      async fetch(request) {
        const asset = await readStatic(new URL(request.url).pathname);
        if (!asset) return new Response("not found\n", { status: 404 });
        return new Response(asset.body, { headers: { "content-type": asset.type } });
      },
    };
    const handler = handlerFor(url.pathname);
    if (handler) {
      const response = await handler({ request: toRequest(req), env });
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (key !== "transfer-encoding") res.setHeader(key, value);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const asset = await readStatic(url.pathname);
    if (!asset) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("not found\n");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", asset.type);
    res.setHeader("cache-control", asset.type.startsWith("text/html") ? "no-cache" : "public, max-age=3600");
    res.end(asset.body);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`preview error: ${error?.message || error}\n`);
  }
});

server.listen(port, "127.0.0.1", async () => {
  const env = await envPromise;
  console.log(`WhoIP preview http://127.0.0.1:${port}`);
  console.log(`WHOIS_API_BASE=${env.WHOIS_API_BASE || "(unset)"}`);
});
