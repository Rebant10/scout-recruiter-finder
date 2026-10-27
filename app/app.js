import { endpoints, runtime } from "../src/env.js";
import * as store from "../src/store.js";
import { DEFAULT_MODE, MODES, roleTag } from "../src/roles.js";
import { LOCATIONS, locationLabel } from "../src/locations.js";
import { loadMore, searchCompany } from "../src/search.js";
import { bestMatch, logoUrl, suggestCompanies } from "../src/providers/companies.js";
import { hunterAccount, hunterDomainFinder } from "../src/providers/hunter.js";
import { apolloCheckAccess, apolloRevealPerson } from "../src/providers/apollo.js";
import { FATAL_CODES, PROVIDER_NAMES } from "../src/providers/http.js";
import { pendingRows, toCsv, toTsv } from "../src/sheet.js";
import { buildScript, isAppsScriptUrl, newSecret, postToSheet, SHEET_TAB_NAME, toPayloadRow } from "../src/gsheets.js";
import {
  cleanDomain,
  initials,
  isEmail,
  linkedinUrl,
  looksLikeDomain,
  normalizeCompanyName,
  safeUrl,
} from "../src/util.js";
import { h, icon } from "./dom.js";

const isPopup = document.documentElement.classList.contains("is-popup");
const VIEWS = ["search", "sheet", "settings"];

const PROVIDER_INFO = {
  hunter: {
    name: "Hunter.io",
    blurb:
      "Returns work emails right away, each with its verification status and the public pages it was found on.",
    pricing:
      "Free plan: 50 credits a month. Each company search costs 1 credit, only when it finds people, and shows up to 10 of them.",
    keyUrl: "https://hunter.io/api-keys",
    keyLinkLabel: "Get a Hunter key",
    keySteps: "Sign up free at hunter.io, then copy your key from the API page.",
    placeholder: "Paste your Hunter API key",
  },
  apollo: {
    name: "Apollo.io",
    blurb: "Searches Apollo's people database for free, then reveals each email when you ask for it (1 Apollo credit each).",
    pricing: "Free Apollo accounts must be registered with a work email to use API search.",
    keyUrl: "https://docs.apollo.io/docs/create-api-key",
    keyLinkLabel: "Apollo's key guide",
    keySteps:
      "In Apollo, open Settings → Integrations → API Keys → Create new key, and turn on “Set as master key” (or pick People API Search and People Enrichment).",
    placeholder: "Paste your Apollo API key",
  },
};

const STATUS_INFO = {
  verified: { label: "Verified", cls: "ok", tip: "The company's mail server confirmed this mailbox exists." },
  accept_all: {
    label: "Catch-all",
    cls: "warn",
    tip: "This company's mail server accepts every address, so this one can't be fully confirmed.",
  },
  unverified: { label: "Unverified", cls: "muted", tip: "Not confirmed by a mail server yet. It may still work." },
};

const state = {
  view: "search",
  keys: { hunter: "", apollo: "" },
  serverKeys: { hunter: false, apollo: false },
  keyHealth: { hunter: "", apollo: "" },
  hunterAccount: null,
  mode: DEFAULT_MODE,
  suggestions: [],
  suggestionsFor: "",
  activeSuggestion: -1,
  selected: null,
  search: null,
  verifiedOnly: false,
  revealing: new Set(),
  loadingMore: "",
  saved: [],
  savedFilter: "",
  recent: [],
  reveals: {},
  settings: null,
  syncing: false,
};

const els = {};
const cardEls = new Map();
let searchAbort = null;
let suggestAbort = null;
let suggestTimer = 0;
let toastTimer = 0;
let syncTimer = 0;
let syncRun = null;
let syncAgain = false;

const connected = (provider) => Boolean(state.keys[provider]) || Boolean(state.serverKeys[provider]);
const anyConnected = () => connected("hunter") || connected("apollo");
const plural = (n, one, many) => (n === 1 ? one : many);

function providerConfig() {
  return {
    hunter: { enabled: connected("hunter"), apiKey: state.keys.hunter },
    apollo: { enabled: connected("apollo"), apiKey: state.keys.apollo },
  };
}

init().catch((err) => {
  console.error(err);
  document.getElementById("root").textContent = "Scout couldn't start. Reload to try again.";
});

async function init() {
  const [keys, saved, recent, reveals, serverKeys, settings] = await Promise.all([
    store.getKeys(),
    store.getSaved(),
    store.getRecent(),
    store.getReveals(),
    loadServerKeys(),
    store.getSettings(),
  ]);
  if (!settings.sheets.secret) {
    settings.sheets.secret = newSecret();
    await store.saveSettings(settings);
  }
  Object.assign(state, { keys, saved, recent, reveals, serverKeys, settings });
  buildShell();
  const fromHash = location.hash.replace("#", "");
  const initial = fromHash === "saved" ? "sheet" : fromHash;
  setView(VIEWS.includes(initial) ? initial : "search");
  renderResults();
  renderKeyCards();
  renderSheetSettings();
  updateSavedCount();
  if (connected("hunter")) refreshHunterAccount();
  if (sheetsConnected() && pendingRows(state.saved).length) scheduleSync(1500);
}

async function loadServerKeys() {
  if (runtime !== "web") return { hunter: false, apollo: false };
  try {
    const res = await fetch("/api/config");
    const json = await res.json();
    return { hunter: Boolean(json?.serverKeys?.hunter), apollo: Boolean(json?.serverKeys?.apollo) };
  } catch {
    return { hunter: false, apollo: false };
  }
}

/* ---------- Shell ---------- */

function buildShell() {
  els.tabs = {};
  els.savedCount = h("span", { class: "count" }, "0");
  const tab = (view, label, extra) => {
    const btn = h(
      "button",
      { type: "button", class: "tab", role: "tab", "aria-selected": "false", onclick: () => setView(view) },
      label,
      extra
    );
    els.tabs[view] = btn;
    return btn;
  };

  const header = h(
    "header",
    { class: "topbar" },
    h(
      "div",
      { class: "brand" },
      h("span", { class: "brand-mark", "aria-hidden": "true" }, icon("search", { size: 15 })),
      h("span", { class: "brand-name" }, "Scout")
    ),
    h(
      "nav",
      { class: "tabs", role: "tablist", "aria-label": "Sections" },
      tab("search", "Search"),
      tab("sheet", "Sheet", els.savedCount),
      tab("settings", "Settings")
    ),
    isPopup && runtime === "extension"
      ? h(
          "button",
          {
            type: "button",
            class: "icon-btn",
            title: "Open Scout in a full tab",
            "aria-label": "Open Scout in a full tab",
            onclick: openFullTab,
          },
          icon("external")
        )
      : null
  );

  els.views = { search: buildSearchView(), sheet: buildSheetView(), settings: buildSettingsView() };
  els.toast = h("div", { class: "toast", role: "status", "aria-live": "polite" });
  document
    .getElementById("root")
    .append(header, h("main", { class: "main" }, els.views.search, els.views.sheet, els.views.settings), els.toast);
}

function setView(view) {
  state.view = view;
  for (const [name, btn] of Object.entries(els.tabs)) {
    btn.classList.toggle("is-active", name === view);
    btn.setAttribute("aria-selected", String(name === view));
  }
  for (const [name, section] of Object.entries(els.views)) section.hidden = name !== view;
  if (!isPopup) history.replaceState(null, "", view === "search" ? location.pathname : `#${view}`);
  if (view === "sheet") renderSheet();
  if (view === "settings") {
    renderKeyCards();
    renderSheetSettings();
  }
  if (view === "search") requestAnimationFrame(() => els.query.focus());
}

function openFullTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL(`app/index.html#${state.view}`) });
  window.close();
}

/* ---------- Search view ---------- */

function buildSearchView() {
  els.query = h("input", {
    id: "company-input",
    class: "search-input",
    type: "text",
    placeholder: "Company name or website",
    autocomplete: "off",
    spellcheck: "false",
    role: "combobox",
    "aria-label": "Company name or website",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": "company-suggestions",
    oninput: onQueryInput,
    onkeydown: onQueryKeydown,
    onblur: () => setTimeout(closeSuggestions, 120),
    onfocus: () => {
      const q = els.query.value.trim();
      // Don't cover results the user already searched for (focus also happens on tab switches).
      if (state.suggestions.length && state.suggestionsFor === q && state.search?.query !== q) renderSuggestions();
    },
  });
  els.suggestions = h("ul", { id: "company-suggestions", class: "suggestions", role: "listbox", hidden: true });

  const form = h(
    "form",
    {
      class: "search-bar",
      onsubmit: (e) => {
        e.preventDefault();
        submitSearch();
      },
    },
    h(
      "div",
      { class: "combo" },
      h("span", { class: "search-icon" }, icon("search", { size: 17 })),
      els.query,
      els.suggestions
    ),
    h("button", { type: "submit", class: "btn btn-primary btn-find" }, "Find")
  );

  els.modeButtons = Object.entries(MODES).map(([key, mode]) =>
    h(
      "button",
      {
        type: "button",
        role: "radio",
        class: "segment",
        "data-mode": key,
        "aria-checked": String(state.mode === key),
        onclick: () => setMode(key),
      },
      mode.label
    )
  );
  els.locationSelect = h(
    "select",
    { "aria-label": "Where the people are based", onchange: (e) => setLocation(e.target.value) },
    LOCATIONS.map((place) =>
      h("option", { value: place.code, selected: place.code === state.settings.location }, place.code ? place.label : "Anywhere")
    )
  );
  els.status = h("div", { class: "source-status" });
  els.results = h("div", { class: "results" });

  return h(
    "section",
    { class: "view view-search" },
    form,
    h(
      "div",
      { class: "search-options" },
      h("div", { class: "segmented", role: "radiogroup", "aria-label": "Who to find" }, els.modeButtons),
      h("label", { class: "location-picker", title: "Only show people based in this country" }, icon("pin", { size: 14 }), els.locationSelect),
      els.status
    ),
    els.results
  );
}

function setMode(mode) {
  if (!MODES[mode] || state.mode === mode) return;
  state.mode = mode;
  for (const btn of els.modeButtons) btn.setAttribute("aria-checked", String(btn.dataset.mode === mode));
  rerunWithNewFilters();
}

async function setLocation(code) {
  if (state.settings.location === code) return;
  state.settings.location = code;
  els.locationSelect.value = code;
  await store.saveSettings(state.settings);
  rerunWithNewFilters();
}

/** After a filter changes, repeat the current search for the same company (not a fresh name lookup). */
function rerunWithNewFilters() {
  const s = state.search;
  const typed = els.query.value.trim();
  if (!s || s.status === "error" || !typed) {
    if (!s) renderResults();
    return;
  }
  if (s.status === "done" && s.query === typed && (s.company.domain || s.company.name)) {
    state.selected = { name: s.company.name, domain: s.company.domain, label: typed };
  }
  submitSearch();
}

function onQueryInput() {
  const q = els.query.value.trim();
  if (state.selected && state.selected.label !== els.query.value.trim()) state.selected = null;
  clearTimeout(suggestTimer);
  if (q.length < 2 || looksLikeDomain(q)) {
    suggestAbort?.abort();
    state.suggestions = [];
    state.suggestionsFor = "";
    closeSuggestions();
    return;
  }
  suggestTimer = setTimeout(() => fetchSuggestions(q), 180);
}

async function fetchSuggestions(q) {
  suggestAbort?.abort();
  const controller = new AbortController();
  suggestAbort = controller;
  try {
    const list = await suggestCompanies({ url: endpoints.companies, query: q, signal: controller.signal });
    if (els.query.value.trim() !== q) return;
    state.suggestions = list;
    state.suggestionsFor = q;
    state.activeSuggestion = -1;
    if (document.activeElement === els.query) renderSuggestions();
  } catch (err) {
    if (err?.name === "AbortError") return;
    state.suggestions = [];
    closeSuggestions();
  }
}

function renderSuggestions() {
  const list = els.suggestions;
  list.replaceChildren();
  if (!state.suggestions.length) {
    closeSuggestions();
    return;
  }
  state.suggestions.forEach((company, i) => {
    list.append(
      h(
        "li",
        {
          id: `suggestion-${i}`,
          role: "option",
          class: "suggestion",
          "aria-selected": String(i === state.activeSuggestion),
          onmousedown: (e) => {
            e.preventDefault();
            chooseSuggestion(i);
          },
        },
        companyLogo(company.domain, company.name, "sm"),
        h("span", { class: "suggestion-name" }, company.name),
        h("span", { class: "suggestion-domain" }, company.domain)
      )
    );
  });
  list.hidden = false;
  els.query.setAttribute("aria-expanded", "true");
  if (state.activeSuggestion >= 0) els.query.setAttribute("aria-activedescendant", `suggestion-${state.activeSuggestion}`);
  else els.query.removeAttribute("aria-activedescendant");
}

function closeSuggestions() {
  els.suggestions.hidden = true;
  els.query.setAttribute("aria-expanded", "false");
  els.query.removeAttribute("aria-activedescendant");
}

function chooseSuggestion(index) {
  const company = state.suggestions[index];
  if (!company) return;
  els.query.value = company.name;
  state.selected = { name: company.name, domain: company.domain, label: company.name };
  closeSuggestions();
  submitSearch();
}

function onQueryKeydown(e) {
  const count = state.suggestions.length;
  const open = !els.suggestions.hidden && count > 0;
  if (e.key === "ArrowDown" && open) {
    e.preventDefault();
    state.activeSuggestion = (state.activeSuggestion + 1) % count;
    renderSuggestions();
  } else if (e.key === "ArrowUp" && open) {
    e.preventDefault();
    state.activeSuggestion = (state.activeSuggestion - 1 + count) % count;
    renderSuggestions();
  } else if (e.key === "Enter" && open && state.activeSuggestion >= 0) {
    e.preventDefault();
    chooseSuggestion(state.activeSuggestion);
  } else if (e.key === "Escape" && open) {
    e.preventDefault();
    closeSuggestions();
  }
}

async function resolveTarget(raw, signal) {
  if (state.selected && state.selected.label === raw) {
    return { name: state.selected.name, domain: state.selected.domain, guessed: false };
  }
  if (looksLikeDomain(raw)) return { name: "", domain: cleanDomain(raw), guessed: false };

  let list = state.suggestionsFor === raw ? state.suggestions : [];
  if (!list.length) {
    try {
      list = await suggestCompanies({ url: endpoints.companies, query: raw, signal });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      list = [];
    }
  }
  if (!list.length && connected("hunter")) {
    try {
      list = await hunterDomainFinder({ base: endpoints.hunter, apiKey: state.keys.hunter, company: raw, signal });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      list = [];
    }
  }
  const match = bestMatch(list, raw);
  if (!match) return { name: raw, domain: "", guessed: false };
  return {
    name: match.name,
    domain: match.domain,
    guessed: normalizeCompanyName(match.name) !== normalizeCompanyName(raw),
  };
}

async function submitSearch() {
  const raw = els.query.value.trim();
  if (!raw) {
    els.query.focus();
    return;
  }
  closeSuggestions();
  clearTimeout(suggestTimer);
  if (!anyConnected()) {
    renderResults();
    return;
  }

  searchAbort?.abort();
  const controller = new AbortController();
  searchAbort = controller;
  const mode = state.mode;
  const country = state.settings.location;
  state.search = { status: "loading", query: raw, mode, country };
  renderResults();

  try {
    const target = await resolveTarget(raw, controller.signal);
    state.search = { status: "loading", query: raw, mode, country, target };
    renderResults();
    const result = await searchCompany({
      target,
      mode,
      country,
      providers: providerConfig(),
      endpoints,
      signal: controller.signal,
    });
    applyCachedReveals(result.people);
    state.search = { status: "done", query: raw, mode, target, ...result };
    const company = result.company.name || result.company.domain ? result.company : target;
    state.recent = await store.pushRecent({ name: company.name, domain: company.domain });
  } catch (err) {
    if (err?.name === "AbortError") return;
    console.error(err);
    state.search = { status: "error", query: raw, mode, country, message: err?.message || "Something went wrong. Try again." };
  } finally {
    if (searchAbort === controller) searchAbort = null;
  }
  renderResults();
  if (connected("hunter")) refreshHunterAccount();
  if (state.search.status === "done") {
    const added = await autoSave(state.search.people);
    if (added) {
      showToast(`Added ${added} ${plural(added, "person", "people")} to your sheet`);
      if (state.search.status === "done") renderResults();
    }
  }
}

/** With auto-save on, everyone found with an email goes into the sheet. Resolves to the number of new rows. */
async function autoSave(people) {
  if (!state.settings.autoSave) return 0;
  const withEmail = people.filter((p) => p.email);
  if (!withEmail.length) return 0;
  const { list, added } = await store.addToSheet(withEmail);
  state.saved = list;
  updateSavedCount();
  if (state.view === "sheet") renderSheet();
  scheduleSync();
  return added;
}

function applyCachedReveals(people) {
  for (const person of people) {
    if (person.source === "apollo" && state.reveals[person.apolloId]) {
      Object.assign(person, state.reveals[person.apolloId]);
    }
  }
}

function runRecent(entry) {
  const label = entry.name || entry.domain;
  els.query.value = label;
  state.selected = { name: entry.name, domain: entry.domain, label };
  submitSearch();
}

async function refreshHunterAccount() {
  const hadPlan = Boolean(state.hunterAccount?.plan);
  try {
    state.hunterAccount = await hunterAccount({ base: endpoints.hunter, apiKey: state.keys.hunter });
    state.keyHealth.hunter = "ok";
  } catch (err) {
    state.hunterAccount = null;
    if (err?.code === "auth") state.keyHealth.hunter = "error";
  }
  renderStatus();
  renderKeyCards();
  const s = state.search;
  if (!hadPlan && state.hunterAccount?.plan && s?.status === "done" && s.paging.hunter?.hasMore) renderResults();
}

/* ---------- Results ---------- */

function renderStatus() {
  const chips = [];
  if (connected("hunter")) {
    const acct = state.hunterAccount;
    const left = acct && acct.remaining != null ? ` · ${acct.remaining} ${acct.unit} left` : "";
    chips.push(
      h(
        "span",
        { class: "source-chip", title: "Each company search costs 1 Hunter credit, only when it finds people." },
        h("span", { class: "dot" }),
        `Hunter${left}`
      )
    );
  }
  if (connected("apollo")) {
    chips.push(
      h(
        "span",
        { class: "source-chip", title: "Searching Apollo is free. Each email you reveal costs 1 Apollo credit." },
        h("span", { class: "dot" }),
        "Apollo · 1 credit per email"
      )
    );
  }
  els.status.replaceChildren(...chips);
  els.status.hidden = !chips.length;
}

function renderResults() {
  cardEls.clear();
  renderStatus();
  const s = state.search;
  let content;
  if (!anyConnected()) content = renderOnboarding();
  else if (!s) content = renderIdle();
  else if (s.status === "loading") content = renderLoading(s);
  else if (s.status === "error") content = renderFailure(s.message);
  else content = renderDone(s);
  els.results.replaceChildren(content);
}

function renderOnboarding() {
  const sourceCard = (provider, kicker, text) =>
    h(
      "div",
      { class: "source-card" },
      h("p", { class: "kicker" }, kicker),
      h("h3", {}, PROVIDER_INFO[provider].name),
      h("p", { class: "muted" }, text),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-primary btn-sm",
          onclick: () => {
            setView("settings");
            requestAnimationFrame(() => els.keyCards[provider].input.focus());
          },
        },
        icon("key", { size: 14 }),
        `Add ${PROVIDER_NAMES[provider]} key`
      )
    );

  return h(
    "div",
    { class: "onboarding" },
    h("h2", {}, "Connect a data source to start"),
    h(
      "p",
      { class: "muted" },
      "Scout doesn't keep its own database of people. It looks them up in Hunter or Apollo with your own API key, so you see the same verified emails those tools show. Both have free plans."
    ),
    h(
      "div",
      { class: "source-cards" },
      sourceCard("hunter", "Best place to start", "Emails come back instantly with verification and sources. 50 free credits a month."),
      sourceCard("apollo", "Already use Apollo?", "Search Apollo for free, then spend 1 Apollo credit for each email you reveal.")
    )
  );
}

function renderIdle() {
  const names = ["hunter", "apollo"].filter(connected).map((p) => PROVIDER_NAMES[p]);
  const place = locationLabel(state.settings.location);
  return h(
    "div",
    { class: "idle" },
    h("div", { class: "idle-mark", "aria-hidden": "true" }, icon("users", { size: 22 })),
    h("h2", {}, place ? `Find recruiters in ${place} at any company` : "Find recruiters at any company"),
    h(
      "p",
      { class: "muted" },
      "Type a company name like ",
      h("strong", {}, "Razorpay"),
      " or a website like ",
      h("strong", {}, "stripe.com"),
      `. Scout looks up their recruiters${place ? ` based in ${place}` : ""} and their work emails in ${names.join(" and ")}.`
    ),
    state.recent.length
      ? h(
          "div",
          { class: "recent" },
          h("span", { class: "recent-label" }, icon("history", { size: 13 }), "Recent"),
          state.recent.map((entry) =>
            h("button", { type: "button", class: "chip", onclick: () => runRecent(entry) }, entry.name || entry.domain)
          )
        )
      : null
  );
}

function renderLoading(s) {
  const who = s.target ? s.target.name || s.target.domain : s.query;
  const skeleton = () =>
    h(
      "div",
      { class: "person skeleton", "aria-hidden": "true" },
      h("span", { class: "sk sk-avatar" }),
      h(
        "div",
        { class: "sk-lines" },
        h("span", { class: "sk sk-line w55" }),
        h("span", { class: "sk sk-line w35" }),
        h("span", { class: "sk sk-line w70" })
      )
    );
  return h(
    "div",
    { class: "loading" },
    h(
      "p",
      { class: "loading-label", role: "status" },
      h("span", { class: "spinner" }),
      `Looking up ${MODES[s.mode].label.toLowerCase()}${s.country ? ` in ${locationLabel(s.country)}` : ""} at ${who}…`
    ),
    h("div", { class: "people" }, skeleton(), skeleton(), skeleton(), skeleton())
  );
}

function renderFailure(message) {
  return h(
    "div",
    { class: "empty" },
    h("h3", {}, "That search didn't go through"),
    h("p", { class: "muted" }, message),
    h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: submitSearch }, "Try again")
  );
}

function companyLabel(s) {
  return s.company.name || s.target?.name || s.company.domain || "this company";
}

function renderDone(s) {
  const enabledCount = ["hunter", "apollo"].filter(connected).length;
  const allFailed = s.errors.length > 0 && s.errors.length >= enabledCount && !s.people.length;
  const visible = state.verifiedOnly
    ? s.people.filter((p) => p.emailStatus === "verified" || (p.source === "apollo" && !p.revealed && p.hasEmail))
    : s.people;

  return h(
    "div",
    { class: "results-body" },
    companyHeader(s),
    s.errors.map((e) => alertBox("error", `${PROVIDER_NAMES[e.provider]}: ${e.message}`, errorAction(e))),
    s.notices.map((text) => alertBox("info", text)),
    s.hiddenFormer
      ? alertBox(
          "info",
          `Hid ${s.hiddenFormer} ${plural(s.hiddenFormer, "person", "people")} Apollo lists under ${companyLabel(s)} who now work somewhere else.`
        )
      : null,
    s.people.length ? resultsToolbar(s, visible) : allFailed ? null : renderNoPeople(s),
    s.people.length
      ? h(
          "div",
          { class: "people" },
          visible.map(personCard),
          visible.length
            ? null
            : h("p", { class: "empty-inline" }, "No verified emails here. Turn off “Verified only” to see everyone.")
        )
      : null,
    moreButtons(s)
  );
}

function companyHeader(s) {
  const name = companyLabel(s);
  const domain = s.company.domain;
  const count = s.people.length;
  return h(
    "div",
    { class: "company" },
    companyLogo(domain, name, "lg"),
    h(
      "div",
      { class: "company-text" },
      h("h2", { class: "company-name" }, name),
      h(
        "p",
        { class: "company-meta" },
        domain
          ? h("a", { href: `https://${domain}`, target: "_blank", rel: "noopener noreferrer" }, domain)
          : "Website unknown",
        ` · ${count} ${plural(count, "person", "people")} · ${MODES[s.mode].label}${s.country ? ` in ${locationLabel(s.country)}` : ""}`
      ),
      s.target?.guessed
        ? h("p", { class: "company-hint" }, "Not the company you meant? Type its website instead, like stripe.com.")
        : null
    )
  );
}

function alertBox(kind, text, action) {
  return h(
    "div",
    { class: `alert alert-${kind}`, role: kind === "error" ? "alert" : null },
    icon(kind === "error" ? "alert" : "info", { size: 15 }),
    h("p", {}, text, action ? " " : null, action)
  );
}

function errorAction(error) {
  if (!["auth", "forbidden", "quota"].includes(error.code)) return null;
  return h("button", { type: "button", class: "link-btn", onclick: () => setView("settings") }, "Open settings");
}

function renderNoPeople(s) {
  const name = companyLabel(s);
  const place = locationLabel(s.country);
  const where = place ? ` in ${place}` : "";
  const others = Object.keys(MODES).filter((m) => m !== s.mode);
  return h(
    "div",
    { class: "empty" },
    h("h3", {}, s.mode === "all" ? `No one${where} found at ${name}` : `No ${MODES[s.mode].label.toLowerCase()}${where} found at ${name}`),
    h(
      "p",
      { class: "muted" },
      !s.company.domain
        ? "Try the company's website instead of its name, like stripe.com."
        : place
          ? `Searched ${s.company.domain} for people based in ${place}. The company may have no team there, or the data source may not know where its people are.`
          : `Searched ${s.company.domain}. Smaller companies often have little public contact data.`
    ),
    h(
      "div",
      { class: "empty-actions" },
      place
        ? h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => setLocation("") }, "Search all locations")
        : null,
      others.map((m) =>
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => setMode(m) }, `Try ${MODES[m].label}`)
      )
    )
  );
}

function resultsToolbar(s, visible) {
  const emails = visible.filter((p) => p.email).map((p) => p.email);
  const locked = s.people.filter((p) => p.source === "apollo" && !p.revealed && p.hasEmail);
  const notInSheet = visible.filter((p) => p.email && !findSaved(p));
  return h(
    "div",
    { class: "results-toolbar" },
    h(
      "label",
      { class: "toggle" },
      h("input", {
        type: "checkbox",
        checked: state.verifiedOnly,
        onchange: (e) => {
          state.verifiedOnly = e.target.checked;
          renderResults();
        },
      }),
      h("span", { class: "toggle-track", "aria-hidden": "true" }),
      "Verified only"
    ),
    h(
      "div",
      { class: "toolbar-actions" },
      locked.length ? revealAllButton(locked) : null,
      notInSheet.length
        ? h(
            "button",
            { type: "button", class: "btn btn-ghost btn-sm", onclick: () => addPeopleToSheet(notInSheet) },
            icon("table", { size: 14 }),
            `Add ${notInSheet.length} to sheet`
          )
        : null,
      h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost btn-sm",
          disabled: !emails.length,
          onclick: () => copyText(emails.join("\n"), `Copied ${emails.length} ${plural(emails.length, "email", "emails")}`),
        },
        icon("copy", { size: 14 }),
        "Copy emails"
      )
    )
  );
}

function revealAllButton(people) {
  const n = people.length;
  const idleLabel = `Get ${n} Apollo ${plural(n, "email", "emails")}`;
  const label = h("span", {}, idleLabel);
  const btn = h("button", { type: "button", class: "btn btn-accent btn-sm" }, icon("unlock", { size: 14 }), label);
  let armed = false;
  let timer = 0;
  btn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      btn.classList.add("is-armed");
      label.textContent = `Confirm · up to ${n} ${plural(n, "credit", "credits")}`;
      timer = setTimeout(() => {
        armed = false;
        btn.classList.remove("is-armed");
        label.textContent = idleLabel;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    btn.disabled = true;
    revealMany(people);
  });
  return btn;
}

function moreButtons(s) {
  // Hunter's free plan rejects any page past the first 10 people, so offer no button there.
  const hunterCapped = /^free$/i.test(state.hunterAccount?.plan || "") && s.paging.hunter?.hasMore;
  const note = hunterCapped
    ? h(
        "p",
        { class: "more-note" },
        `Showing ${s.paging.hunter.offset} of the ${s.paging.hunter.total} people Hunter found. Its free plan shows up to 10 per company.`
      )
    : null;
  const buttons = ["hunter", "apollo"]
    .filter((provider) => s.paging[provider]?.hasMore && !(provider === "hunter" && hunterCapped))
    .map((provider) =>
      h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost",
          disabled: Boolean(state.loadingMore),
          onclick: () => loadMoreFrom(provider),
        },
        state.loadingMore === provider ? h("span", { class: "spinner" }) : null,
        `More from ${PROVIDER_NAMES[provider]} · ${provider === "hunter" ? "1 credit" : "free"}`
      )
    );
  return buttons.length || note ? h("div", { class: "more" }, note, buttons) : null;
}

async function loadMoreFrom(provider) {
  const s = state.search;
  if (!s || s.status !== "done" || state.loadingMore) return;
  state.loadingMore = provider;
  renderResults();
  try {
    await loadMore({ result: s, provider, providers: providerConfig(), endpoints });
    applyCachedReveals(s.people);
  } catch (err) {
    showToast(err?.message || "Couldn't load more people.");
  } finally {
    state.loadingMore = "";
    if (state.search === s) renderResults();
    if (provider === "hunter") refreshHunterAccount();
  }
  const added = await autoSave(s.people);
  if (added) {
    showToast(`Added ${added} more ${plural(added, "person", "people")} to your sheet`);
    if (state.search === s) renderResults();
  }
}

/* ---------- People ---------- */

function avatar(name) {
  let hash = 0;
  for (const ch of name || "") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return h("span", { class: `avatar tone-${hash % 6}`, "aria-hidden": "true" }, initials(name));
}

/** Hunter's logo service answers some unknown domains with a solid placeholder instead of a 404. */
function isBlankImage(img) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 12;
    canvas.height = 12;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 12, 12);
    const { data } = ctx.getImageData(0, 0, 12, 12);
    let first = "";
    for (let i = 0; i < data.length; i += 4) {
      const px = data[i + 3] < 24 ? "clear" : `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
      if (!first) first = px;
      else if (px !== first) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function companyLogo(domain, name, size) {
  const wrap = h("span", { class: `logo logo-${size}`, "aria-hidden": "true" }, initials(name || domain).slice(0, 1));
  if (!domain) return wrap;
  const img = h("img", { alt: "", crossorigin: "anonymous", referrerpolicy: "no-referrer", decoding: "async", src: logoUrl(domain) });
  img.addEventListener(
    "load",
    () => {
      if (isBlankImage(img)) img.remove();
      else wrap.classList.add("has-image");
    },
    { once: true }
  );
  img.addEventListener("error", () => img.remove(), { once: true });
  wrap.append(img);
  return wrap;
}

function iconButton(name, label, onClick, { pressed = null, filled = false } = {}) {
  return h(
    "button",
    {
      type: "button",
      class: `icon-btn${pressed ? " is-on" : ""}`,
      title: label,
      "aria-label": label,
      "aria-pressed": pressed === null ? null : String(pressed),
      onclick: onClick,
    },
    icon(name, { size: 15, filled })
  );
}

function iconLink(name, label, href) {
  return h(
    "a",
    { class: "icon-btn", href, title: label, "aria-label": label, target: "_blank", rel: "noopener noreferrer" },
    icon(name, { size: 15 })
  );
}

const mailHref = (email) => (isEmail(email) ? `mailto:${email}` : "");

function findSaved(person) {
  return state.saved.find((c) => c.id === person.id || (person.email && c.email === person.email));
}

function personCard(p) {
  const tag = roleTag(p.title);
  const saved = Boolean(findSaved(p));
  const linkedin = linkedinUrl(p.linkedin);
  const mail = mailHref(p.email);
  const card = h(
    "article",
    { class: "person" },
    avatar(p.name),
    h(
      "div",
      { class: "person-main" },
      h(
        "div",
        { class: "person-line" },
        h("span", { class: "person-name" }, p.name || "Name not listed"),
        tag ? h("span", { class: `tag tag-${tag.toLowerCase()}` }, tag) : null
      ),
      p.title ? h("p", { class: "person-title" }, p.title) : null,
      emailLine(p, mail),
      evidenceLine(p)
    ),
    h(
      "div",
      { class: "person-actions" },
      mail ? iconButton("copy", "Copy email", () => copyText(p.email, "Email copied")) : null,
      mail ? iconLink("mail", "Write an email", mail) : null,
      linkedin ? iconLink("linkedin", "Open LinkedIn profile", linkedin) : null,
      iconButton("bookmark", saved ? "In your sheet (click to remove)" : "Add to sheet", () => toggleSave(p), {
        pressed: saved,
        filled: saved,
      })
    )
  );
  cardEls.set(p.id, card);
  return card;
}

function emailLine(p, mail) {
  if (p.email) {
    const info = STATUS_INFO[p.emailStatus] || STATUS_INFO.unverified;
    return h(
      "div",
      { class: "email-line" },
      mail ? h("a", { class: "email", href: mail, title: "Write an email" }, p.email) : h("span", { class: "email" }, p.email),
      h(
        "span",
        { class: `badge badge-${info.cls}`, title: info.tip },
        p.emailStatus === "verified" ? icon("check", { size: 11 }) : null,
        info.label
      ),
      p.confidence != null
        ? h(
            "span",
            { class: "confidence", title: `${PROVIDER_NAMES[p.source]}'s confidence that this address is right` },
            `${p.confidence}%`
          )
        : null
    );
  }
  if (p.source !== "apollo") return null;
  if (state.revealing.has(p.apolloId)) {
    return h("div", { class: "email-line muted" }, h("span", { class: "spinner" }), "Getting email…");
  }
  if (p.revealed) return h("div", { class: "email-line muted" }, "Apollo has no email for this person.");
  if (!p.hasEmail) return h("div", { class: "email-line muted" }, "Apollo has no email on file for this person.");
  return h(
    "div",
    { class: "email-line" },
    h(
      "button",
      { type: "button", class: "btn btn-accent btn-xs", onclick: () => revealOne(p) },
      icon("unlock", { size: 13 }),
      p.revealError ? "Try again · 1 credit" : "Get email · 1 credit"
    ),
    p.revealError ? h("span", { class: "error-text" }, p.revealError) : null
  );
}

const INFERRED_NOTE = {
  verified: "mailbox confirmed",
  accept_all: "can't be fully confirmed",
  unverified: "not confirmed yet",
};

function patternExample(pattern, domain) {
  const local = String(pattern || "").replace(/[{}]/g, "");
  return local && domain ? `${local}@${domain}` : "";
}

function evidenceLine(p) {
  const via = h("span", { class: "via" }, `via ${PROVIDER_NAMES[p.source]}${p.alsoInApollo ? " + Apollo" : ""}`);
  if (p.source === "hunter" && p.provenance === "inferred") {
    const company = p.company || "the company";
    const example = patternExample(p.emailPattern, p.domain);
    return h(
      "p",
      {
        class: "evidence muted",
        title: `Hunter built this address from ${company}'s email format${example ? ` (${example})` : ""} and checked it with ${company}'s mail server.`,
      },
      `Follows ${company}'s email format · ${INFERRED_NOTE[p.emailStatus] || INFERRED_NOTE.unverified}`,
      " · ",
      via
    );
  }
  if (p.source === "hunter" && p.sources.length) {
    const n = p.sources.length;
    return h(
      "details",
      { class: "evidence" },
      h("summary", {}, icon("globe", { size: 12 }), `Email seen on ${n} public ${plural(n, "page", "pages")}`, " · ", via),
      h(
        "ul",
        { class: "evidence-list" },
        p.sources.slice(0, 8).map((source) => {
          const url = safeUrl(source.url);
          return h(
            "li",
            {},
            url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, shortUrl(url)) : source.domain,
            source.lastSeen ? h("span", { class: "muted" }, ` · seen ${formatMonth(source.lastSeen)}`) : null,
            source.live ? null : h("span", { class: "muted" }, " · since removed")
          );
        })
      )
    );
  }
  return h("p", { class: "evidence muted" }, via);
}

function refreshCard(person) {
  const old = cardEls.get(person.id);
  if (!old?.isConnected) return;
  const wasOpen = old.querySelector("details.evidence")?.open;
  const next = personCard(person);
  const details = next.querySelector("details.evidence");
  if (wasOpen && details) details.open = true;
  old.replaceWith(next);
}

async function revealOne(person, { batch = false } = {}) {
  if (!person.apolloId || state.revealing.has(person.apolloId)) return;
  state.revealing.add(person.apolloId);
  person.revealError = "";
  person.revealErrorCode = "";
  refreshCard(person);
  try {
    const patch = await apolloRevealPerson({ base: endpoints.apollo, apiKey: state.keys.apollo, apolloId: person.apolloId });
    Object.assign(person, patch);
    state.reveals = await store.putReveal(person.apolloId, patch);
    if (findSaved(person)) {
      state.saved = (await store.addToSheet([person])).list;
      scheduleSync();
    } else {
      await autoSave([person]);
    }
  } catch (err) {
    person.revealError = "Couldn't get this email.";
    person.revealErrorCode = err?.code || "error";
    if (!batch) showToast(err?.message || "Couldn't get this email.");
    else person.revealErrorMessage = err?.message || "";
  } finally {
    state.revealing.delete(person.apolloId);
    if (batch) refreshCard(person);
    else renderResults();
  }
}

async function revealMany(people) {
  const queue = people.filter((p) => !p.revealed && !state.revealing.has(p.apolloId));
  let fatal = null;
  const worker = async () => {
    while (queue.length && !fatal) {
      const person = queue.shift();
      await revealOne(person, { batch: true });
      if (FATAL_CODES.has(person.revealErrorCode)) fatal = person.revealErrorMessage;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (fatal) showToast(fatal);
  renderResults();
}

async function toggleSave(person) {
  const existing = findSaved(person);
  if (existing) {
    state.saved = await store.removeSaved(existing.id);
    showToast("Removed from your sheet");
  } else {
    state.saved = (await store.addToSheet([person])).list;
    showToast("Added to your sheet");
    scheduleSync();
  }
  updateSavedCount();
  refreshCard(person);
  if (state.view === "sheet") renderSheet();
}

async function addPeopleToSheet(people) {
  const { list, added } = await store.addToSheet(people);
  state.saved = list;
  updateSavedCount();
  scheduleSync();
  showToast(`Added ${added} ${plural(added, "person", "people")} to your sheet`);
  renderResults();
}

/* ---------- Sheet view ---------- */

function buildSheetView() {
  els.sheetCount = h("span", { class: "sheet-count" });
  els.sheetActions = h(
    "div",
    { class: "sheet-actions" },
    h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost btn-sm",
        title: "Copies every row so you can paste it into Google Sheets or Excel",
        onclick: copySheetTable,
      },
      icon("copy", { size: 14 }),
      "Copy table"
    ),
    h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: downloadCsv }, icon("download", { size: 14 }), "Download CSV")
  );
  els.sheetFilter = h("input", {
    type: "search",
    class: "input",
    placeholder: "Filter by company, name, or email",
    "aria-label": "Filter your sheet",
    oninput: (e) => {
      state.savedFilter = e.target.value;
      renderSheetRows();
    },
  });
  els.sheetSync = h("div", { class: "sheet-sync" });
  els.sheetBody = h("div", { class: "sheet-body" });
  return h(
    "section",
    { class: "view view-sheet", hidden: true },
    h("div", { class: "sheet-head" }, h("div", { class: "sheet-title" }, h("h2", {}, "Your sheet"), els.sheetCount), els.sheetActions),
    els.sheetSync,
    els.sheetFilter,
    els.sheetBody
  );
}

function updateSavedCount() {
  els.savedCount.textContent = String(state.saved.length);
  els.savedCount.hidden = state.saved.length === 0;
}

function renderSheet() {
  const count = state.saved.length;
  els.sheetCount.textContent = count ? `${count} ${plural(count, "row", "rows")}` : "";
  els.sheetActions.hidden = count === 0;
  els.sheetFilter.hidden = count === 0;
  renderSheetSync();
  renderSheetRows();
}

function renderSheetRows() {
  if (!state.saved.length) {
    els.sheetBody.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("h3", {}, "Your sheet is empty"),
        h(
          "p",
          { class: "muted" },
          state.settings.autoSave
            ? "Search for a company. Everyone Scout finds with an email is added here automatically, with their company, title, and email."
            : "Tap the bookmark on anyone in your search results to add them here."
        )
      )
    );
    return;
  }
  const q = state.savedFilter.trim().toLowerCase();
  const rows = q
    ? state.saved.filter((r) => [r.company, r.domain, r.name, r.title, r.email, r.location].join(" ").toLowerCase().includes(q))
    : state.saved;
  if (!rows.length) {
    els.sheetBody.replaceChildren(h("p", { class: "empty-inline" }, "No rows match that filter."));
    return;
  }
  els.sheetBody.replaceChildren(
    h(
      "table",
      { class: "sheet-table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ["Company", "Name", "Title", "Email", "Status", "Location", "Added"].map((label) => h("th", { scope: "col" }, label)),
          h("th", { scope: "col" }, h("span", { class: "sr-only" }, "Actions"))
        )
      ),
      h("tbody", {}, rows.map(sheetRow))
    )
  );
}

function sheetRow(row) {
  const mail = mailHref(row.email);
  const linkedin = linkedinUrl(row.linkedin);
  const info = STATUS_INFO[row.emailStatus];
  return h(
    "tr",
    {},
    h("td", { class: "c-company" }, row.company || row.domain || "—"),
    h("td", { class: "c-name" }, row.name || "Name not listed"),
    h("td", { class: "c-title" }, row.title),
    h(
      "td",
      { class: "c-email" },
      row.email
        ? mail
          ? h("a", { class: "email", href: mail }, row.email)
          : h("span", { class: "email" }, row.email)
        : h("span", { class: "muted" }, "No email yet")
    ),
    h("td", { class: "c-status" }, info ? h("span", { class: `badge badge-${info.cls}`, title: info.tip }, info.label) : null),
    h("td", { class: "c-location" }, row.location || ""),
    h("td", { class: "c-added" }, formatShortDate(row.savedAt)),
    h(
      "td",
      { class: "c-actions" },
      mail ? iconButton("copy", "Copy email", () => copyText(row.email, "Email copied")) : null,
      linkedin ? iconLink("linkedin", "Open LinkedIn profile", linkedin) : null,
      iconButton("trash", "Remove from sheet", () => removeRow(row))
    )
  );
}

async function removeRow(row) {
  state.saved = await store.removeSaved(row.id);
  updateSavedCount();
  renderSheet();
  if (state.search?.status === "done") renderResults();
}

function renderSheetSync() {
  if (!els.sheetSync || !state.settings) return;
  const sheets = state.settings.sheets;
  if (!sheets.url) {
    els.sheetSync.replaceChildren(
      h(
        "p",
        { class: "sync-line" },
        icon("info", { size: 14 }),
        "Stored in this browser. ",
        h("button", { type: "button", class: "link-btn", onclick: openSheetsSetup }, "Also send it to Google Sheets")
      )
    );
    return;
  }
  const pending = pendingRows(state.saved).length;
  const where = sheets.name ? `“${sheets.name}”` : "your Google Sheet";
  const link = safeUrl(sheets.link);
  const open = link
    ? h("a", { class: "ext-link", href: link, target: "_blank", rel: "noopener noreferrer" }, "Open sheet", icon("external", { size: 11 }))
    : null;
  const retry = (label) => h("button", { type: "button", class: "link-btn", onclick: () => syncSheet({ manual: true }) }, label);

  let line;
  if (state.syncing) {
    line = h("p", { class: "sync-line" }, h("span", { class: "spinner" }), `Sending rows to ${where}…`);
  } else if (sheets.lastError) {
    line = h(
      "div",
      { class: "alert alert-error", role: "alert" },
      icon("alert", { size: 15 }),
      h("p", {}, `Couldn't send rows to Google Sheets. ${sheets.lastError} `, retry("Try again"))
    );
  } else if (pending) {
    line = h("p", { class: "sync-line" }, `${pending} ${plural(pending, "row", "rows")} waiting to go to ${where}. `, retry("Send now"));
  } else {
    line = h(
      "p",
      { class: "sync-line is-ok" },
      icon("check", { size: 14 }),
      `All rows are in ${where}`,
      sheets.lastSyncAt ? ` · updated ${timeAgo(sheets.lastSyncAt)}` : "",
      open ? " · " : "",
      open
    );
  }
  els.sheetSync.replaceChildren(line);
}

function copySheetTable() {
  if (!state.saved.length) return;
  copyText(toTsv(state.saved), `Copied ${state.saved.length} ${plural(state.saved.length, "row", "rows")}. Paste into any spreadsheet.`);
}

function downloadCsv() {
  if (!state.saved.length) return;
  const blob = new Blob(["\ufeff", toCsv(state.saved)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: `scout-sheet-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- Google Sheets sync ---------- */

const sheetsConnected = () => Boolean(state.settings?.sheets.url);

function sheetsEndpoint(url) {
  return runtime === "extension" ? url : "/api/sheets";
}

function scheduleSync(delay = 800) {
  if (!sheetsConnected()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncSheet(), delay);
}

async function syncSheet({ manual = false, all = false } = {}) {
  if (!sheetsConnected()) return;
  if (syncRun) {
    syncAgain = true;
    return;
  }
  syncRun = runSync({ manual, all });
  try {
    await syncRun;
  } finally {
    syncRun = null;
    if (syncAgain) {
      syncAgain = false;
      scheduleSync(300);
    }
  }
}

async function runSync({ manual, all }) {
  const sheets = state.settings.sheets;
  const rows = all ? state.saved.filter((r) => r.email) : pendingRows(state.saved);
  if (!rows.length) {
    if (manual) showToast("Google Sheets already has every row");
    return;
  }
  state.syncing = true;
  renderSheetSync();
  renderSheetSettings();
  let added = 0;
  try {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const reply = await postToSheet({
        endpoint: sheetsEndpoint(sheets.url),
        sheetUrl: sheets.url,
        secret: sheets.secret,
        rows: chunk.map(toPayloadRow),
      });
      added += Number(reply.added) || 0;
      if (reply.name) sheets.name = reply.name;
      if (reply.url) sheets.link = reply.url;
      state.saved = await store.markRowsSynced(chunk.map((r) => r.id), new Date().toISOString());
    }
    sheets.lastSyncAt = new Date().toISOString();
    sheets.lastError = "";
    if (manual || all) {
      showToast(added ? `Sent ${added} new ${plural(added, "row", "rows")} to Google Sheets` : "Google Sheets already had these rows");
    }
  } catch (err) {
    sheets.lastError = err?.message || "Something went wrong.";
    if (manual || all) showToast(sheets.lastError);
  } finally {
    state.syncing = false;
    await store.saveSettings(state.settings);
    renderSheetSync();
    renderSheetSettings();
  }
}

function openSheetsSetup() {
  setView("settings");
  requestAnimationFrame(() => {
    els.sheets.card.scrollIntoView({ block: "start", behavior: "smooth" });
    els.sheets.input.focus({ preventScroll: true });
  });
}

/* ---------- Settings view ---------- */

function buildSettingsView() {
  els.keyCards = {};
  const privacy =
    runtime === "extension"
      ? "Your API keys and your sheet are stored only in this browser. Searches go straight from your browser to Hunter or Apollo, and company suggestions come from Clearbit's public autocomplete. If you connect Google Sheets, rows also go to your own sheet through your Apps Script."
      : "Your API keys and your sheet are stored only in this browser. Searches go through the Scout server running on your computer to Hunter or Apollo, and company suggestions come from Clearbit's public autocomplete. If you connect Google Sheets, rows also go to your own sheet through your Apps Script.";

  return h(
    "section",
    { class: "view view-settings", hidden: true },
    h(
      "div",
      { class: "settings-intro" },
      h("h2", {}, "Data sources"),
      h(
        "p",
        { class: "muted" },
        "Add at least one API key. Scout sends each search to these services and shows exactly what they return. Nothing is made up or guessed by Scout."
      )
    ),
    buildKeyCard("hunter"),
    buildKeyCard("apollo"),
    h("div", { class: "settings-intro" }, h("h2", {}, "Your sheet")),
    buildSheetCard(),
    buildGoogleSheetsCard(),
    h("div", { class: "card" }, h("h3", {}, "Privacy"), h("p", { class: "muted" }, privacy))
  );
}

function buildSheetCard() {
  const toggle = h("input", {
    type: "checkbox",
    checked: state.settings.autoSave,
    onchange: async (e) => {
      state.settings.autoSave = e.target.checked;
      await store.saveSettings(state.settings);
      showToast(e.target.checked ? "New people with emails will be added automatically" : "Auto-add is off. Use the bookmark to add people.");
      if (state.view === "sheet") renderSheet();
    },
  });

  const clearLabel = h("span", {}, "Delete all rows");
  const clearBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm danger-text" }, icon("trash", { size: 14 }), clearLabel);
  let armed = false;
  let timer = 0;
  clearBtn.addEventListener("click", async () => {
    if (!state.saved.length) {
      showToast("Your sheet is already empty");
      return;
    }
    if (!armed) {
      armed = true;
      clearLabel.textContent = `Click again to delete ${state.saved.length} ${plural(state.saved.length, "row", "rows")}`;
      timer = setTimeout(() => {
        armed = false;
        clearLabel.textContent = "Delete all rows";
      }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    clearLabel.textContent = "Delete all rows";
    state.saved = await store.clearSaved();
    updateSavedCount();
    showToast("Your sheet is empty now");
    if (state.search?.status === "done") renderResults();
  });

  els.autoSaveToggle = toggle;
  return h(
    "div",
    { class: "card" },
    h("h3", {}, "Sheet in this browser"),
    h(
      "p",
      { class: "muted" },
      "Scout keeps a sheet of the people you find (company, name, title, email, and status) in this browser. Open the Sheet tab to copy it into a spreadsheet or download it as a CSV for Excel or Google Sheets."
    ),
    h(
      "label",
      { class: "toggle toggle-row" },
      toggle,
      h("span", { class: "toggle-track", "aria-hidden": "true" }),
      "Add everyone Scout finds with an email automatically"
    ),
    h("div", { class: "card-actions" }, clearBtn)
  );
}

function buildGoogleSheetsCard() {
  const input = h("input", {
    type: "url",
    class: "input mono",
    placeholder: "https://script.google.com/macros/s/…/exec",
    autocomplete: "off",
    spellcheck: "false",
    value: state.settings.sheets.url,
    "aria-label": "Google Apps Script Web app URL",
    onkeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        connectSheets();
      }
    },
  });
  const badge = h("span", { class: "badge" });
  const status = h("p", { class: "key-status", "aria-live": "polite" });
  const connectBtn = h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: connectSheets }, "Connect");
  const resendBtn = h(
    "button",
    { type: "button", class: "btn btn-ghost btn-sm", onclick: () => syncSheet({ manual: true, all: true }) },
    "Send all rows again"
  );
  const disconnectBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm danger-text", onclick: disconnectSheets }, "Disconnect");
  const copyScript = () => copyText(buildScript(state.settings.sheets.secret), "Script copied. Paste it into Apps Script.");
  const card = h(
    "div",
    { class: "card key-card", id: "google-sheets" },
    h("div", { class: "key-head" }, h("h3", {}, "Google Sheets"), badge),
    h(
      "p",
      {},
      "Send every row to a Google Sheet you own. Setup takes about two minutes and doesn't need a Google Cloud project."
    ),
    h(
      "ol",
      { class: "steps" },
      h(
        "li",
        {},
        "Create a new Google Sheet. ",
        h("a", { class: "ext-link", href: "https://sheets.new", target: "_blank", rel: "noopener noreferrer" }, "Open sheets.new", icon("external", { size: 11 }))
      ),
      h(
        "li",
        {},
        "In that sheet, open ",
        h("strong", {}, "Extensions → Apps Script"),
        ", delete the sample code, and paste Scout's script. ",
        h("button", { type: "button", class: "btn btn-ghost btn-xs", onclick: copyScript }, icon("copy", { size: 13 }), "Copy script")
      ),
      h(
        "li",
        {},
        "Click ",
        h("strong", {}, "Deploy → New deployment"),
        ", pick ",
        h("strong", {}, "Web app"),
        ", set Execute as ",
        h("strong", {}, "Me"),
        " and Who has access ",
        h("strong", {}, "Anyone"),
        ", then Deploy. When Google asks, allow access. It may warn that the app isn't verified because you made it yourself; choose Advanced → Go to the project."
      ),
      h("li", {}, "Copy the ", h("strong", {}, "Web app URL"), " and paste it here:")
    ),
    h("div", { class: "key-row" }, input, connectBtn),
    status,
    h("div", { class: "card-actions" }, resendBtn, disconnectBtn),
    h(
      "details",
      { class: "script-preview" },
      h("summary", {}, "See the script"),
      h("pre", {}, buildScript(state.settings.sheets.secret))
    ),
    h(
      "p",
      { class: "muted small" },
      "Scout only adds rows, and skips emails already in the sheet. Deleting a row in Scout doesn't delete it from Google Sheets. The script contains a secret code, so only your Scout can write to it."
    )
  );
  els.sheets = { card, input, badge, status, connectBtn, resendBtn, disconnectBtn };
  return card;
}

function renderSheetSettings() {
  if (!els.sheets || !state.settings) return;
  const sheets = state.settings.sheets;
  const { badge, status, resendBtn, disconnectBtn, connectBtn } = els.sheets;
  if (!sheets.url) {
    badge.className = "badge badge-muted";
    badge.textContent = "Not connected";
  } else if (sheets.lastError) {
    badge.className = "badge badge-danger";
    badge.textContent = "Not working";
  } else {
    badge.className = "badge badge-ok";
    badge.textContent = "Connected";
  }
  resendBtn.hidden = !sheets.url;
  disconnectBtn.hidden = !sheets.url;
  resendBtn.disabled = state.syncing;
  connectBtn.textContent = sheets.url ? "Reconnect" : "Connect";
  if (els.autoSaveToggle) els.autoSaveToggle.checked = state.settings.autoSave;
  if (!status.dataset.pinned) {
    if (sheets.url && sheets.lastError) setSheetsStatus(sheets.lastError, "error", false);
    else if (sheets.url) setSheetsStatus(`Connected to ${sheets.name ? `“${sheets.name}”` : "your sheet"}. Rows go to its “${SHEET_TAB_NAME}” tab.`, "ok", false);
    else setSheetsStatus("", "", false);
  }
}

function setSheetsStatus(text, kind = "", pin = true) {
  const { status } = els.sheets;
  status.textContent = text;
  status.className = `key-status${kind ? ` is-${kind}` : ""}`;
  if (pin) status.dataset.pinned = "1";
  else delete status.dataset.pinned;
}

async function connectSheets() {
  const url = els.sheets.input.value.trim();
  if (!isAppsScriptUrl(url)) {
    setSheetsStatus(
      "That doesn't look like an Apps Script Web app URL. It starts with https://script.google.com/macros/s/ and ends with /exec.",
      "error"
    );
    return;
  }
  const sheets = state.settings.sheets;
  const changed = sheets.url !== url;
  els.sheets.connectBtn.disabled = true;
  setSheetsStatus("Checking your sheet…", "pending");
  try {
    const reply = await postToSheet({ endpoint: sheetsEndpoint(url), sheetUrl: url, secret: sheets.secret, action: "ping" });
    Object.assign(sheets, { url, name: reply.name || "", link: reply.url || "", lastError: "" });
    if (changed) state.saved = await store.resetSynced();
    await store.saveSettings(state.settings);
    delete els.sheets.status.dataset.pinned;
    renderSheetSettings();
    renderSheetSync();
    showToast("Google Sheets connected");
    await syncSheet();
  } catch (err) {
    setSheetsStatus(err?.message || "Couldn't reach your sheet.", "error");
  } finally {
    els.sheets.connectBtn.disabled = false;
  }
}

async function disconnectSheets() {
  Object.assign(state.settings.sheets, { url: "", name: "", link: "", lastSyncAt: "", lastError: "" });
  await store.saveSettings(state.settings);
  els.sheets.input.value = "";
  delete els.sheets.status.dataset.pinned;
  renderSheetSettings();
  renderSheetSync();
  showToast("Google Sheets disconnected. Your sheet in Scout is unchanged.");
}

function buildKeyCard(provider) {
  const info = PROVIDER_INFO[provider];
  const input = h("input", {
    type: "password",
    class: "input mono",
    placeholder: info.placeholder,
    autocomplete: "off",
    spellcheck: "false",
    value: state.keys[provider],
    "aria-label": `${info.name} API key`,
    onkeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveKey(provider);
      }
    },
  });
  const toggle = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Show");
  toggle.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide" : "Show";
  });
  const badge = h("span", { class: "badge" });
  const status = h("p", { class: "key-status", "aria-live": "polite" });
  const testBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => testKey(provider) }, "Test connection");
  const removeBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm danger-text", onclick: () => removeKey(provider) }, "Remove");
  els.keyCards[provider] = { input, badge, status, testBtn, removeBtn };

  return h(
    "div",
    { class: "card key-card" },
    h("div", { class: "key-head" }, h("h3", {}, info.name), badge),
    h("p", {}, info.blurb),
    h("p", { class: "muted small" }, info.pricing),
    h("div", { class: "key-row" }, input, toggle),
    state.serverKeys[provider]
      ? h(
          "p",
          { class: "muted small" },
          `This Scout server already has ${provider.toUpperCase()}_API_KEY set. Leave this empty to use it.`
        )
      : null,
    h(
      "div",
      { class: "card-actions" },
      h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => saveKey(provider) }, "Save"),
      testBtn,
      removeBtn
    ),
    status,
    h(
      "p",
      { class: "muted small" },
      info.keySteps,
      " ",
      h("a", { class: "ext-link", href: info.keyUrl, target: "_blank", rel: "noopener noreferrer" }, info.keyLinkLabel, icon("external", { size: 11 }))
    )
  );
}

function renderKeyCards() {
  for (const provider of ["hunter", "apollo"]) {
    const card = els.keyCards?.[provider];
    if (!card) continue;
    const own = Boolean(state.keys[provider]);
    const viaServer = !own && state.serverKeys[provider];
    const health = state.keyHealth[provider];
    let badge = ["muted", "Not connected"];
    if (own || viaServer) {
      if (health === "error") badge = ["danger", "Key not working"];
      else if (health === "ok") badge = ["ok", viaServer ? "Using server key" : "Connected"];
      else badge = ["muted", viaServer ? "Using server key" : "Key saved"];
    }
    card.badge.className = `badge badge-${badge[0]}`;
    card.badge.textContent = badge[1];
    card.removeBtn.hidden = !own;
    card.testBtn.disabled = !connected(provider);
  }
}

function setKeyStatus(provider, text, kind = "") {
  const { status } = els.keyCards[provider];
  status.textContent = text;
  status.className = `key-status${kind ? ` is-${kind}` : ""}`;
}

async function saveKey(provider) {
  const value = els.keyCards[provider].input.value.trim();
  state.keys = await store.setKey(provider, value);
  state.keyHealth[provider] = "";
  renderKeyCards();
  renderResults();
  if (!connected(provider)) {
    setKeyStatus(provider, "Key removed.");
    return;
  }
  await testKey(provider);
}

async function removeKey(provider) {
  els.keyCards[provider].input.value = "";
  if (provider === "hunter") state.hunterAccount = null;
  await saveKey(provider);
}

async function testKey(provider) {
  if (!connected(provider)) {
    setKeyStatus(provider, "Paste a key first.", "error");
    return;
  }
  const { testBtn } = els.keyCards[provider];
  testBtn.disabled = true;
  setKeyStatus(provider, "Checking…", "pending");
  try {
    if (provider === "hunter") {
      const acct = await hunterAccount({ base: endpoints.hunter, apiKey: state.keys.hunter });
      state.hunterAccount = acct;
      const parts = ["Connected"];
      if (acct.plan) parts.push(`${acct.plan} plan`);
      if (acct.remaining != null) parts.push(`${acct.remaining} ${acct.unit} left`);
      if (acct.resetDate) parts.push(`resets ${formatDay(acct.resetDate)}`);
      setKeyStatus(provider, parts.join(" · "), "ok");
      renderStatus();
    } else {
      await apolloCheckAccess({ base: endpoints.apollo, apiKey: state.keys.apollo });
      setKeyStatus(provider, "Connected · people search works (searching is free).", "ok");
    }
    state.keyHealth[provider] = "ok";
  } catch (err) {
    setKeyStatus(provider, err?.message || "Couldn't connect.", "error");
    if (["auth", "forbidden"].includes(err?.code)) state.keyHealth[provider] = "error";
  } finally {
    testBtn.disabled = !connected(provider);
    renderKeyCards();
  }
}

/* ---------- Helpers ---------- */

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h("textarea", { class: "sr-only", "aria-hidden": "true" });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast(message);
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}

function parseDay(value) {
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function formatMonth(value) {
  const d = parseDay(value);
  return d ? d.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : String(value);
}

function formatDay(value) {
  const d = parseDay(value);
  return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : String(value);
}

function formatShortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return formatShortDate(iso);
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const text = u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
    return text.length > 56 ? `${text.slice(0, 55)}…` : text;
  } catch {
    return url;
  }
}
