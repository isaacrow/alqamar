"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { SearchIndex, hijriCenturyOf } = require("../server/search_index");
const { FIXTURE } = require("./helpers");

const lines = fs.readFileSync(FIXTURE, "utf8").trim().split("\n").map(l => JSON.parse(l));
const index = new SearchIndex();
lines.forEach((r, i) => index.set(i, r, (r.marc21_rda.find(m => m.tag === "008") || {}).value || "", false));
const search = (params, flt = "all") => index.search({ limit: 200, ...params }, {}, flt);

test("hamza, ya and tashkeel variants find the same records", () => {
  const pairs = [["أصول", "اصول"], ["الطوسى", "الطوسي"], ["الإمام", "الامام"], ["رسالة", "رساله"]];
  for (const [a, b] of pairs) {
    const x = search({ q: a }), y = search({ q: b });
    assert.equal(x.total, y.total, `${a} vs ${b}`);
  }
  assert.ok(search({ q: "أصول" }).total >= 3, "the fixture has titles with أصول and اصول");
  assert.ok(search({ q: "الطوسى" }).total >= 1);
});

test("all words must match, in any order", () => {
  const a = search({ q: "شرح الطوسي" }), b = search({ q: "الطوسي شرح" });
  assert.equal(a.total, b.total);
  assert.ok(search({ q: "كلمةغيرموجودةاطلاقا" }).total === 0);
});

test("field search narrows to one field", () => {
  const all = search({ q: "الطوسي" }), author = search({ q: "الطوسي", field: "author" });
  assert.ok(author.total >= 1 && author.total <= all.total);
  for (const it of author.items) assert.match(it.author.replace(/ى/g, "ي"), /الطوسي/);
  const num = search({ q: lines[0].source_fields["رقم النسخة"], field: "number" });
  assert.ok(num.items.some(i => i.idx === 0));
});

test("filters and their counts agree", () => {
  const f = search({ facets: true });
  const per = f.facets.lang.find(x => x.value === "per");
  assert.ok(per && per.count >= 3);
  assert.equal(search({ lang: "per" }).total, per.count);
  const nast = f.facets.script.find(x => x.value === "نستعليق");
  assert.ok(nast);
  assert.ok(!f.facets.script.some(x => x.value === "تعليق" && x.count === nast.count), "نستعليق is not also counted as تعليق");
});

test("century and Hijri year range use the same calendar", () => {
  assert.equal(hijriCenturyOf(1688, 1689), 11, "1100 AH is the 11th century");
  assert.equal(hijriCenturyOf(1689, 1690), 12, "1101 AH is the 12th century");
  assert.equal(hijriCenturyOf(1592, 1689), 11, "ق 11 range");
  const f = search({ facets: true });
  for (const c of f.facets.century) {
    const byCentury = search({ century: String(c.value) }).total;
    const byRange = search({ from: String((c.value - 1) * 100 + 1), to: String(c.value * 100) }).total;
    assert.equal(byCentury, byRange, `century ${c.value}`);
  }
});

test("sorting by date puts undated records last", () => {
  const r = search({ sort: "date_asc" });
  const years = r.items.map(i => i.year);
  const firstNull = years.indexOf(null);
  const dated = firstNull === -1 ? years : years.slice(0, firstNull);
  assert.deepEqual(dated, [...dated].sort((a, b) => a - b));
  if (firstNull !== -1) assert.ok(years.slice(firstNull).every(y => y === null));
});
