"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mb = require("../server/marc_builder");
const { FIXTURE } = require("./helpers");

const fixture = fs.readFileSync(FIXTURE, "utf8").trim().split("\n").map(l => JSON.parse(l));

test("Hijri dates convert to the right Gregorian years", () => {
  assert.deepEqual(mb.hijriToGregorianYears(1260), [1844, 1845]);
  assert.deepEqual(mb.hijriToGregorianYears(1260, 7, 2), [1844, 1844]);
  assert.deepEqual(mb.hijriToGregorianYears(1445), [2023, 2024]);
  const d = mb.parseCopyDate("الجمعة2شهر رجب سنة 1260هـ");
  assert.equal(d.type, "s");
  assert.equal(d.date1, "1844");
  const y = mb.parseCopyDate("1260هـ");
  assert.equal(y.type, "q");
  assert.match(y.display, /1844 أو 1845/);
  const c = mb.parseCopyDate("ق11هـ");
  assert.equal(c.type, "q");
  assert.equal(c.date1, "1592");
  assert.equal(mb.parseCopyDate("بلا").type, "n");
  assert.equal(mb.parseCopyDate("8027").type, "n", "a future year is a typo, not a date");
});

test("languages are normalized to MARC codes", () => {
  assert.deepEqual(mb.parseLanguages("عربيّ").codes, ["ara"]);
  assert.deepEqual(mb.parseLanguages("عربي ‏").codes, ["ara"]);
  assert.deepEqual(mb.parseLanguages("فارسي وعربي").codes, ["per", "ara"]);
  assert.deepEqual(mb.parseLanguages("؟").codes, ["und"]);
});

test("Arabic names are kept as written, with dates and roles split off", () => {
  const p = mb.parsePersonName("ابن سينا، الحسين بن عبد الله (ت 428 هـ)");
  assert.equal(p.name, "ابن سينا، الحسين بن عبد الله");
  assert.equal(p.dates, "ت 428هـ");
  assert.equal(mb.parsePersonName("الجامع/ مجهول"), null);
  assert.equal(mb.parsePersonName("منسوبة إلى: الشهيد الاول، محمد بن مكي (ت786هـ)").relator, "مؤلف منسوب إليه.");
  assert.deepEqual(mb.parseScribe("بخط المؤلف"), { note: "النسخة بخط المؤلف." });
});

test("every fixture record builds valid MARC that survives an ISO 2709 round trip", () => {
  for (const rec of fixture) {
    const marc = mb.buildMarcRecord(rec, { timestamp: "20260101000000.0" });
    assert.deepEqual(mb.validateMarc(marc), [], `record ${rec.id}`);
    const iso = mb.toIso2709(marc);
    const back = mb.parseIso2709(iso);
    assert.equal(back.leader[9], "a", "leader 09 = Unicode");
    assert.equal(back.leader.slice(6, 8), "tm", "manuscript monograph");
    assert.ok(!back.fields.some(f => f.tag === "000"), "leader is not repeated as a field");
    assert.equal(back.fields.find(f => f.tag === "001").value, `b${rec.id}`);
    assert.ok(back.fields.filter(f => +f.tag >= 10).every(f => /^[0-9 ]{2}$/.test(f.indicators)), "binary indicators use spaces");
    for (const tag of ["066", "535", "949", "098", "340", "050"]) {
      assert.ok(!marc.some(m => m.tag === tag), `no ${tag} in record ${rec.id}`);
    }
  }
});

test("the old exporter's record shape (001 with a subfield) still exports cleanly", () => {
  const old = [
    { tag: "000", value: "00000ctm a2200000 i 4500" },
    { tag: "001", indicators: "\\\\", subfields: [{ code: "a", value: "b1" }] },
    { tag: "245", indicators: "00", subfields: [{ code: "a", value: "عنوان." }] }
  ];
  const back = mb.parseIso2709(mb.toIso2709(old));
  assert.equal(back.fields.find(f => f.tag === "001").value, "b1");
});

test("the validator catches structural mistakes", () => {
  const problems = mb.validateMarc([
    { tag: "000", value: "short" },
    { tag: "001", indicators: "\\\\", subfields: [{ code: "a", value: "x" }] },
    { tag: "245", indicators: "X", subfields: [{ code: "a", value: "t" }] }
  ]);
  assert.equal(problems.length, 3);
});
