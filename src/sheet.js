/**
 * The local sheet: one row per person, newest first, de-duplicated by id and email.
 * Rows remember when they were last sent to Google Sheets (`syncedAt`).
 */

export const SHEET_COLUMNS = [
  ["company", "Company"],
  ["name", "Name"],
  ["title", "Title"],
  ["email", "Email"],
  ["emailStatus", "Email status"],
  ["location", "Location"],
  ["linkedin", "LinkedIn"],
  ["domain", "Domain"],
  ["source", "Source"],
  ["savedAt", "Added"],
];

const STATUS_LABELS = { verified: "Verified", accept_all: "Catch-all", unverified: "Unverified" };
const SOURCE_LABELS = { hunter: "Hunter", apollo: "Apollo" };

export function toRecord(person, now = new Date().toISOString()) {
  return {
    id: person.id,
    company: person.company || "",
    name: person.name || "",
    title: person.title || "",
    email: person.email || "",
    emailStatus: person.emailStatus || "",
    location: person.location || "",
    linkedin: person.linkedin || "",
    phone: person.phone || "",
    domain: person.domain || "",
    source: person.source || "",
    apolloId: person.apolloId || "",
    savedAt: now,
    syncedAt: "",
  };
}

function sameRow(a, b) {
  return a.id === b.id || (Boolean(b.email) && a.email === b.email);
}

/** Adds new people at the top (in the order given) and refreshes rows already in the sheet. */
export function mergeRecords(list, people, now = new Date().toISOString()) {
  const out = list.slice();
  const fresh = [];
  for (const person of people) {
    const record = toRecord(person, now);
    const idx = out.findIndex((row) => sameRow(row, record));
    if (idx >= 0) {
      const prev = out[idx];
      const next = { ...prev };
      for (const [key, value] of Object.entries(record)) {
        if (value && key !== "savedAt" && key !== "syncedAt") next[key] = value;
      }
      if (record.email && record.email !== prev.email) next.syncedAt = "";
      out[idx] = next;
    } else if (!fresh.some((row) => sameRow(row, record))) {
      fresh.push(record);
    }
  }
  return { list: [...fresh, ...out], added: fresh.length };
}

export function pendingRows(list) {
  return list.filter((row) => row.email && !row.syncedAt);
}

export function markSynced(list, ids, at = new Date().toISOString()) {
  const done = new Set(ids);
  return list.map((row) => (done.has(row.id) ? { ...row, syncedAt: at } : row));
}

export function clearSynced(list) {
  return list.map((row) => (row.syncedAt ? { ...row, syncedAt: "" } : row));
}

/** "2026-10-27T14:02:00Z" -> "2026-10-27 19:32" in the viewer's time zone, which spreadsheets read as a date. */
export function formatStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso ? String(iso) : "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The values that go in each column, as people read them. */
export function displayRow(row) {
  return {
    company: row.company || row.domain || "",
    name: row.name || "",
    title: row.title || "",
    email: row.email || "",
    emailStatus: STATUS_LABELS[row.emailStatus] || "",
    location: row.location || "",
    linkedin: row.linkedin || "",
    domain: row.domain || "",
    source: SOURCE_LABELS[row.source] || row.source || "",
    savedAt: formatStamp(row.savedAt),
  };
}

function guardFormula(value) {
  const s = value == null ? "" : String(value);
  // Spreadsheet apps run cells that start with these characters as formulas.
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function toCsv(rows) {
  const cell = (value) => {
    const s = guardFormula(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = SHEET_COLUMNS.map(([, label]) => label).join(",");
  const lines = rows.map((row) => {
    const values = displayRow(row);
    return SHEET_COLUMNS.map(([key]) => cell(values[key])).join(",");
  });
  return [header, ...lines].join("\r\n");
}

/** Tab-separated text: pasting it into Google Sheets or Excel fills one cell per value. */
export function toTsv(rows) {
  const cell = (value) => guardFormula(value).replace(/[\t\r\n]+/g, " ");
  const header = SHEET_COLUMNS.map(([, label]) => label).join("\t");
  const lines = rows.map((row) => {
    const values = displayRow(row);
    return SHEET_COLUMNS.map(([key]) => cell(values[key])).join("\t");
  });
  return [header, ...lines].join("\n");
}
