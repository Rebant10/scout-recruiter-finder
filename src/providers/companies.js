import { defaultFetch } from "./http.js";
import { cleanDomain, normalizeCompanyName } from "../util.js";

/** Company name -> website suggestions from Clearbit's free, keyless autocomplete. */
export async function suggestCompanies({ url, query, fetchImpl = defaultFetch, signal }) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  const res = await fetchImpl(`${url}?query=${encodeURIComponent(q)}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) return [];
  const list = await res.json().catch(() => []);
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const domain = cleanDomain(item?.domain || "");
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push({ name: String(item?.name || "").trim() || domain, domain });
    if (out.length === 6) break;
  }
  return out;
}

export function bestMatch(list, query) {
  const wanted = normalizeCompanyName(query);
  return list.find((c) => normalizeCompanyName(c.name) === wanted) || list[0] || null;
}

export function logoUrl(domain) {
  return domain ? `https://logos.hunter.io/${encodeURIComponent(domain)}` : "";
}
