import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanDomain,
  initials,
  isEmail,
  linkedinUrl,
  looksLikeDomain,
  normalizeCompanyName,
  safeUrl,
  sameCompany,
} from "../src/util.js";
import { roleScore, roleTag } from "../src/roles.js";

test("cleanDomain accepts websites in any common form", () => {
  assert.equal(cleanDomain("https://www.Stripe.com/jobs?x=1"), "stripe.com");
  assert.equal(cleanDomain("careers@northwind.example"), "northwind.example");
  assert.equal(cleanDomain("infosys.co.in:443"), "infosys.co.in");
  assert.equal(cleanDomain("stripe"), "");
  assert.equal(cleanDomain("not a domain.com"), "");
});

test("looksLikeDomain tells websites from company names", () => {
  assert.equal(looksLikeDomain("stripe.com"), true);
  assert.equal(looksLikeDomain("https://zoho.com/careers"), true);
  assert.equal(looksLikeDomain("Tata Consultancy Services"), false);
  assert.equal(looksLikeDomain("Booking.com"), true);
  assert.equal(looksLikeDomain("Razorpay"), false);
});

test("sameCompany ignores legal suffixes but not different companies", () => {
  assert.equal(normalizeCompanyName("Infosys Limited"), "infosys");
  assert.equal(sameCompany("Infosys", "Infosys Limited"), true);
  assert.equal(sameCompany("Northwind Labs, Inc.", "Northwind Labs"), true);
  assert.equal(sameCompany("Amazon", "Amazon Web Services (AWS)"), true);
  assert.equal(sameCompany("Meta", "Metabase"), true);
  assert.equal(sameCompany("Stripe", "Plaid"), false);
  assert.equal(sameCompany("X", "Dropbox"), false);
  assert.equal(sameCompany("", "Stripe"), false);
});

test("URL helpers only allow http(s) links", () => {
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(linkedinUrl("javascript:alert(1)"), "");
  assert.equal(linkedinUrl("www.linkedin.com/in/jane"), "https://www.linkedin.com/in/jane");
  assert.equal(linkedinUrl("jane-doe-123"), "https://www.linkedin.com/in/jane-doe-123");
  assert.equal(linkedinUrl("http://www.linkedin.com/in/jane"), "http://www.linkedin.com/in/jane");
});

test("isEmail rejects values that could break a mailto link", () => {
  assert.equal(isEmail("jane@acme.com"), true);
  assert.equal(isEmail("o'brien+jobs@acme.co.uk"), true);
  assert.equal(isEmail("jane@acme.com?bcc=x@y.com"), false);
  assert.equal(isEmail("jane@acme.com?bcc=boss"), false);
  assert.equal(isEmail("jane%3Fbcc@acme.com"), false);
  assert.equal(isEmail("jane doe@acme.com"), false);
  assert.equal(isEmail("<jane@acme.com>"), false);
  assert.equal(isEmail(""), false);
});

test("initials handle single names and punctuation", () => {
  assert.equal(initials("Priya Sh***a"), "PS");
  assert.equal(initials("Cher"), "C");
  assert.equal(initials(""), "?");
});

test("role scoring spots recruiters", () => {
  assert.equal(roleTag("Senior Technical Recruiter"), "Recruiter");
  assert.equal(roleTag("Talent Acquisition Partner"), "Recruiter");
  assert.equal(roleTag("Sourcer, Engineering"), "Recruiter");
  assert.equal(roleTag("Head of Talent"), "Talent");
  assert.equal(roleTag("HR Business Partner"), "Talent");
  assert.equal(roleTag("Human Resources Manager"), "HR");
  assert.equal(roleTag("Software Engineer"), "");
  assert.equal(roleScore(""), 0);
});

