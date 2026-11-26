"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { SearchIndex, LANGUAGE_NAMES } = require("../server/search_index");
const { Insights, insightFacts } = require("../server/insights");
const gaz = require("../server/gazetteer");
const { FIXTURE } = require("./helpers");

const lines = fs.readFileSync(FIXTURE, "utf8").trim().split("\n").map(l => JSON.parse(l));
const index = new SearchIndex();
lines.forEach((r, i) => index.set(i, r, (r.marc21_rda.find(m => m.tag === "008") || {}).value || "", false));
const ins = new Insights(index, { languageNames: LANGUAGE_NAMES });
const facts = fields => insightFacts(k => fields[k] || "");

test("gazetteer: libraries and copy places land on the right city", () => {
  const lib = name => (gaz.libraryPlace(name).place || {}).key;
  assert.equal(lib("مكتبة العتبة العباسية المقدسة (ج4) - كربلاء المقدسة"), "karbala", "hamza on the line: كربلاء = كربلا");
  assert.equal(lib("مكتبة الامامين الجوادين(ع)  العامة الكاظمية - بغداد"), "kadhimiya", "the first city named wins");
  assert.equal(lib("مكتبة كاظميني - يزد"), "yazd", "a city inside a longer word does not match");
  assert.equal(lib("مكتبة السيد البروجردي - قم"), "qom");
  assert.equal(lib("مكتبة تشستربيتي بدبلن – ايرلندا"), "dublin", "the preposition ب before a city");
  assert.deepEqual([lib("مكتبات اليمن"), gaz.libraryPlace("مكتبات اليمن").approx], ["sanaa", true], "country only: approximate");
  const cp = s => (gaz.findPlace(s) || {}).key;
  assert.equal(cp("دار السلطنة أصفهان"), "isfahan");
  assert.equal(cp("دار الخلافة طهران"), "tehran");
  assert.equal(cp("دار الخلافة شاه جهان آباد - الهند"), "delhi", "دار الخلافة alone is Tehran, but not here");
  assert.equal(cp("البلدة الطيبة سر من رأى"), "samarra");
  assert.equal(cp("المشهد الغروي"), "najaf");
  assert.equal(cp("قرية مباركة لنگر"), undefined);
  for (const p of gaz.PLACES) assert.ok(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180, p.key);
});

test("facts: dates, copyist, features and condition are read from the source fields", () => {
  const f = facts({
    "المؤلف": "نفيس الكرماني، نفيس بن عوض (ت842هـ)",
    "الناسخ": "بخط المؤلف",
    "تاريخ النسخ": "الجمعة2شهر رجب سنة 1260هـ",
    "عدد الاوراق": "401",
    "مكان النسخ": "دار العلم شيراز",
    "وصف النسخة": "رؤوس المطالب كتبت بالمداد الأحمر، عليها تملك ووقف، ناقصة الآخر",
    "العنوان": "شرح موجز القانون = شرح النفيسي"
  });
  assert.equal(f.ad, 842);
  assert.equal(f.st, "autograph");
  assert.equal(f.mo, 7, "رجب");
  assert.equal(f.wd, 6, "الجمعة");
  assert.equal(f.lv, 401);
  assert.equal(f.cp, "shiraz");
  assert.equal(f.cond, "end");
  assert.equal(f.wn, "شرح موجز القانون");
  const names = ["rubric", "owner", "waqf"];
  const { FEATURES } = require("../server/insights");
  for (const n of names) assert.ok(f.ft & (1 << FEATURES.findIndex(x => x[0] === n)), n);
  assert.equal(facts({ "تاريخ النسخ": "جمادى الأولى 1100" }).mo, 5);
  assert.equal(facts({ "الناسخ": "مجهول" }).st, "unknown");
  assert.equal(facts({ "الناسخ": "بلا" }).st, "none");
  assert.equal(facts({ "المؤلف": "كلام الله (عز وجل)" }).ak, facts({ "المؤلف": "كلام الله" }).ak, "honorifics in brackets are dropped");
});

test("summary: every chart adds up and filters narrow", () => {
  const s = ins.summary([]);
  assert.equal(s.total, lines.length);
  assert.equal(s.charts.copyistType.reduce((n, x) => n + x.count, 0), s.total, "one copyist type per manuscript");
  assert.equal(s.charts.condition.reduce((n, x) => n + x.count, 0), s.total, "one condition per manuscript");
  assert.equal(s.charts.century.reduce((n, x) => n + x.count, 0), s.dated);
  assert.equal(s.charts.completeness.reduce((n, x) => n + x.count, 0), s.total);
  const lang = s.charts.lang[0];
  assert.equal(ins.summary([["lang", lang.value]]).total, lang.count, "a filter gives exactly the chart's count");
});

test("records: the manuscripts behind a click match its count", () => {
  const s = ins.summary([]);
  for (const dim of ["subject", "century", "library", "copyistType", "leaves", "holdCity"]) {
    const x = s.charts[dim].find(v => v.count > 0);
    if (!x) continue;
    const r = ins.records([[dim, x.value]], 0, 200);
    assert.equal(r.total, x.count, dim);
    assert.equal(r.filters[0].label, x.label, dim + " label");
  }
  // heatmap cells: two filters at once
  const hm = s.heatmaps[0];
  if (hm.cells.length) {
    const [row, col, n] = hm.cells[0];
    assert.equal(ins.records([[hm.rowDim, row], [hm.colDim, col]]).total, n);
  }
  assert.deepEqual(ins.parseFilters(["nope:1", "lang:ara", "bad"]), [["lang", "ara"]], "unknown dimensions are dropped");
});

test("quality checks: issues are detected and CSV cells are safe", () => {
  const f = facts({ "نوع الخط": "", "وصف النسخة": "نوع الخط:نسخ، مجدولة", "عدد الاوراق": "للمجموعة 215", "مكان النسخ": "قرية مباركة لنگر" });
  assert.equal(f.q.scriptInDesc, true, "script written in the description");
  assert.equal(f.q.leavesOdd, true, "non-standard leaf count");
  assert.equal(f.q.placeUnmatched, true, "copy place not in the gazetteer");
  assert.equal(facts({ "عدد الاوراق": "؟" }).q.leavesOdd, false, "a question mark is empty, not odd");
  assert.equal(facts({ "عدد الاوراق": "12-40" }).q.leavesOdd, false, "a range is fine");
  const s = ins.summary([]);
  for (const x of s.charts.issue) assert.equal(ins.records([["issue", x.value]]).total, x.count, x.value);
  // a cell that starts with "=" is not run as a formula
  const e = index.entries[0];
  const saved = e.title;
  e.title = "=HYPERLINK(\"http://x\")";
  index.version++;
  const csv = ins.exportCsv([["library", String(e.lib)]]);
  e.title = saved;
  index.version++;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), "formula neutralised and quoted");
  assert.equal(csv.charCodeAt(0), 0xFEFF);
});

test("bulk fix rule: moves only clear script names, keeps hand-edited MARC", () => {
  const { applyFix } = require("../server/fixes");
  const mb = require("../server/marc_builder");
  const rec = (desc, script = "") => {
    const sf = { "العنوان": "كتاب", "نوع الخط": script, "وصف النسخة": desc, "اللغة": "عربي" };
    return { id: "1", source_fields: sf, marc21_rda: mb.buildMarcRecord({ id: "1", source_fields: sf }) };
  };
  const after = (desc) => { const r = applyFix("scriptInDesc", rec(desc)); return r.skip ? r.skip : [r.record.source_fields["نوع الخط"], r.record.source_fields["وصف النسخة"]]; };
  assert.deepEqual(after("نسخ، ق13، مشكّلة"), ["نسخ", "ق13، مشكّلة"]);
  assert.deepEqual(after("نسخ و نستعليق، مجدولة"), ["نسخ ونستعليق", "مجدولة"]);
  assert.deepEqual(after("نوع الخط:نستعليق"), ["نستعليق", ""]);
  assert.deepEqual(after("كتبت في كاشان، نوع الخط: نسخ، مجدولة"), ["نسخ", "كتبت في كاشان، مجدولة"]);
  assert.equal(typeof after("نسخ متعددة"), "string", "«نسخ متعددة» is skipped");
  assert.equal(typeof after("نوع الخط:نسخ مائل الى نستعليق"), "string");
  assert.equal(typeof applyFix("scriptInDesc", rec("نسخ، مجدولة", "ثلث")).skip, "string", "a filled script field is never overwritten");
  // MARC: 546 gets the script, the description note loses it, every other field stays where it was
  const r = applyFix("scriptInDesc", rec("نسخ، مجدولة"));
  const tags = r.record.marc21_rda.map(f => f.tag);
  assert.deepEqual(tags, [...tags].sort(), "fields stay in tag order");
  assert.ok(JSON.stringify(r.record.marc21_rda.find(f => f.tag === "546")).includes("خط نسخ."));
  assert.ok(r.record.marc21_rda.some(f => f.tag === "500" && f.subfields[0].value === "مجدولة."));
  // a MARC note the cataloger rewrote by hand: the record is left for a person
  const hand = rec("نسخ، مجدولة");
  hand.marc21_rda = hand.marc21_rda.map(f => f.tag === "500" ? { ...f, subfields: [{ code: "a", value: "نص كتبه المفهرس." }] } : f);
  assert.equal(applyFix("scriptInDesc", hand).skip, "حقول MARC معدّلة يدوياً");
});

test("libraries on the map: one point per institution, its count is its manuscripts", () => {
  const lp = require("../server/library_places");
  assert.equal(lp.institutionName("مكتبة العتبة العباسية المقدسة (ج1) في كربلاء المقدسة - العراق"), "مكتبة العتبة العباسية المقدسة");
  assert.equal(lp.placeKey("مكتبة العتبة العباسية المقدسة (ج4) - كربلاء المقدسة"), lp.placeKey("مكتبة العتبة العباسية المقدسة (ج2) في كربلاء المقدسة - العراق"), "volumes of one catalogue are one place");
  assert.notEqual(lp.placeKey("المكتبة المركزية - بغداد"), lp.placeKey("المكتبة المركزية - الموصل"), "same name, different city: two places");
  const a = lp.libraryPoint("مكتبة مجهولة الموقع - يزد"), b = lp.libraryPoint("مكتبة مجهولة الموقع - يزد");
  assert.deepEqual(a, b, "an approximate point is the same every time");
  assert.equal(a.exact, false);
  const city = gaz.libraryPlace("مكتبة مجهولة الموقع - يزد").place;
  const d = Math.hypot(a.lat - city.lat, (a.lon - city.lon) * Math.cos(city.lat * Math.PI / 180)) * 111;
  assert.ok(d > 1 && d < 5, `near its city, not on top of it (${d.toFixed(1)} km)`);
  const g = ins.geo([]);
  assert.equal(g.libraries.reduce((n, l) => n + l.count, 0), g.held, "every placed manuscript is at one institution");
  for (const l of g.libraries) {
    assert.equal(ins.records([["institution", l.key]]).total, l.count, l.label);
    assert.equal(l.catalogues.reduce((n, c) => n + c.count, 0), l.count);
  }
});

test("library locations: a place found online is taken only when its name really fits", () => {
  const { sameName, words } = require("../scripts/place_match");
  const city = key => { const p = gaz.BY_KEY.get(key); return [new Set(words([p.label, p.en, ...p.aliases].join(" "))), new Set(words([p.label, p.en].join(" ")))]; };
  const fits = (q, name, key, category = "amenity", type = "library") => sameName(q, { namedetails: typeof name === "string" ? { name } : name, category, type }, ...city(key));
  // right matches seen on the real catalogue
  assert.ok(fits("کتابخانه مجلس", "مرکز اسناد و کتابخانه مجلس شورای اسلامی", "tehran"));
  assert.ok(fits("مكتبة العتبة الرضوية المقدسة", "کتابخانه آستان قدس رضوی", "mashhad"), "a word that also names the city still matches");
  assert.ok(fits("حرم حضرت معصومه", "آرامگاه حضرت فاطمه معصومه", "qom", "historic", "tomb"));
  assert.ok(fits("مكتبة شاه چراغ", "ضريح شاه جراغ المقدس", "shiraz", "amenity", "place_of_worship"), "چ and ج are the same letter here");
  assert.ok(fits("Central Library University of Tehran", "Central library of University of Tehran", "tehran"));
  // wrong ones the rules must turn down
  assert.ok(!fits("University of Isfahan", "Isfahan University of Technology", "isfahan", "amenity", "university"), "only the city name in common");
  assert.ok(!fits("مكتبة مدرسة صدر", "دبستان امام موسی صدر", "isfahan", "amenity", "school"));
  assert.ok(!fits("Kadhimiya Shrine", "Al-Rasul Al-Azam Mosque", "kadhimiya", "amenity", "place_of_worship"), "the wrong mosque next door");
  assert.ok(!fits("مكتبة النجف الاشرف", { name: "Alkafeel University College", "name:ar": "كلية الكفيل الجامعة" }, "najaf", "amenity", "college"));
});

test("map connections: copy place -> library lines and shared works match the manuscripts", () => {
  const g = ins.geo([]);
  assert.ok(g.instFlows.length > 0);
  for (const f of g.instFlows) assert.equal(ins.records([["copyPlace", f.from], ["institution", f.to]]).total, f.count, `${f.from} > ${f.to}`);
  for (const s of g.shared) {
    assert.ok(s.a < s.b && s.works >= 3, "each pair once, with at least 3 shared works");
    const works = key => new Set(ins.matching([["institution", key]]).map(e => e.x.wk).filter(Boolean));
    const wa = works(s.a), wb = works(s.b);
    assert.ok([...wa].filter(w => wb.has(w)).length >= s.works, "they really hold that many works in common");
  }
});

test("network detail: a node's neighbours and expanding the graph", () => {
  const net = ins.network([], ["subject", "lang"], 3, 1);
  const n = net.nodes[0];
  const nb = ins.neighbors([], n.dim, n.value, 5);
  assert.equal(nb.node.count, n.count);
  for (const g of nb.groups) for (const x of g.items) {
    assert.equal(ins.records([[n.dim, n.value], [x.dim, x.value]]).total, x.count, `${n.id} + ${x.dim}:${x.value}`);
    assert.ok(x.count <= n.count && x.lift > 0);
  }
  assert.equal(ins.neighbors([], "nope", "x"), null);
  // an author that is not among the top values joins the graph when added, with its links recounted
  const author = nb.groups.find(g => g.dim === "author").items.at(-1);
  const net2 = ins.network([], ["subject", "lang"], 3, 1, [`author:${author.value}`]);
  assert.ok(net2.types.includes("author"));
  const i = net2.nodes.findIndex(x => x.id === `author:${author.value}`);
  assert.ok(i >= 0, "added node is in the graph");
  const j = net2.nodes.findIndex(x => x.id === n.id);
  const link = net2.links.find(l => (l.source === i && l.target === j) || (l.source === j && l.target === i));
  assert.equal(link && link.weight, author.count, "its link to the node it came from");
  assert.equal(ins.network([], ["subject"], 3, 1, ["nope:1", "../x"]).nodes.every(x => x.dim === "subject"), true, "unknown kinds are ignored");
});

test("geo and network are consistent with the counts", () => {
  const g = ins.geo([]);
  assert.equal(g.held + g.unplaced, lines.length, "every manuscript is placed or counted as unplaced");
  assert.equal(g.places.reduce((n, p) => n + p.held, 0), g.held);
  for (const p of g.places) assert.equal(p.libraries.reduce((n, l) => n + l.count, 0), p.held, p.key);
  const net = ins.network([], ["subject", "lang", "century"], 10, 1);
  assert.ok(net.nodes.length > 0);
  for (const l of net.links) {
    const a = net.nodes[l.source], b = net.nodes[l.target];
    assert.equal(ins.records([[a.dim, a.value], [b.dim, b.value]]).total, l.weight, `${a.id} + ${b.id}`);
  }
});
