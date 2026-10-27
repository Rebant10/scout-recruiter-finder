import test from "node:test";
import assert from "node:assert/strict";
import {
  hunterAccount,
  hunterDomainSearch,
  hunterError,
  parseAccount,
  parseDomainSearch,
} from "../src/providers/hunter.js";
import {
  apolloCheckAccess,
  apolloError,
  apolloPeopleSearch,
  apolloRevealPerson,
  parsePeopleSearch,
  parseReveal,
} from "../src/providers/apollo.js";
import { bestMatch, suggestCompanies } from "../src/providers/companies.js";
import { ProviderError } from "../src/providers/http.js";
import { fakeFetch, fixture, jsonResponse } from "./helpers.mjs";

const HUNTER = "https://api.hunter.io/v2";
const APOLLO = "https://api.apollo.io/api/v1";

test("parses Hunter's real domain-search response shape", () => {
  const result = parseDomainSearch(fixture("hunter-domain-search.json"));
  assert.equal(result.company.name, "Pied Piper");
  assert.equal(result.company.domain, "piedpiper.com");
  assert.equal(result.people.length, 1);
  const [person] = result.people;
  assert.equal(person.email, "richard@piedpiper.com");
  assert.equal(person.name, "Richard Hendricks");
  assert.equal(person.title, "CEO");
  assert.equal(person.emailStatus, "verified");
  assert.equal(person.confidence, 99);
  assert.equal(person.provenance, "found");
  assert.equal(person.source, "hunter");
  assert.match(person.linkedin, /^https:\/\/www\.linkedin\.com\/in\//);
});

test("maps Hunter verification states and skips malformed emails", () => {
  const result = parseDomainSearch({
    data: {
      domain: "acme.com",
      organization: "Acme",
      emails: [
        { value: "a@acme.com", verification: { status: "accept_all" }, sources: [] },
        { value: "b@acme.com", verification: null },
        { value: "not-an-email" },
        null,
      ],
    },
    meta: { results: 3, offset: 0 },
  });
  assert.deepEqual(
    result.people.map((p) => [p.email, p.emailStatus]),
    [
      ["a@acme.com", "accept_all"],
      ["b@acme.com", "unverified"],
    ]
  );
  assert.equal(result.total, 3);
});

test("drops Hunter's LinkedIn profile lookups from the pages an email was seen on", () => {
  const result = parseDomainSearch({
    data: {
      domain: "acme.com",
      organization: "Acme",
      pattern: "{first}.{last}",
      emails: [
        {
          value: "ava.stone@acme.com",
          provenance: "found",
          verification: { status: "valid" },
          sources: [
            { domain: "jobs.example", uri: "https://jobs.example/acme-hiring", last_seen_on: "2026-10-20", still_on_page: true },
            { domain: "linkedin.com", uri: "https://www.google.com/search?q=site:linkedin.com%20ava%20stone%20acme" },
          ],
        },
        {
          value: "li.wei@acme.com",
          provenance: "inferred",
          source_type: "generated",
          verification: { date: null, status: null },
          sources: [{ domain: "linkedin.com", uri: "https://www.google.com/search?q=site:linkedin.com%20li%20wei%20acme" }],
        },
      ],
    },
    meta: { results: 2 },
  });
  const [found, inferred] = result.people;
  assert.deepEqual(
    found.sources.map((s) => s.url),
    ["https://jobs.example/acme-hiring"]
  );
  assert.equal(inferred.sources.length, 0);
  assert.equal(inferred.provenance, "inferred");
  assert.equal(inferred.emailStatus, "unverified");
  assert.equal(inferred.emailPattern, "{first}.{last}");
});

test("sends Hunter filters and the key as a header, never in the URL", async () => {
  const fetchImpl = fakeFetch([[() => true, () => jsonResponse(fixture("hunter-domain-search.json"))]]);
  await hunterDomainSearch({
    base: HUNTER,
    apiKey: "secret-key",
    company: "Stripe",
    filters: { job_titles: "recruiter,sourcer", department: "" },
    fetchImpl,
  });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.pathname, "/v2/domain-search");
  assert.equal(url.searchParams.get("company"), "Stripe");
  assert.equal(url.searchParams.get("job_titles"), "recruiter,sourcer");
  assert.equal(url.searchParams.has("department"), false);
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.searchParams.has("api_key"), false);
  assert.equal(init.headers["X-API-KEY"], "secret-key");
});

test("asks Hunter for people in one country with a JSON POST", async () => {
  const fetchImpl = fakeFetch([[() => true, () => jsonResponse(fixture("hunter-domain-search.json"))]]);
  await hunterDomainSearch({
    base: HUNTER,
    apiKey: "secret-key",
    domain: "stripe.com",
    filters: { job_titles: "recruiter,sourcer" },
    country: "IN",
    offset: 10,
    fetchImpl,
  });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(init.method, "POST");
  assert.equal(url.href, `${HUNTER}/domain-search`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["X-API-KEY"], "secret-key");
  assert.deepEqual(JSON.parse(init.body), {
    domain: "stripe.com",
    limit: 10,
    offset: 10,
    job_titles: "recruiter,sourcer",
    location: { include: [{ country: "IN" }] },
  });
});

test("prefers domain over company name for Hunter", async () => {
  const fetchImpl = fakeFetch([[() => true, () => jsonResponse(fixture("hunter-domain-search.json"))]]);
  await hunterDomainSearch({ base: HUNTER, apiKey: "k", domain: "stripe.com", company: "Stripe", fetchImpl });
  assert.equal(fetchImpl.calls[0].url.searchParams.get("domain"), "stripe.com");
  assert.equal(fetchImpl.calls[0].url.searchParams.has("company"), false);
});

test("turns Hunter HTTP errors into readable messages", async () => {
  const cases = [
    [401, {}, "auth"],
    [429, {}, "quota"],
    [403, {}, "rate_limited"],
    [400, { errors: [{ id: "pagination_error", details: "x" }] }, "pagination"],
    [400, { errors: [{ id: "invalid_department", details: "The supplied department is invalid." }] }, "invalid_department"],
    [503, {}, "server"],
  ];
  for (const [status, body, code] of cases) {
    const err = hunterError(status, body);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, code, `HTTP ${status}`);
    assert.ok(err.message.length > 10);
  }

  const fetchImpl = fakeFetch([[() => true, () => jsonResponse({ errors: [{ id: "authentication_failed" }] }, 401)]]);
  await assert.rejects(hunterDomainSearch({ base: HUNTER, apiKey: "bad", domain: "x.com", fetchImpl }), {
    code: "auth",
  });
});

test("reports network failures without leaking internals", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(hunterDomainSearch({ base: HUNTER, apiKey: "k", domain: "x.com", fetchImpl }), (err) => {
    assert.equal(err.code, "network");
    assert.match(err.message, /Couldn't reach Hunter/);
    return true;
  });
});

test("reads Hunter credits from either the unified pool or searches", async () => {
  const unified = parseAccount({
    data: { plan_name: "Free", reset_date: "2026-11-02", requests: { credits: { used: 3, available: 50, remaining: 47 } } },
  });
  assert.deepEqual([unified.plan, unified.remaining, unified.unit], ["Free", 47, "credits"]);

  const split = parseAccount({ data: { plan_name: "Starter", requests: { searches: { used: 10, available: 500 } } } });
  assert.deepEqual([split.remaining, split.unit], [490, "searches"]);

  const fetchImpl = fakeFetch([[(u) => u.pathname.endsWith("/account"), () => jsonResponse({ data: { plan_name: "Free" } })]]);
  const acct = await hunterAccount({ base: HUNTER, apiKey: "k", fetchImpl });
  assert.equal(acct.plan, "Free");
  assert.equal(acct.remaining, null);
});

test("parses Apollo people search with masked surnames", () => {
  const { people, total } = parsePeopleSearch(fixture("apollo-people-search.json"), "northwindlabs.io");
  assert.equal(total, 3);
  assert.equal(people[0].name, "Priya Sh***a");
  assert.equal(people[0].apolloId, "67bdafd0c3a4c50001bbd7c2");
  assert.equal(people[0].hasEmail, true);
  assert.equal(people[0].revealed, false);
  assert.equal(people[0].email, "");
  assert.equal(people[1].hasEmail, false);
  assert.equal(people[2].company, "Contoso");
});

test("sends Apollo search filters as query params with the key header", async () => {
  const fetchImpl = fakeFetch([[() => true, () => jsonResponse(fixture("apollo-people-search.json"))]]);
  await apolloPeopleSearch({
    base: APOLLO,
    apiKey: "apollo-key",
    domain: "northwindlabs.io",
    titles: ["recruiter", "talent acquisition"],
    fetchImpl,
  });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(init.method, "POST");
  assert.equal(url.pathname, "/api/v1/mixed_people/api_search");
  assert.deepEqual(url.searchParams.getAll("q_organization_domains_list[]"), ["northwindlabs.io"]);
  assert.deepEqual(url.searchParams.getAll("person_titles[]"), ["recruiter", "talent acquisition"]);
  assert.equal(url.searchParams.get("include_similar_titles"), "true");
  assert.equal(url.searchParams.has("person_locations[]"), false);
  assert.equal(init.headers["x-api-key"], "apollo-key");

  await apolloPeopleSearch({ base: APOLLO, apiKey: "k", domain: "stripe.com", locations: ["india"], fetchImpl });
  assert.deepEqual(fetchImpl.calls[1].url.searchParams.getAll("person_locations[]"), ["india"]);
});

test("parses an Apollo reveal and ignores locked placeholder emails", () => {
  const patch = parseReveal(fixture("apollo-people-match.json"));
  assert.equal(patch.name, "Priya Sharma");
  assert.equal(patch.email, "priya.sharma@northwindlabs.io");
  assert.equal(patch.emailStatus, "verified");
  assert.equal(patch.revealed, true);

  assert.equal(patch.location, undefined);
  const placed = parseReveal({ person: { first_name: "A", email: "a@acme.com", city: "Bengaluru", state: "Karnataka", country: "India" } });
  assert.equal(placed.location, "Bengaluru, India");

  const locked = parseReveal({ person: { first_name: "A", last_name: "B", email: "email_not_unlocked@domain.com" } });
  assert.equal(locked.email, "");
  assert.equal(locked.emailStatus, "");

  assert.throws(() => parseReveal({ person: null }), { code: "not_found" });
});

test("reveals one Apollo person by id", async () => {
  const fetchImpl = fakeFetch([[() => true, () => jsonResponse(fixture("apollo-people-match.json"))]]);
  const patch = await apolloRevealPerson({ base: APOLLO, apiKey: "k", apolloId: "abc123", fetchImpl });
  assert.equal(fetchImpl.calls[0].url.pathname, "/api/v1/people/match");
  assert.equal(fetchImpl.calls[0].url.searchParams.get("id"), "abc123");
  assert.equal(patch.email, "priya.sharma@northwindlabs.io");
});

test("explains Apollo plan restrictions", () => {
  const forbidden = apolloError(403, { error: "This API key is not authorized", error_code: "API_INACCESSIBLE" });
  assert.equal(forbidden.code, "forbidden");
  assert.match(forbidden.message, /work email/);
  assert.equal(apolloError(401, null, "Invalid API key").code, "auth");
  assert.equal(apolloError(429, {}).code, "rate_limited");
});

test("Apollo access check fails on a bad key without spending credits", async () => {
  const fetchImpl = fakeFetch([
    [(u) => u.pathname.endsWith("/auth/health"), () => jsonResponse({ healthy: true, is_logged_in: false })],
  ]);
  await assert.rejects(apolloCheckAccess({ base: APOLLO, apiKey: "nope", fetchImpl }), { code: "auth" });
  assert.equal(fetchImpl.calls.length, 1);
});

test("company suggestions are cleaned, de-duplicated, and capped", async () => {
  const fetchImpl = fakeFetch([
    [
      () => true,
      () =>
        jsonResponse([
          { name: "Stripe", domain: "stripe.com" },
          { name: "Stripe dup", domain: "STRIPE.com" },
          { name: "Bad", domain: "not a domain" },
          { name: "Stripe Press", domain: "press.stripe.com" },
        ]),
    ],
  ]);
  const list = await suggestCompanies({ url: "https://autocomplete.example/suggest", query: "stri", fetchImpl });
  assert.deepEqual(list, [
    { name: "Stripe", domain: "stripe.com" },
    { name: "Stripe Press", domain: "press.stripe.com" },
  ]);
  assert.equal(fetchImpl.calls[0].url.searchParams.get("query"), "stri");

  assert.equal(bestMatch(list, "stripe press").domain, "press.stripe.com");
  assert.equal(bestMatch(list, "strip").domain, "stripe.com");
  assert.equal(bestMatch([], "x"), null);
});
