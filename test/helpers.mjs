import { readFileSync } from "node:fs";

export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

export function jsonResponse(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch stand-in that routes by URL. `routes` is a list of [predicate, handler]
 * where handler(url, init) returns a Response. Every call is recorded.
 */
export function fakeFetch(routes) {
  const calls = [];
  const impl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      if (match(url, init)) return handler(url, init);
    }
    throw new Error(`Unexpected request: ${init.method || "GET"} ${url}`);
  };
  impl.calls = calls;
  return impl;
}

export function hunterBody(emails, { domain = "northwindlabs.io", organization = "Northwind Labs", results } = {}) {
  return {
    data: { domain, organization, pattern: "{first}.{last}", accept_all: false, emails },
    meta: { results: results ?? emails.length, limit: 10, offset: 0 },
  };
}

export function hunterEmail(value, extra = {}) {
  return {
    value,
    type: "personal",
    provenance: "found",
    confidence: 95,
    sources: [{ domain: "example.com", uri: "https://example.com/team", last_seen_on: "2026-09-01", still_on_page: true }],
    first_name: "Ava",
    last_name: "Stone",
    position: "Recruiter",
    department: "hr",
    linkedin: null,
    phone_number: null,
    verification: { date: "2026-09-02", status: "valid" },
    ...extra,
  };
}
