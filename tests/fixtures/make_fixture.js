// Rebuilds tests/fixtures/catalog.jsonl: 40 real records from the cleaned catalog, chosen to cover
// the cases the tests check (hamza / ya variants, a copyist note, Persian, several dates...).
//   node tests/fixtures/make_fixture.js
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const SRC = path.join(__dirname, "..", "..", "data", "dromh_marc21_rda_catalog_v2.jsonl");
const OUT = path.join(__dirname, "catalog.jsonl");

const wants = [
  ["first records", (r, i) => i < 10],
  ["title with أصول", r => /أصول/.test(r.source_fields["العنوان"] || "")],
  ["title with اصول (no hamza)", r => /(^|\s)اصول/.test(r.source_fields["العنوان"] || "")],
  ["author spelled الطوسي", r => /الطوسي/.test(r.source_fields["المؤلف"] || "")],
  ["author spelled الطوسى", r => /الطوسى/.test(r.source_fields["المؤلف"] || "")],
  ["copy written by the author", r => /^بخط المؤلف$/.test((r.source_fields["الناسخ"] || "").trim())],
  ["Persian", r => (r.source_fields["اللغة"] || "").trim() === "فارسي"],
  ["Persian + نستعليق", r => (r.source_fields["اللغة"] || "").trim() === "فارسي" && /نستعليق/.test(r.source_fields["نوع الخط"] || "")],
  ["day + month date", r => /رجب/.test(r.source_fields["تاريخ النسخ"] || "")],
  ["century date", r => /^ق\s?\d+\s?هـ$/.test((r.source_fields["تاريخ النسخ"] || "").trim())],
  ["unknown author", r => (r.source_fields["المؤلف"] || "").trim() === "مجهول"],
  ["with harakat in title", r => /[ً-ْ]/.test(r.source_fields["العنوان"] || "")]
];

(async () => {
  const picked = new Map();
  const counts = new Map(wants.map(([n]) => [n, 0]));
  const rl = readline.createInterface({ input: fs.createReadStream(SRC, "utf8"), crlfDelay: Infinity });
  let i = 0;
  for await (const line of rl) {
    const r = JSON.parse(line);
    for (const [name, test] of wants) {
      const max = name === "first records" ? 10 : 3;
      if (counts.get(name) < max && test(r, i) && !picked.has(r.id)) {
        picked.set(r.id, line);
        counts.set(name, counts.get(name) + 1);
      }
    }
    i++;
    if (picked.size >= 40) break;
  }
  fs.writeFileSync(OUT, [...picked.values()].join("\n") + "\n", "utf8");
  console.log(`wrote ${picked.size} records to ${path.relative(process.cwd(), OUT)}`);
  for (const [n, c] of counts) console.log(`  ${n}: ${c}`);
})();
