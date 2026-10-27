import { ProviderError, defaultFetch, requestJson } from "./http.js";
import { cleanDomain, isEmail, joinName } from "../util.js";

/** Hunter's API charges 1 credit per 1–10 emails returned, so pages of 10 cost 1 credit each. */
export const HUNTER_PAGE_SIZE = 10;

function headersFor(apiKey) {
  const headers = { Accept: "application/json" };
  if (apiKey) headers["X-API-KEY"] = apiKey;
  return headers;
}

export function hunterError(status, body) {
  const first = Array.isArray(body?.errors) ? body.errors[0] : null;
  const id = first?.id || "";
  const details = first?.details || "";
  switch (true) {
    case status === 401:
      return new ProviderError("hunter", "auth", "Hunter didn't accept your API key.", status);
    case status === 429:
      return new ProviderError(
        "hunter",
        "quota",
        "You're out of Hunter credits for this month. They reset on your plan's renewal date.",
        status
      );
    case status === 403:
      return new ProviderError(
        "hunter",
        "rate_limited",
        "Hunter is limiting requests right now. Wait a few seconds and try again.",
        status
      );
    case status === 451:
      return new ProviderError("hunter", "legal", "Hunter can't share data for this company or person.", status);
    case status === 400 && id === "pagination_error":
      return new ProviderError(
        "hunter",
        "pagination",
        "Hunter's free plan shows up to 10 people per company.",
        status
      );
    case status >= 500:
      return new ProviderError("hunter", "server", "Hunter is having trouble right now. Try again in a minute.", status);
    default:
      return new ProviderError(
        "hunter",
        id || "bad_request",
        details || `Hunter returned an error (HTTP ${status}).`,
        status
      );
  }
}

function verificationStatus(status) {
  if (status === "valid") return "verified";
  if (status === "accept_all") return "accept_all";
  return "unverified";
}

/**
 * Hunter lists where it found the *person* too, as Google "site:linkedin.com" searches.
 * Those pages never show the email, so they don't count as places the email was seen.
 */
function isProfileLookup(uri) {
  try {
    const url = new URL(uri);
    return /(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === "/search";
  } catch {
    return true;
  }
}

function toPerson(entry, company) {
  const email = String(entry.value).trim().toLowerCase();
  return {
    id: `hunter:${email}`,
    source: "hunter",
    firstName: entry.first_name || "",
    lastName: entry.last_name || "",
    name: joinName(entry.first_name, entry.last_name),
    title: entry.position || entry.position_raw || "",
    department: entry.department || "",
    seniority: entry.seniority || "",
    email,
    emailType: entry.type || "personal",
    emailStatus: verificationStatus(entry.verification?.status),
    verifiedOn: entry.verification?.date || "",
    confidence: Number.isFinite(entry.confidence) ? entry.confidence : null,
    provenance: entry.provenance || entry.source_type || "",
    sources: (Array.isArray(entry.sources) ? entry.sources : [])
      .filter((s) => s && s.uri && !isProfileLookup(s.uri))
      .map((s) => ({
        url: s.uri,
        domain: s.domain || "",
        lastSeen: s.last_seen_on || s.extracted_on || "",
        live: s.still_on_page !== false,
      })),
    linkedin: entry.linkedin || "",
    phone: entry.phone_number || "",
    company: company.name,
    domain: company.domain,
    emailPattern: company.pattern,
    hasEmail: true,
    revealed: true,
  };
}

export function parseDomainSearch(json) {
  const data = json?.data || {};
  const meta = json?.meta || {};
  const company = {
    name: data.organization || "",
    domain: data.domain || "",
    pattern: data.pattern || "",
    acceptAll: Boolean(data.accept_all),
  };
  const people = (Array.isArray(data.emails) ? data.emails : [])
    .filter((e) => e && isEmail(String(e.value || "").trim()))
    .map((e) => toPerson(e, company));
  const offset = Number(meta.offset) || 0;
  const total = Number.isFinite(Number(meta.results)) ? Number(meta.results) : people.length;
  return { company, people, total, offset };
}

/** `country` is an ISO 3166-1 alpha-2 code ("IN") that limits results to people based there. */
export async function hunterDomainSearch({
  base,
  apiKey,
  domain = "",
  company = "",
  filters = {},
  country = "",
  offset = 0,
  limit = HUNTER_PAGE_SIZE,
  fetchImpl = defaultFetch,
  signal,
}) {
  const query = {};
  if (domain) query.domain = domain;
  else if (company) query.company = company;
  else throw new ProviderError("hunter", "missing_company", "Type a company name or website first.");
  query.limit = limit;
  if (offset) query.offset = offset;
  for (const [key, value] of Object.entries(filters)) {
    if (value) query[key] = value;
  }

  // Hunter only accepts the location filter in a JSON POST body.
  const request = country
    ? {
        url: `${base}/domain-search`,
        method: "POST",
        headers: { ...headersFor(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({ ...query, location: { include: [{ country }] } }),
      }
    : {
        url: `${base}/domain-search?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`,
        headers: headersFor(apiKey),
      };

  const json = await requestJson({ provider: "hunter", ...request, fetchImpl, signal, mapError: hunterError });
  return parseDomainSearch(json);
}

export function parseAccount(json) {
  const data = json?.data || {};
  const requests = data.requests || {};
  const pool = requests.credits || requests.searches || null;
  const toNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  let remaining = pool ? toNumber(pool.remaining) : null;
  if (remaining === null && pool) {
    const available = toNumber(pool.available);
    const used = toNumber(pool.used);
    if (available !== null && used !== null) remaining = Math.max(0, available - used);
  }
  return {
    email: data.email || "",
    plan: data.plan_name || "",
    resetDate: data.reset_date ? String(data.reset_date) : "",
    remaining: remaining === null ? null : Math.floor(remaining),
    available: pool ? toNumber(pool.available) : null,
    unit: requests.credits ? "credits" : "searches",
  };
}

/** Free call: plan name and how many credits are left this month. */
export async function hunterAccount({ base, apiKey, fetchImpl = defaultFetch, signal }) {
  const json = await requestJson({
    provider: "hunter",
    url: `${base}/account`,
    headers: headersFor(apiKey),
    fetchImpl,
    signal,
    mapError: hunterError,
  });
  return parseAccount(json);
}

/** Free call: company name -> likely domains. */
export async function hunterDomainFinder({ base, apiKey, company, fetchImpl = defaultFetch, signal }) {
  const name = String(company || "").trim();
  if (name.length < 3) return [];
  const params = new URLSearchParams({ company: name, limit: "5" });
  const json = await requestJson({
    provider: "hunter",
    url: `${base}/domain-finder?${params}`,
    headers: headersFor(apiKey),
    fetchImpl,
    signal,
    mapError: hunterError,
  });
  return (Array.isArray(json?.data) ? json.data : [])
    .map((d) => ({ name: d.company_name || d.domain || "", domain: cleanDomain(d.domain || "") }))
    .filter((d) => d.domain);
}
