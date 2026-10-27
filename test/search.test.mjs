import test from "node:test";
import assert from "node:assert/strict";
import { loadMore, mergePeople, samePerson, searchCompany, sortPeople } from "../src/search.js";
import { fakeFetch, fixture, hunterBody, hunterEmail, jsonResponse } from "./helpers.mjs";

const endpoints = { hunter: "https://hunter.test/v2", apollo: "https://apollo.test/api/v1" };
const bothOn = { hunter: { enabled: true, apiKey: "h" }, apollo: { enabled: true, apiKey: "a" } };
const hunterOnly = { hunter: { enabled: true, apiKey: "h" }, apollo: { enabled: false } };
const apolloOnly = { hunter: { enabled: false }, apollo: { enabled: true, apiKey: "a" } };

const isHunter = (u) => u.hostname === "hunter.test";
const isApollo = (u) => u.hostname === "apollo.test";

test("recruiter search falls back to the HR team when nobody has a recruiter title", async () => {
  const fetchImpl = fakeFetch([
    [(u) => isHunter(u) && u.searchParams.has("job_titles"), () => jsonResponse(hunterBody([]))],
    [
      (u) => isHunter(u) && u.searchParams.get("department") === "hr",
      () => jsonResponse(hunterBody([hunterEmail("maya@northwindlabs.io", { first_name: "Maya", position: "HR Manager" })])),
    ],
  ]);
  const result = await searchCompany({
    target: { name: "Northwind Labs", domain: "northwindlabs.io" },
    mode: "recruiters",
    providers: hunterOnly,
    endpoints,
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].email, "maya@northwindlabs.io");
  assert.match(result.notices[0], /HR team/);
  assert.deepEqual(result.paging.hunter.filters, { department: "hr" });
});

test("a country filter reaches both providers, survives the HR fallback, and labels the rows", async () => {
  const hunterBodies = [];
  const fetchImpl = fakeFetch([
    [
      (u, init) => isHunter(u) && init.method === "POST",
      (u, init) => {
        const body = JSON.parse(init.body);
        hunterBodies.push(body);
        if (body.job_titles) return jsonResponse(hunterBody([]));
        return jsonResponse(hunterBody([hunterEmail("maya@northwindlabs.io", { first_name: "Maya", position: "HR Manager" })]));
      },
    ],
    [isApollo, () => jsonResponse(fixture("apollo-people-search.json"))],
  ]);
  const result = await searchCompany({
    target: { name: "Northwind Labs", domain: "northwindlabs.io" },
    mode: "recruiters",
    country: "IN",
    providers: bothOn,
    endpoints,
    fetchImpl,
  });
  assert.equal(hunterBodies.length, 2);
  assert.ok(hunterBodies.every((b) => b.location.include[0].country === "IN"));
  assert.equal(hunterBodies[1].department, "hr");
  const apolloCall = fetchImpl.calls.find((c) => isApollo(c.url));
  assert.deepEqual(apolloCall.url.searchParams.getAll("person_locations[]"), ["india"]);
  assert.match(result.notices[0], /at Northwind Labs in India, so these are people on the HR team/);
  assert.equal(result.country, "IN");
  assert.ok(result.people.length >= 2);
  assert.ok(result.people.every((p) => p.location === "India"));
  assert.equal(result.paging.hunter.country, "IN");
  assert.equal(result.paging.apollo.country, "IN");
});

test("searching anywhere sends no location filter", async () => {
  const fetchImpl = fakeFetch([[isHunter, () => jsonResponse(hunterBody([hunterEmail("ava@northwindlabs.io")]))]]);
  const result = await searchCompany({
    target: { name: "Northwind Labs", domain: "northwindlabs.io" },
    mode: "recruiters",
    country: "",
    providers: hunterOnly,
    endpoints,
    fetchImpl,
  });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(url.searchParams.get("domain"), "northwindlabs.io");
  assert.equal(result.people[0].location, undefined);
});

test("recruiter search also falls back if Hunter rejects the title filter", async () => {
  const fetchImpl = fakeFetch([
    [
      (u) => isHunter(u) && u.searchParams.has("job_titles"),
      () => jsonResponse({ errors: [{ id: "invalid_job_titles", details: "nope" }] }, 400),
    ],
    [(u) => isHunter(u), () => jsonResponse(hunterBody([hunterEmail("ava@northwindlabs.io")]))],
  ]);
  const result = await searchCompany({
    target: { name: "", domain: "northwindlabs.io" },
    mode: "recruiters",
    providers: hunterOnly,
    endpoints,
    fetchImpl,
  });
  assert.equal(result.people.length, 1);
  assert.equal(result.errors.length, 0);
});

test("an invalid key is reported, not retried with other filters", async () => {
  const fetchImpl = fakeFetch([[isHunter, () => jsonResponse({ errors: [{ id: "authentication_failed" }] }, 401)]]);
  const result = await searchCompany({
    target: { name: "Acme", domain: "acme.com" },
    mode: "recruiters",
    providers: hunterOnly,
    endpoints,
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(
    result.errors.map((e) => [e.provider, e.code]),
    [["hunter", "auth"]]
  );
});

test("uses Hunter's resolved company when searching by name", async () => {
  const fetchImpl = fakeFetch([[isHunter, () => jsonResponse(hunterBody([hunterEmail("ava@northwindlabs.io")]))]]);
  const result = await searchCompany({
    target: { name: "northwind", domain: "" },
    mode: "all",
    providers: hunterOnly,
    endpoints,
    fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].url.searchParams.get("company"), "northwind");
  assert.equal(result.company.domain, "northwindlabs.io");
});

test("Apollo hides people whose current employer is a different company", async () => {
  const fetchImpl = fakeFetch([[isApollo, () => jsonResponse(fixture("apollo-people-search.json"))]]);
  const result = await searchCompany({
    target: { name: "Northwind Labs", domain: "northwindlabs.io" },
    mode: "recruiters",
    providers: apolloOnly,
    endpoints,
    fetchImpl,
  });
  assert.deepEqual(
    result.people.map((p) => p.firstName),
    ["Priya", "Jon"]
  );
  assert.equal(result.hiddenFormer, 1);
});

test("Apollo explains that it needs a website when only a name is known", async () => {
  const fetchImpl = fakeFetch([]);
  const result = await searchCompany({
    target: { name: "Mystery Co", domain: "" },
    mode: "recruiters",
    providers: apolloOnly,
    endpoints,
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(result.errors[0].code, "need_domain");
  assert.match(result.errors[0].message, /website/);
});

test("merges both providers and drops Apollo rows Hunter already has", async () => {
  const fetchImpl = fakeFetch([
    [
      isHunter,
      () =>
        jsonResponse(
          hunterBody([
            hunterEmail("priya.sharma@northwindlabs.io", { first_name: "Priya", last_name: "Sharma", position: "Senior Technical Recruiter" }),
          ])
        ),
    ],
    [isApollo, () => jsonResponse(fixture("apollo-people-search.json"))],
  ]);
  const result = await searchCompany({
    target: { name: "Northwind Labs", domain: "northwindlabs.io" },
    mode: "recruiters",
    providers: bothOn,
    endpoints,
    fetchImpl,
  });
  const names = result.people.map((p) => `${p.source}:${p.firstName}`);
  assert.deepEqual(names, ["hunter:Priya", "apollo:Jon"]);
  assert.equal(result.people[0].alsoInApollo, true);
});

test("one provider failing still shows the other provider's people", async () => {
  const fetchImpl = fakeFetch([
    [isHunter, () => jsonResponse({ errors: [] }, 429)],
    [isApollo, () => jsonResponse(fixture("apollo-people-search.json"))],
  ]);
  const result = await searchCompany({
    target: { name: "Northwind Labs", domain: "northwindlabs.io" },
    mode: "recruiters",
    providers: bothOn,
    endpoints,
    fetchImpl,
  });
  assert.equal(result.errors[0].code, "quota");
  assert.equal(result.people.length, 2);
});

test("matches masked Apollo surnames against full names", () => {
  const known = { firstName: "Priya", lastName: "Sharma" };
  assert.equal(samePerson(known, { firstName: "priya", lastNameMasked: "Sh***a" }), true);
  assert.equal(samePerson(known, { firstName: "Priya", lastNameMasked: "Si***h" }), false);
  assert.equal(samePerson(known, { firstName: "Pri", lastNameMasked: "Sh***a" }), false);
  assert.equal(samePerson({ firstName: "Al", lastName: "Li" }, { firstName: "Al", lastNameMasked: "Li***i" }), false);
});

test("sorts recruiters first, then verified emails, then confidence", () => {
  const people = [
    { name: "C", title: "Engineer", email: "c@x.com", emailStatus: "verified", confidence: 99, hasEmail: true },
    { name: "B", title: "HR Manager", email: "b@x.com", emailStatus: "verified", confidence: 80, hasEmail: true },
    { name: "A", title: "Technical Recruiter", email: "", emailStatus: "", hasEmail: true },
    { name: "D", title: "Talent Acquisition Lead", email: "d@x.com", emailStatus: "accept_all", confidence: 90, hasEmail: true },
    { name: "E", title: "Recruiter", email: "e@x.com", emailStatus: "verified", confidence: 70, hasEmail: true },
  ];
  assert.deepEqual(
    sortPeople(people).map((p) => p.name),
    ["E", "D", "A", "B", "C"]
  );
});

test("mergePeople skips duplicates by id and email", () => {
  const a = { id: "hunter:a@x.com", source: "hunter", email: "a@x.com" };
  const merged = mergePeople([a], [a, { id: "other", source: "hunter", email: "a@x.com" }, { id: "b", source: "hunter", email: "b@x.com" }]);
  assert.deepEqual(
    merged.map((p) => p.id),
    ["hunter:a@x.com", "b"]
  );
});

test("load more pages through Hunter and stops at the free-plan limit", async () => {
  let page = 0;
  const fetchImpl = fakeFetch([
    [
      isHunter,
      (u) => {
        page += 1;
        if (u.searchParams.get("offset") === "10") {
          return jsonResponse({ errors: [{ id: "pagination_error", details: "limit" }] }, 400);
        }
        const emails = Array.from({ length: 10 }, (_, i) => hunterEmail(`p${i}@acme.com`, { first_name: `P${i}` }));
        return jsonResponse(hunterBody(emails, { domain: "acme.com", organization: "Acme", results: 24 }));
      },
    ],
  ]);
  const result = await searchCompany({
    target: { name: "Acme", domain: "acme.com" },
    mode: "all",
    providers: hunterOnly,
    endpoints,
    fetchImpl,
  });
  assert.equal(result.paging.hunter.hasMore, true);
  await loadMore({ result, provider: "hunter", providers: hunterOnly, endpoints, fetchImpl });
  assert.equal(page, 2);
  assert.equal(result.paging.hunter.hasMore, false);
  assert.match(result.notices.at(-1), /free plan/);
  assert.equal(result.people.length, 10);
});

test("load more pages through Apollo for free", async () => {
  const many = (start) => ({
    total_entries: 60,
    people: Array.from({ length: 25 }, (_, i) => ({
      id: `id${start + i}`,
      first_name: `P${start + i}`,
      last_name_obfuscated: "Xx***y",
      title: "Recruiter",
      has_email: true,
      organization: { name: "Acme" },
    })),
  });
  const fetchImpl = fakeFetch([[isApollo, (u) => jsonResponse(many((Number(u.searchParams.get("page")) - 1) * 25))]]);
  const result = await searchCompany({
    target: { name: "Acme", domain: "acme.com" },
    mode: "recruiters",
    country: "IN",
    providers: apolloOnly,
    endpoints,
    fetchImpl,
  });
  assert.equal(result.people.length, 25);
  await loadMore({ result, provider: "apollo", providers: apolloOnly, endpoints, fetchImpl });
  assert.equal(result.people.length, 50);
  assert.equal(fetchImpl.calls[1].url.searchParams.get("page"), "2");
  assert.deepEqual(fetchImpl.calls[1].url.searchParams.getAll("person_locations[]"), ["india"]);
  assert.ok(result.people.every((p) => p.location === "India"));
  assert.equal(result.paging.apollo.hasMore, true);
});
