import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildScript, isAppsScriptUrl, newSecret, postToSheet, toPayloadRow } from "../src/gsheets.js";
import { mergeRecords } from "../src/sheet.js";
import { fakeFetch, jsonResponse } from "./helpers.mjs";

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbx1234567890abcdefghijklmnop/exec";

test("accepts only Apps Script web app URLs", () => {
  assert.equal(isAppsScriptUrl(SCRIPT_URL), true);
  assert.equal(isAppsScriptUrl("https://script.google.com/a/macros/acme.com/s/AKfycbx1234567890abcdefghijklmnop/exec"), true);
  assert.equal(isAppsScriptUrl(`${SCRIPT_URL}?x=1`), false);
  assert.equal(isAppsScriptUrl("https://script.google.com/macros/s/AKfycbx1234567890abcdefghijklmnop/dev"), false);
  assert.equal(isAppsScriptUrl("https://evil.example/macros/s/AKfycbx1234567890abcdefghijklmnop/exec"), false);
  assert.equal(isAppsScriptUrl("http://script.google.com/macros/s/AKfycbx1234567890abcdefghijklmnop/exec"), false);
  assert.equal(isAppsScriptUrl("https://docs.google.com/spreadsheets/d/abc/edit"), false);
});

test("secrets are random 32-character hex strings", () => {
  const a = newSecret();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newSecret());
});

/** Runs the generated Apps Script against an in-memory spreadsheet, optionally with an existing "Scout" tab. */
function runScript(secret, existingRows = null) {
  const sheets = new Map();
  const makeSheet = (initial = []) => {
    const rows = initial.map((r) => r.slice());
    const sheet = {
      rows,
      frozen: 0,
      getLastRow: () => rows.length,
      getLastColumn: () => rows.reduce((max, r) => Math.max(max, r.length), 0),
      // Array.from copies values out of the vm realm so deepStrictEqual compares plain arrays.
      appendRow: (values) => rows.push(Array.from(values)),
      setFrozenRows: (n) => (sheet.frozen = n),
      getRange: (row, col, numRows = 1, numCols = 1) => {
        const range = {
          setFontWeight: () => range,
          getValues: () =>
            rows.slice(row - 1, row - 1 + numRows).map((r) => Array.from({ length: numCols }, (_, c) => r[col - 1 + c] ?? "")),
          setValues: (values) => {
            assert.equal(values.length, numRows);
            values.forEach((v, i) => {
              assert.equal(v.length, numCols);
              const target = rows[row - 1 + i] || (rows[row - 1 + i] = []);
              Array.from(v).forEach((value, c) => {
                target[col - 1 + c] = value;
              });
            });
            return range;
          },
        };
        return range;
      },
    };
    return sheet;
  };
  if (existingRows) sheets.set("Scout", makeSheet(existingRows));
  const book = {
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet: (name) => {
      const s = makeSheet();
      sheets.set(name, s);
      return s;
    },
    getName: () => "Job search",
    getUrl: () => "https://docs.google.com/spreadsheets/d/abc123/edit",
  };
  const context = {
    SpreadsheetApp: { getActiveSpreadsheet: () => book },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      createTextOutput: (text) => ({ setMimeType: () => JSON.parse(text) }),
      MimeType: { JSON: "application/json" },
    },
  };
  vm.createContext(context);
  vm.runInContext(buildScript(secret), context);
  const post = (body) => context.doPost({ postData: { contents: JSON.stringify(body) } });
  return { post, sheet: () => sheets.get("Scout") };
}

test("the Apps Script checks the secret, adds a header, skips duplicates, and neutralizes formulas", () => {
  const secret = newSecret();
  const { post, sheet } = runScript(secret);

  assert.deepEqual(post({ secret: "nope", action: "ping" }), { ok: false, error: "wrong_secret" });

  const ping = post({ secret, action: "ping" });
  assert.deepEqual(ping, { ok: true, name: "Job search", url: "https://docs.google.com/spreadsheets/d/abc123/edit" });
  assert.deepEqual(sheet().rows[0], ["Company", "Name", "Title", "Email", "Email status", "Location", "LinkedIn", "Domain", "Source", "Added"]);
  assert.equal(sheet().frozen, 1);

  const { list } = mergeRecords([], [
    { id: "a", company: "Northwind Labs", name: "Meera Iyer", title: "Talent Acquisition Associate", email: "Meera.Iyer@northwind.example", emailStatus: "verified", location: "India", source: "hunter", domain: "northwind.example" },
    { id: "b", company: "=IMPORTXML(1)", name: "Kabir Rao", title: "Recruiter", email: "kabir.rao@northwind.example", emailStatus: "unverified", source: "hunter", domain: "northwind.example" },
  ]);
  const first = post({ secret, rows: list.map(toPayloadRow) });
  assert.equal(first.ok, true);
  assert.equal(first.added, 2);
  assert.equal(sheet().rows.length, 3);
  assert.deepEqual(sheet().rows[1].slice(0, 6), ["Northwind Labs", "Meera Iyer", "Talent Acquisition Associate", "Meera.Iyer@northwind.example", "Verified", "India"]);
  assert.equal(sheet().rows[2][0], "'=IMPORTXML(1)");

  const again = post({
    secret,
    rows: [{ email: "meera.iyer@NORTHWIND.example", company: "Northwind Labs" }, { email: "" }, { email: "new.hire@northwind.example", company: "Northwind Labs" }],
  });
  assert.deepEqual([again.added, again.skipped], [1, 2]);
  assert.equal(sheet().rows.length, 4);

  const broken = runScript(secret).post;
  assert.equal(broken({ secret, rows: "not an array" }).added, 0);
});

test("the Apps Script lines values up by column name in older sheets and around your own columns", () => {
  const secret = newSecret();
  const oldHeader = ["Company", "Name", "Title", "Email", "Email status", "Applied?", "LinkedIn", "Domain", "Source", "Added"];
  const oldRow = ["Contoso", "Lena Ortiz", "Technical Recruiter", "lena@contoso.example", "Verified", "Yes", "", "contoso.example", "Hunter", "2026-10-20 10:00"];
  const { post, sheet } = runScript(secret, [oldHeader, oldRow]);

  const reply = post({
    secret,
    rows: [
      { company: "Contoso", name: "Lena Ortiz", email: "LENA@contoso.example" },
      { company: "Contoso", name: "Anika Desai", title: "Technical Recruiter", email: "anika.desai@contoso.example", emailStatus: "Verified", location: "India", linkedin: "https://www.linkedin.com/in/anika-desai-example", domain: "contoso.example", source: "Hunter", added: "2026-10-27 20:10" },
    ],
  });
  assert.deepEqual([reply.added, reply.skipped], [1, 1]);

  const header = sheet().rows[0];
  assert.deepEqual(header, [...oldHeader, "Location"]);
  assert.deepEqual(sheet().rows[1], oldRow);
  const added = sheet().rows[2];
  const cell = (label) => added[header.indexOf(label)];
  assert.equal(added.length, header.length);
  assert.equal(cell("Name"), "Anika Desai");
  assert.equal(cell("Email"), "anika.desai@contoso.example");
  assert.equal(cell("Applied?"), "");
  assert.equal(cell("LinkedIn"), "https://www.linkedin.com/in/anika-desai-example");
  assert.equal(cell("Location"), "India");
  assert.equal(cell("Added"), "2026-10-27 20:10");
});

test("postToSheet talks to the script directly or through the local proxy", async () => {
  const fetchImpl = fakeFetch([[() => true, () => jsonResponse({ ok: true, added: 1, skipped: 0 })]]);
  await postToSheet({ endpoint: SCRIPT_URL, sheetUrl: SCRIPT_URL, secret: "s", rows: [{ email: "a@b.co" }], fetchImpl });
  const direct = fetchImpl.calls[0];
  assert.equal(direct.url.href, SCRIPT_URL);
  assert.equal(direct.init.method, "POST");
  assert.equal(direct.init.headers["X-Sheets-Url"], undefined);
  assert.deepEqual(JSON.parse(direct.init.body), { secret: "s", action: "append", rows: [{ email: "a@b.co" }] });

  await postToSheet({ endpoint: "http://127.0.0.1:43145/api/sheets", sheetUrl: SCRIPT_URL, secret: "s", action: "ping", fetchImpl });
  assert.equal(fetchImpl.calls[1].init.headers["X-Sheets-Url"], SCRIPT_URL);
});

test("postToSheet explains the common setup mistakes", async () => {
  const cases = [
    [() => new Response("<!DOCTYPE html><html>Sign in</html>", { status: 200 }), "not_public"],
    [() => jsonResponse({ ok: false, error: "wrong_secret" }), "wrong_secret"],
    [() => jsonResponse({ ok: false, error: "Exception: boom" }), "script_error"],
    [() => new Response("weird", { status: 500 }), "bad_response"],
  ];
  for (const [reply, code] of cases) {
    const fetchImpl = fakeFetch([[() => true, reply]]);
    await assert.rejects(postToSheet({ endpoint: SCRIPT_URL, sheetUrl: SCRIPT_URL, secret: "s", fetchImpl }), (err) => {
      assert.equal(err.code, code);
      assert.ok(err.message.length > 20);
      return true;
    });
  }
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(postToSheet({ endpoint: SCRIPT_URL, sheetUrl: SCRIPT_URL, secret: "s", fetchImpl: offline }), { code: "network" });
});
