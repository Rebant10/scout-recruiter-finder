import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { configFromEnv, createServer } from "../server.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"] || "", body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  const port = await listen(server);
  return { server, seen, base: `http://127.0.0.1:${port}` };
}

test("proxy forwards allowed calls and injects the server key", async (t) => {
  const upstream = await startUpstream();
  const config = configFromEnv({
    HUNTER_API_BASE: `${upstream.base}/v2`,
    APOLLO_API_BASE: `${upstream.base}/api/v1`,
    HUNTER_API_KEY: "server-hunter-key",
    COMPANIES_API_URL: `${upstream.base}/suggest`,
  });
  const app = createServer(config);
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await close(app);
    await close(upstream.server);
  });

  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(cfg.serverKeys, { hunter: true, apollo: false });

  const r1 = await fetch(`${base}/api/hunter/domain-search?domain=acme.com&job_titles=recruiter`);
  assert.equal(r1.status, 200);
  assert.equal(upstream.seen.at(-1).url, "/v2/domain-search?domain=acme.com&job_titles=recruiter");
  assert.equal(upstream.seen.at(-1).key, "server-hunter-key");

  await fetch(`${base}/api/hunter/account`, { headers: { "x-api-key": "browser-key" } });
  assert.equal(upstream.seen.at(-1).key, "browser-key");

  const located = await fetch(`${base}/api/hunter/domain-search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain: "acme.com", location: { include: [{ country: "IN" }] } }),
  });
  assert.equal(located.status, 200);
  assert.equal(upstream.seen.at(-1).method, "POST");
  assert.equal(upstream.seen.at(-1).url, "/v2/domain-search");
  assert.equal(upstream.seen.at(-1).key, "server-hunter-key");
  assert.deepEqual(JSON.parse(upstream.seen.at(-1).body).location, { include: [{ country: "IN" }] });

  const r2 = await fetch(`${base}/api/apollo/mixed_people/api_search?q_organization_domains_list%5B%5D=acme.com`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "apollo-key" },
    body: "{}",
  });
  assert.equal(r2.status, 200);
  assert.equal(upstream.seen.at(-1).method, "POST");
  assert.equal(upstream.seen.at(-1).key, "apollo-key");
  assert.equal(upstream.seen.at(-1).body, "{}");

  const r3 = await fetch(`${base}/api/companies?query=acme`);
  assert.equal(r3.status, 200);
  assert.equal(upstream.seen.at(-1).url, "/suggest?query=acme");
});

test("proxy refuses anything outside the allowlist", async (t) => {
  const upstream = await startUpstream();
  const app = createServer(configFromEnv({ HUNTER_API_BASE: `${upstream.base}/v2`, APOLLO_API_BASE: `${upstream.base}/api/v1` }));
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await close(app);
    await close(upstream.server);
  });

  assert.equal((await fetch(`${base}/api/hunter/leads`)).status, 404);
  assert.equal((await fetch(`${base}/api/apollo/contacts`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/api/hunter/account`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/api/hunter/domain-search`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`${base}/api/other/thing`)).status, 404);
  const cross = await fetch(`${base}/api/hunter/account`, { headers: { origin: "https://evil.example" } });
  assert.equal(cross.status, 403);
  assert.equal(upstream.seen.length, 0);
});

test("sheets proxy forwards only to Apps Script web apps", async (t) => {
  const upstream = await startUpstream();
  const real = configFromEnv({});
  const app = createServer({ ...real, isSheetsUrl: (url) => url.startsWith(upstream.base) || real.isSheetsUrl(url) });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await close(app);
    await close(upstream.server);
  });

  const ok = await fetch(`${base}/api/sheets`, {
    method: "POST",
    headers: { "x-sheets-url": `${upstream.base}/macros/s/abc/exec`, "content-type": "text/plain" },
    body: '{"secret":"s","action":"ping"}',
  });
  assert.equal(ok.status, 200);
  assert.equal(upstream.seen.at(-1).url, "/macros/s/abc/exec");
  assert.equal(upstream.seen.at(-1).body, '{"secret":"s","action":"ping"}');

  const seenBefore = upstream.seen.length;
  const strict = createServer(real);
  const strictPort = await listen(strict);
  t.after(() => close(strict));
  for (const target of ["", "https://evil.example/exec", "http://127.0.0.1:1/macros/s/abc/exec", "https://script.google.com/macros/s/short/exec"]) {
    const res = await fetch(`http://127.0.0.1:${strictPort}/api/sheets`, { method: "POST", headers: { "x-sheets-url": target }, body: "{}" });
    assert.equal(res.status, 400, target);
  }
  assert.equal((await fetch(`http://127.0.0.1:${strictPort}/api/sheets`)).status, 405);
  assert.equal(upstream.seen.length, seenBefore);
});

test("static files are served from public folders only", async (t) => {
  const app = createServer(configFromEnv({}));
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  t.after(() => close(app));

  const root = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/app/");

  const page = await fetch(`${base}/app/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /<div id="root"/);

  const js = await fetch(`${base}/src/search.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);

  for (const path of ["/server.mjs", "/package.json", "/.git/config", "/app/%2e%2e/server.mjs", "/src/..%2fserver.mjs"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test("requests with an unknown Host header are rejected", async (t) => {
  const app = createServer(configFromEnv({}));
  const port = await listen(app);
  t.after(() => close(app));
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/config", headers: { host: "attacker.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});
