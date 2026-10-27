import { MODES, roleScore } from "./roles.js";
import { HUNTER_PAGE_SIZE, hunterDomainSearch } from "./providers/hunter.js";
import { APOLLO_PAGE_SIZE, apolloPeopleSearch } from "./providers/apollo.js";
import { FATAL_CODES, ProviderError } from "./providers/http.js";
import { findLocation, locationLabel } from "./locations.js";
import { sameCompany } from "./util.js";

const STATUS_RANK = { verified: 3, accept_all: 2, unverified: 1 };

function displayName(target) {
  return target.name || target.domain || "this company";
}

function inPlace(country) {
  return country ? ` in ${locationLabel(country)}` : "";
}

/** Providers don't say where each person is, so rows found with a country filter get that country. */
function tagLocation(people, country) {
  const label = locationLabel(country);
  if (!label) return people;
  return people.map((p) => (p.location ? p : { ...p, location: label }));
}

function isFallbackWorthy(err) {
  return err instanceof ProviderError && !FATAL_CODES.has(err.code);
}

async function hunterFirstPage({ target, mode, country, apiKey, base, fetchImpl, signal }) {
  const common = {
    base,
    apiKey,
    domain: target.domain,
    company: target.domain ? "" : target.name,
    country,
    fetchImpl,
    signal,
  };
  let filters = MODES[mode].hunter;
  let res = null;
  let note = "";

  try {
    res = await hunterDomainSearch({ ...common, filters });
  } catch (err) {
    if (mode !== "recruiters" || !isFallbackWorthy(err)) throw err;
  }

  // Zero-result Domain Searches are free, so falling back to the HR team costs nothing extra.
  if (mode === "recruiters" && (!res || res.people.length === 0)) {
    const hr = await hunterDomainSearch({ ...common, filters: MODES.hr.hunter });
    if (hr.people.length) {
      const who = hr.company.name || displayName(target);
      note = `Hunter has nobody with a recruiter title at ${who}${inPlace(country)}, so these are people on the HR team.`;
      filters = MODES.hr.hunter;
      res = hr;
    } else {
      res = res || hr;
    }
  }

  const shown = res.offset + res.people.length;
  return {
    company: res.company,
    people: tagLocation(res.people, country),
    note,
    paging: { filters, country, offset: shown, total: res.total, hasMore: shown < res.total },
  };
}

function keepCurrentEmployees(people, target) {
  const name = target.name || target.domain.split(".")[0];
  const current = people.filter((p) => !p.company || sameCompany(p.company, name));
  // If nobody matches, the name we have is probably just spelled differently; keep everyone.
  if (!current.length) return { people, hidden: 0 };
  return { people: current, hidden: people.length - current.length };
}

async function apolloPage({ target, titles, country, page, apiKey, base, fetchImpl, signal }) {
  const place = findLocation(country).apollo;
  const res = await apolloPeopleSearch({
    base,
    apiKey,
    domain: target.domain,
    titles,
    locations: place ? [place] : [],
    page,
    fetchImpl,
    signal,
  });
  const { people, hidden } = keepCurrentEmployees(res.people, target);
  return {
    people: tagLocation(people, country),
    hidden,
    paging: {
      titles,
      country,
      page,
      total: res.total,
      hasMore: res.people.length === APOLLO_PAGE_SIZE && page * APOLLO_PAGE_SIZE < res.total,
    },
  };
}

async function apolloFirstPage({ target, mode, country, apiKey, base, fetchImpl, signal }) {
  if (!target.domain) {
    throw new ProviderError(
      "apollo",
      "need_domain",
      `Apollo needs ${target.name ? `${target.name}'s` : "the company's"} website to search. Pick the company from the suggestions, or type its website (like stripe.com).`
    );
  }
  const args = { target, country, apiKey, base, fetchImpl, signal, page: 1 };
  const first = await apolloPage({ ...args, titles: MODES[mode].apollo });
  if (mode !== "recruiters" || first.people.length) return { ...first, note: "" };

  // Apollo searches are free, so the HR fallback costs nothing.
  const hr = await apolloPage({ ...args, titles: MODES.hr.apollo });
  return {
    ...hr,
    note: hr.people.length
      ? `Apollo has nobody with a recruiter title at ${displayName(target)}${inPlace(country)}, so these are people on the HR team.`
      : "",
  };
}

/** Apollo only shows the first two and last letters of a surname before you pay ("Hu***n"). */
export function samePerson(known, masked) {
  if (!known.firstName || !masked.firstName) return false;
  if (known.firstName.toLowerCase() !== masked.firstName.toLowerCase()) return false;
  const last = (known.lastName || "").toLowerCase();
  const pattern = (masked.lastNameMasked || masked.lastName || "").toLowerCase();
  if (!last || !pattern) return false;
  const m = pattern.match(/^([^*]*)\*+([^*]*)$/);
  if (!m) return last === pattern;
  return last.length >= m[1].length + m[2].length && last.startsWith(m[1]) && last.endsWith(m[2]);
}

export function sortPeople(list) {
  return list.slice().sort(
    (a, b) =>
      roleScore(b.title) - roleScore(a.title) ||
      Number(Boolean(b.email)) - Number(Boolean(a.email)) ||
      (STATUS_RANK[b.emailStatus] || 0) - (STATUS_RANK[a.emailStatus] || 0) ||
      (b.confidence || 0) - (a.confidence || 0) ||
      Number(b.hasEmail) - Number(a.hasEmail) ||
      (a.name || "").localeCompare(b.name || "")
  );
}

/** Adds `incoming` to `existing`, skipping duplicates. Apollo rows that Hunter already has are dropped. */
export function mergePeople(existing, incoming) {
  const out = existing.slice();
  const ids = new Set(out.map((p) => p.id));
  const emails = new Set(out.filter((p) => p.email).map((p) => p.email));
  for (const person of incoming) {
    if (ids.has(person.id) || (person.email && emails.has(person.email))) continue;
    if (person.source === "apollo") {
      const twin = out.find((p) => p.source === "hunter" && samePerson(p, person));
      if (twin) {
        twin.alsoInApollo = true;
        continue;
      }
    }
    out.push(person);
    ids.add(person.id);
    if (person.email) emails.add(person.email);
  }
  return out;
}

/**
 * Runs the selected providers in parallel for one company.
 * `providers` looks like { hunter: { enabled, apiKey }, apollo: { enabled, apiKey } }.
 * `country` ("IN", or "" for anywhere) limits results to people based in that country.
 */
export async function searchCompany({ target, mode, country = "", providers, endpoints, fetchImpl, signal }) {
  const tasks = [];
  const shared = { target, mode, country, fetchImpl, signal };
  if (providers.hunter?.enabled) {
    tasks.push(["hunter", hunterFirstPage({ ...shared, apiKey: providers.hunter.apiKey, base: endpoints.hunter })]);
  }
  if (providers.apollo?.enabled) {
    tasks.push(["apollo", apolloFirstPage({ ...shared, apiKey: providers.apollo.apiKey, base: endpoints.apollo })]);
  }

  const result = {
    company: { name: target.name || "", domain: target.domain || "", pattern: "" },
    country,
    people: [],
    notices: [],
    errors: [],
    paging: {},
    hiddenFormer: 0,
  };

  const settled = await Promise.allSettled(tasks.map(([, task]) => task));
  let hunterPeople = [];
  let apolloPeople = [];

  settled.forEach((outcome, i) => {
    const provider = tasks[i][0];
    if (outcome.status === "rejected") {
      if (outcome.reason?.name === "AbortError") throw outcome.reason;
      result.errors.push({
        provider,
        code: outcome.reason?.code || "error",
        message: outcome.reason?.message || "Something went wrong.",
      });
      return;
    }
    const value = outcome.value;
    result.paging[provider] = value.paging;
    if (value.note) result.notices.push(value.note);
    if (provider === "hunter") {
      hunterPeople = value.people;
      if (value.company.name && !result.company.name) result.company.name = value.company.name;
      if (value.company.domain && !result.company.domain) result.company.domain = value.company.domain;
      result.company.pattern = value.company.pattern || "";
    } else {
      apolloPeople = value.people;
      result.hiddenFormer = value.hidden;
    }
  });

  result.people = sortPeople(mergePeople(hunterPeople, apolloPeople));
  return result;
}

/** Fetches the next page from one provider and merges it into an existing result. */
export async function loadMore({ result, provider, providers, endpoints, fetchImpl, signal }) {
  const paging = result.paging[provider];
  if (!paging?.hasMore) return result;
  const target = { name: result.company.name, domain: result.company.domain };

  if (provider === "hunter") {
    try {
      const res = await hunterDomainSearch({
        base: endpoints.hunter,
        apiKey: providers.hunter.apiKey,
        domain: target.domain,
        company: target.domain ? "" : target.name,
        filters: paging.filters,
        country: paging.country,
        offset: paging.offset,
        limit: HUNTER_PAGE_SIZE,
        fetchImpl,
        signal,
      });
      const shown = paging.offset + res.people.length;
      result.paging.hunter = { ...paging, offset: shown, total: res.total, hasMore: res.people.length > 0 && shown < res.total };
      result.people = sortPeople(mergePeople(result.people, tagLocation(res.people, paging.country)));
    } catch (err) {
      if (err?.code !== "pagination") throw err;
      result.paging.hunter = { ...paging, hasMore: false };
      if (!result.notices.includes(err.message)) result.notices.push(err.message);
    }
    return result;
  }

  const next = await apolloPage({
    target,
    titles: paging.titles,
    country: paging.country,
    page: paging.page + 1,
    apiKey: providers.apollo.apiKey,
    base: endpoints.apollo,
    fetchImpl,
    signal,
  });
  result.paging.apollo = next.paging;
  result.hiddenFormer += next.hidden;
  result.people = sortPeople(mergePeople(result.people, next.people));
  return result;
}
