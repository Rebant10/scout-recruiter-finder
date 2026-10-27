import { ProviderError, defaultFetch, requestJson } from "./http.js";
import { isEmail, joinName } from "../util.js";

/** People search is free (0 credits); revealing one person's email costs 1 credit. */
export const APOLLO_PAGE_SIZE = 25;

function headersFor(apiKey) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

export function apolloError(status, body, text = "") {
  const detail = (body && (body.error || body.message)) || "";
  switch (true) {
    case status === 401:
      return new ProviderError("apollo", "auth", "Apollo didn't accept your API key.", status);
    case status === 403:
      return new ProviderError(
        "apollo",
        "forbidden",
        "Apollo blocked this for your account. Free Apollo accounts must be registered with a work email to use API search, and your key needs access to People Search and People Enrichment (or be a master key).",
        status
      );
    case status === 429:
      return new ProviderError(
        "apollo",
        "rate_limited",
        "Apollo's rate limit was hit (free plan: 50 a minute, 200 an hour, 600 a day). Try again later.",
        status
      );
    case status === 422:
      return new ProviderError("apollo", "invalid", detail || "Apollo rejected the search filters.", status);
    case status >= 500:
      return new ProviderError("apollo", "server", "Apollo is having trouble right now. Try again in a minute.", status);
    default:
      return new ProviderError(
        "apollo",
        "error",
        detail || (text && text.length < 200 ? text : "") || `Apollo returned an error (HTTP ${status}).`,
        status
      );
  }
}

export function parsePeopleSearch(json, domain = "") {
  const people = (Array.isArray(json?.people) ? json.people : [])
    .filter((p) => p && p.id)
    .map((p) => ({
      id: `apollo:${p.id}`,
      source: "apollo",
      apolloId: p.id,
      firstName: p.first_name || "",
      lastName: "",
      lastNameMasked: p.last_name_obfuscated || "",
      name: joinName(p.first_name, p.last_name_obfuscated),
      title: p.title || "",
      email: "",
      emailStatus: "",
      hasEmail: p.has_email !== false,
      revealed: false,
      company: p.organization?.name || "",
      domain,
      linkedin: "",
      phone: "",
      sources: [],
      confidence: null,
    }));
  const rawTotal = json?.total_entries ?? json?.pagination?.total_entries;
  const total = Number.isFinite(Number(rawTotal)) ? Number(rawTotal) : people.length;
  return { people, total };
}

/** `locations` are place names people live in, e.g. ["india"]. */
export async function apolloPeopleSearch({
  base,
  apiKey,
  domain,
  titles = [],
  locations = [],
  page = 1,
  perPage = APOLLO_PAGE_SIZE,
  fetchImpl = defaultFetch,
  signal,
}) {
  const params = new URLSearchParams();
  params.append("q_organization_domains_list[]", domain);
  for (const title of titles) params.append("person_titles[]", title);
  if (titles.length) params.set("include_similar_titles", "true");
  for (const place of locations) params.append("person_locations[]", place);
  params.set("page", String(page));
  params.set("per_page", String(perPage));
  const json = await requestJson({
    provider: "apollo",
    url: `${base}/mixed_people/api_search?${params}`,
    method: "POST",
    headers: headersFor(apiKey),
    body: "{}",
    fetchImpl,
    signal,
    mapError: apolloError,
  });
  return parsePeopleSearch(json, domain);
}

function emailStatus(status) {
  return String(status || "").toLowerCase() === "verified" ? "verified" : "unverified";
}

/** Apollo returns placeholders like "email_not_unlocked@domain.com" when it won't reveal. */
export function parseReveal(json) {
  const p = json?.person;
  if (!p) {
    throw new ProviderError("apollo", "not_found", "Apollo couldn't match this person anymore. No email was revealed.");
  }
  const raw = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
  const email = isEmail(raw) && !/not_unlocked|@domain\.com$/.test(raw) ? raw : "";
  const patch = {
    firstName: p.first_name || "",
    lastName: p.last_name || "",
    name: p.name || joinName(p.first_name, p.last_name),
    title: p.title || "",
    email,
    emailStatus: email ? emailStatus(p.email_status) : "",
    linkedin: p.linkedin_url || "",
    revealed: true,
  };
  const place = [p.city, p.country].filter((v) => typeof v === "string" && v.trim()).join(", ");
  if (place) patch.location = place;
  return patch;
}

export async function apolloRevealPerson({ base, apiKey, apolloId, fetchImpl = defaultFetch, signal }) {
  const params = new URLSearchParams({ id: apolloId });
  const json = await requestJson({
    provider: "apollo",
    url: `${base}/people/match?${params}`,
    method: "POST",
    headers: headersFor(apiKey),
    body: "{}",
    fetchImpl,
    signal,
    mapError: apolloError,
  });
  return parseReveal(json);
}

/** Uses only free calls: auth check, then a 1-result people search. */
export async function apolloCheckAccess({ base, apiKey, fetchImpl = defaultFetch, signal }) {
  const health = await requestJson({
    provider: "apollo",
    url: `${base}/auth/health`,
    headers: headersFor(apiKey),
    fetchImpl,
    signal,
    mapError: apolloError,
  });
  if (!health?.is_logged_in) {
    throw new ProviderError("apollo", "auth", "Apollo didn't accept your API key.");
  }
  await apolloPeopleSearch({ base, apiKey, domain: "apollo.io", perPage: 1, fetchImpl, signal });
  return { ok: true };
}
