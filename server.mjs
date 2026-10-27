import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAppsScriptUrl } from "./src/gsheets.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIRS = new Set(["app", "src", "icons"]);
const MAX_BODY = 64 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const HTML_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function configFromEnv(env = process.env) {
  return {
    hunter: {
      label: "Hunter",
      base: env.HUNTER_API_BASE || "https://api.hunter.io/v2",
      key: env.HUNTER_API_KEY || "",
      routes: { "domain-search": ["GET", "POST"], "domain-finder": ["GET"], account: ["GET"] },
    },
    apollo: {
      label: "Apollo",
      base: env.APOLLO_API_BASE || "https://api.apollo.io/api/v1",
      key: env.APOLLO_API_KEY || "",
      routes: { "mixed_people/api_search": ["POST"], "people/match": ["POST"], "auth/health": ["GET"] },
    },
    companiesUrl: env.COMPANIES_API_URL || "https://autocomplete.clearbit.com/v1/companies/suggest",
    isSheetsUrl: isAppsScriptUrl,
    allowedHosts: new Set(
      ["127.0.0.1", "localhost", "[::1]", ...String(env.ALLOWED_HOSTS || "").split(",")]
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    ),
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function hostOf(value = "") {
  return String(value).toLowerCase().replace(/:\d+$/, "");
}

async function handleApi(req, res, url, config) {
  // Browsers attach Origin to cross-site requests; only this page may spend your credits.
  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = "";
    }
    if (originHost !== String(req.headers.host || "").toLowerCase()) {
      return sendJson(res, 403, { error: "Cross-origin requests are not allowed." });
    }
  }

  if (url.pathname === "/api/config") {
    return sendJson(res, 200, { serverKeys: { hunter: Boolean(config.hunter.key), apollo: Boolean(config.apollo.key) } });
  }

  if (url.pathname === "/api/companies") {
    const query = (url.searchParams.get("query") || "").trim().slice(0, 100);
    if (query.length < 2) return sendJson(res, 200, []);
    try {
      const upstream = await fetch(`${config.companiesUrl}?query=${encodeURIComponent(query)}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const text = await upstream.text();
      res.writeHead(upstream.ok ? 200 : 502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(upstream.ok ? text : "[]");
    } catch {
      return sendJson(res, 200, []);
    }
  }

  if (url.pathname === "/api/sheets") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    // Only ever forward to a Google Apps Script web app, so this can't be used to reach other hosts.
    const target = String(req.headers["x-sheets-url"] || "").trim();
    if (!config.isSheetsUrl(target)) {
      return sendJson(res, 400, { ok: false, error: "That isn't a Google Apps Script web app URL." });
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 413, { ok: false, error: "Request body too large" });
    }
    try {
      const reply = await fetch(target, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=utf-8" },
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });
      const text = await reply.text();
      res.writeHead(reply.status, {
        "content-type": reply.headers.get("content-type") || "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(text);
    } catch {
      return sendJson(res, 502, { ok: false, error: "Couldn't reach Google Sheets." });
    }
  }

  const match = url.pathname.match(/^\/api\/(hunter|apollo)\/(.+)$/);
  const upstream = match ? config[match[1]] : null;
  const methods = upstream?.routes[match[2]];
  if (!methods) return sendJson(res, 404, { error: "Not found" });
  if (!methods.includes(req.method)) return sendJson(res, 405, { error: "Method not allowed" });

  const key = String(req.headers["x-api-key"] || "").trim() || upstream.key;
  const headers = { accept: "application/json" };
  if (key) headers["x-api-key"] = key;
  let body;
  if (req.method === "POST") {
    try {
      body = (await readBody(req)) || "{}";
    } catch {
      return sendJson(res, 413, { error: "Request body too large" });
    }
    headers["content-type"] = "application/json";
    headers["cache-control"] = "no-cache";
  }

  try {
    const reply = await fetch(`${upstream.base}/${match[2]}${url.search}`, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(25000),
    });
    const text = await reply.text();
    res.writeHead(reply.status, {
      "content-type": reply.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(text);
  } catch {
    sendJson(res, 502, { error: `Couldn't reach ${upstream.label}. Check your internet connection.` });
  }
}

async function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: "Bad path" });
  }
  if (pathname === "/" || pathname === "/app") {
    res.writeHead(302, { location: "/app/" });
    return res.end();
  }
  if (pathname.endsWith("/")) pathname += "index.html";

  const segments = pathname.split("/").filter(Boolean);
  if (!PUBLIC_DIRS.has(segments[0]) || segments.some((s) => s.startsWith(".") || s.includes("\\"))) {
    return sendJson(res, 404, { error: "Not found" });
  }
  const file = resolve(ROOT, ...segments);
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return sendJson(res, 404, { error: "Not found" });

  try {
    const info = await stat(file);
    if (!info.isFile()) return sendJson(res, 404, { error: "Not found" });
    const type = TYPES[extname(file)] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": info.size,
      "cache-control": "no-cache",
      ...(type.startsWith("text/html") ? HTML_HEADERS : { "x-content-type-options": "nosniff" }),
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

export function createServer(config = configFromEnv()) {
  return http.createServer(async (req, res) => {
    try {
      // Rejecting unknown Host headers blocks DNS-rebinding pages from using the proxy.
      if (!config.allowedHosts.has(hostOf(req.headers.host))) {
        return sendJson(res, 403, { error: "Unknown host. Add it to ALLOWED_HOSTS to allow it." });
      }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, config);
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
      return await serveStatic(req, res, url);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
      else res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 43145;
  const host = process.env.HOST || "127.0.0.1";
  const config = configFromEnv();
  createServer(config).listen(port, host, () => {
    const keys = ["hunter", "apollo"].filter((p) => config[p].key).map((p) => config[p].label);
    console.log(`Scout is running at http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
    console.log(keys.length ? `Using server API keys for: ${keys.join(", ")}` : "No server API keys set; add keys in the app's Settings.");
  });
}
