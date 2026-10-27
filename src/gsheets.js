import { displayRow } from "./sheet.js";

/**
 * Google Sheets sync through a tiny Apps Script "web app" that the user pastes
 * into their own sheet. No Google Cloud project or OAuth client is needed: the
 * script runs as the sheet's owner, and a shared secret keeps strangers out.
 */

const APPS_SCRIPT_URL = /^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

export function isAppsScriptUrl(value) {
  return APPS_SCRIPT_URL.test(String(value || "").trim());
}

export function newSecret() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class SheetsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SheetsError";
    this.code = code;
  }
}

export const SHEET_TAB_NAME = "Scout";

export function buildScript(secret) {
  return `// Scout -> Google Sheets
// Paste this into Extensions > Apps Script, then Deploy > New deployment > Web app
// (Execute as: Me, Who has access: Anyone). Scout signs every request with SECRET.
const SECRET = "${secret}";
const SHEET_NAME = "${SHEET_TAB_NAME}";
const HEADERS = ["Company", "Name", "Title", "Email", "Email status", "Location", "LinkedIn", "Domain", "Source", "Added"];
const FIELDS = ["company", "name", "title", "email", "emailStatus", "location", "linkedin", "domain", "source", "added"];

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (body.secret !== SECRET) return reply({ ok: false, error: "wrong_secret" });

    const book = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = book.getSheetByName(SHEET_NAME) || book.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
    if (body.action === "ping") return reply({ ok: true, name: book.getName(), url: book.getUrl() });

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const header = headerRow(sheet);
      const emailColumn = header.indexOf("Email") + 1;
      const existing = sheet.getLastRow() - 1;
      const seen = new Set(
        existing > 0
          ? sheet.getRange(2, emailColumn, existing, 1).getValues().map(function (r) { return String(r[0]).trim().toLowerCase(); })
          : []
      );
      const incoming = Array.isArray(body.rows) ? body.rows : [];
      const rows = [];
      incoming.forEach(function (row) {
        const email = String((row && row.email) || "").trim().toLowerCase();
        if (!email || seen.has(email)) return;
        seen.add(email);
        const values = header.map(function () { return ""; });
        HEADERS.forEach(function (label, i) { values[header.indexOf(label)] = asText(row[FIELDS[i]]); });
        rows.push(values);
      });
      if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
      return reply({ ok: true, added: rows.length, skipped: incoming.length - rows.length, name: book.getName(), url: book.getUrl() });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return reply({ ok: false, error: String((err && err.message) || err) });
  }
}

// Finds Scout's columns by their header text and adds any missing ones at the end,
// so columns you add or move yourself are left alone.
function headerRow(sheet) {
  const width = Math.max(sheet.getLastColumn(), 1);
  const header = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (v) { return String(v).trim(); });
  const missing = HEADERS.filter(function (label) { return header.indexOf(label) === -1; });
  if (!missing.length) return header;
  sheet.getRange(1, header.length + 1, 1, missing.length).setValues([missing]).setFontWeight("bold");
  return header.concat(missing);
}

// Sheets runs any value starting with = + - @ as a formula; a leading apostrophe keeps it as text.
function asText(value) {
  const text = value == null ? "" : String(value);
  return /^[=+\\-@]/.test(text) ? "'" + text : text;
}

function reply(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

/** The row shape the Apps Script expects (keys match its FIELDS list). */
export function toPayloadRow(record) {
  const v = displayRow(record);
  return {
    company: v.company,
    name: v.name,
    title: v.title,
    email: v.email,
    emailStatus: v.emailStatus,
    location: v.location,
    linkedin: v.linkedin,
    domain: v.domain,
    source: v.source,
    added: v.savedAt,
  };
}

/**
 * Sends one request to the user's Apps Script. `endpoint` is the script URL itself
 * (extension) or the local proxy (web version), which reads the target from a header.
 */
export async function postToSheet({ endpoint, sheetUrl, secret, action = "append", rows = [], fetchImpl, signal }) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const headers = { "Content-Type": "text/plain;charset=utf-8" };
  if (endpoint !== sheetUrl) headers["X-Sheets-Url"] = sheetUrl;

  let res;
  try {
    res = await doFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ secret, action, rows }),
      redirect: "follow",
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new SheetsError("network", "Couldn't reach Google Sheets. Check your internet connection and try again.");
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!json || typeof json !== "object") {
    if (/<html|<!doctype/i.test(text)) {
      throw new SheetsError(
        "not_public",
        "Google sent back a web page instead of your script's answer. In Apps Script, deploy it as a Web app with “Who has access: Anyone”, then paste the new Web app URL here."
      );
    }
    throw new SheetsError("bad_response", `Google Sheets sent an unexpected response (HTTP ${res.status}).`);
  }
  if (!json.ok) {
    if (json.error === "wrong_secret") {
      throw new SheetsError(
        "wrong_secret",
        "Your sheet's script has a different secret code. Copy the script from Scout again, replace the old one in Apps Script, then redeploy (Deploy > Manage deployments > Edit > New version)."
      );
    }
    throw new SheetsError("script_error", `Your Google Sheets script reported an error: ${json.error || "unknown error"}.`);
  }
  return json;
}
