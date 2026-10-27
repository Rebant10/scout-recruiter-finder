import { runtime } from "./env.js";
import { DEFAULT_LOCATION } from "./locations.js";
import { clearSynced, markSynced, mergeRecords } from "./sheet.js";

const PREFIX = "scout.";
const MAX_RECENT = 6;

const backend =
  runtime === "extension"
    ? {
        async get(key) {
          const out = await chrome.storage.local.get(PREFIX + key);
          return out[PREFIX + key];
        },
        async set(key, value) {
          await chrome.storage.local.set({ [PREFIX + key]: value });
        },
      }
    : {
        async get(key) {
          try {
            const raw = localStorage.getItem(PREFIX + key);
            return raw == null ? undefined : JSON.parse(raw);
          } catch {
            return undefined;
          }
        },
        async set(key, value) {
          localStorage.setItem(PREFIX + key, JSON.stringify(value));
        },
      };

export async function getKeys() {
  const keys = (await backend.get("keys")) || {};
  return {
    hunter: typeof keys.hunter === "string" ? keys.hunter : "",
    apollo: typeof keys.apollo === "string" ? keys.apollo : "",
  };
}

export async function setKey(provider, value) {
  const keys = await getKeys();
  keys[provider] = String(value || "").trim();
  await backend.set("keys", keys);
  return keys;
}

const DEFAULT_SETTINGS = {
  autoSave: true,
  location: DEFAULT_LOCATION,
  sheets: { url: "", secret: "", name: "", link: "", lastSyncAt: "", lastError: "" },
};

export async function getSettings() {
  const stored = (await backend.get("settings")) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    sheets: { ...DEFAULT_SETTINGS.sheets, ...(stored.sheets || {}) },
  };
}

export async function saveSettings(settings) {
  await backend.set("settings", settings);
  return settings;
}

export async function getSaved() {
  const list = await backend.get("saved");
  return Array.isArray(list) ? list : [];
}

// Every change to the sheet is a read-modify-write, so run them one at a time:
// a background sync marking rows as sent must not overwrite rows added meanwhile.
let queue = Promise.resolve();

function updateSaved(change) {
  const run = queue.then(async () => {
    const result = change(await getSaved());
    const list = Array.isArray(result) ? result : result.list;
    await backend.set("saved", list);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

/** Adds people to the sheet; resolves to { list, added }. */
export function addToSheet(people) {
  return updateSaved((list) => mergeRecords(list, people));
}

export function removeSaved(id) {
  return updateSaved((list) => list.filter((row) => row.id !== id));
}

export function clearSaved() {
  return updateSaved(() => []);
}

export function markRowsSynced(ids, at) {
  return updateSaved((list) => markSynced(list, ids, at));
}

export function resetSynced() {
  return updateSaved((list) => clearSynced(list));
}

export async function getRecent() {
  const list = await backend.get("recent");
  return Array.isArray(list) ? list : [];
}

export async function pushRecent(entry) {
  const key = (entry.domain || entry.name || "").toLowerCase();
  if (!key) return getRecent();
  const list = (await getRecent()).filter((r) => (r.domain || r.name || "").toLowerCase() !== key);
  list.unshift({ name: entry.name || "", domain: entry.domain || "" });
  const trimmed = list.slice(0, MAX_RECENT);
  await backend.set("recent", trimmed);
  return trimmed;
}

/** Apollo emails cost a credit each, so reveals are cached by Apollo person id. */
export async function getReveals() {
  const map = await backend.get("reveals");
  return map && typeof map === "object" ? map : {};
}

export async function putReveal(apolloId, patch) {
  const map = await getReveals();
  map[apolloId] = patch;
  await backend.set("reveals", map);
  return map;
}
