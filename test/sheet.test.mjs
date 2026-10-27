import test from "node:test";
import assert from "node:assert/strict";
import {
  clearSynced,
  displayRow,
  formatStamp,
  markSynced,
  mergeRecords,
  pendingRows,
  toCsv,
  toTsv,
} from "../src/sheet.js";

const person = (id, extra = {}) => ({
  id,
  source: "hunter",
  company: "Northwind Labs",
  domain: "northwind.example",
  name: `Person ${id}`,
  title: "Recruiter",
  email: `${id}@northwind.example`,
  emailStatus: "verified",
  ...extra,
});

test("new people go on top in search order, and repeats are not added twice", () => {
  const first = mergeRecords([], [person("a"), person("b")], "2026-10-27T10:00:00.000Z");
  assert.equal(first.added, 2);
  assert.deepEqual(
    first.list.map((r) => r.id),
    ["a", "b"]
  );

  const second = mergeRecords(first.list, [person("b"), person("c"), person("c")], "2026-10-27T11:00:00.000Z");
  assert.equal(second.added, 1);
  assert.deepEqual(
    second.list.map((r) => r.id),
    ["c", "a", "b"]
  );
  assert.equal(second.list.find((r) => r.id === "b").savedAt, "2026-10-27T10:00:00.000Z");
});

test("matching by email catches the same person from another source", () => {
  const { list } = mergeRecords([], [person("hunter:x", { email: "x@acme.com" })]);
  const merged = mergeRecords(list, [person("apollo:123", { email: "x@acme.com", source: "apollo" })]);
  assert.equal(merged.added, 0);
  assert.equal(merged.list.length, 1);
});

test("refreshing a row keeps known values and re-syncs only when the email changes", () => {
  let { list } = mergeRecords([], [person("apollo:1", { email: "", title: "Talent Partner", linkedin: "https://linkedin.com/in/p" })]);
  list = markSynced(list, ["apollo:1"], "2026-10-27T12:00:00.000Z");

  const same = mergeRecords(list, [person("apollo:1", { email: "", title: "", linkedin: "" })]).list[0];
  assert.equal(same.title, "Talent Partner");
  assert.equal(same.linkedin, "https://linkedin.com/in/p");
  assert.equal(same.syncedAt, "2026-10-27T12:00:00.000Z");

  const revealed = mergeRecords(list, [person("apollo:1", { email: "p@acme.com" })]).list[0];
  assert.equal(revealed.email, "p@acme.com");
  assert.equal(revealed.syncedAt, "");
});

test("tracks which rows still need to go to Google Sheets", () => {
  let { list } = mergeRecords([], [person("a"), person("b"), person("c", { email: "" })]);
  assert.deepEqual(
    pendingRows(list).map((r) => r.id),
    ["a", "b"]
  );
  list = markSynced(list, ["a"], "2026-10-27T12:00:00.000Z");
  assert.deepEqual(
    pendingRows(list).map((r) => r.id),
    ["b"]
  );
  assert.equal(pendingRows(clearSynced(list)).length, 2);
});

test("rows read naturally in spreadsheets", () => {
  const [row] = mergeRecords([], [person("a", { emailStatus: "accept_all", company: "" })], "2026-10-27T14:02:00.000Z").list;
  const values = displayRow(row);
  assert.equal(values.company, "northwind.example");
  assert.equal(values.emailStatus, "Catch-all");
  assert.equal(values.source, "Hunter");
  assert.match(values.savedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatStamp("not a date"), "not a date");
  assert.equal(formatStamp(""), "");
});

test("CSV puts company first and escapes quotes, commas, and formulas", () => {
  const { list } = mergeRecords([], [
    person("a", { company: "=HYPERLINK(1)", name: 'Ava "AJ" Stone', title: "Recruiter, Tech", email: "ava@acme.com", location: "India" }),
  ]);
  const [header, row] = toCsv(list).split("\r\n");
  assert.equal(header, "Company,Name,Title,Email,Email status,Location,LinkedIn,Domain,Source,Added");
  assert.ok(row.startsWith(`'=HYPERLINK(1),"Ava ""AJ"" Stone","Recruiter, Tech",ava@acme.com,Verified,India,`), row);
});

test("copied table pastes one value per cell", () => {
  const { list } = mergeRecords([], [person("a", { title: "Recruiter\tAPAC\nIndia", location: "Bengaluru, India" })]);
  const [header, row] = toTsv(list).split("\n");
  assert.equal(header.split("\t").length, 10);
  const cells = row.split("\t");
  assert.equal(cells.length, 10);
  assert.equal(cells[0], "Northwind Labs");
  assert.equal(cells[2], "Recruiter APAC India");
  assert.equal(cells[3], "a@northwind.example");
  assert.equal(cells[5], "Bengaluru, India");
});

test("a location learned later fills in an existing row", () => {
  let { list } = mergeRecords([], [person("a")]);
  assert.equal(list[0].location, "");
  list = mergeRecords(list, [person("a", { location: "India" })]).list;
  assert.equal(list[0].location, "India");
});
