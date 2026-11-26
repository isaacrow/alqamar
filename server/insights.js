// Al-Qamar insights: everything the Insights page shows — 25 charts, the map and the relationship network —
// computed from the in-memory search index, plus the list of manuscripts behind any bar, cell, point or node.
//
// The whole page rests on one idea: a *dimension* turns a manuscript into zero or more keys (its subjects,
// its century, the city of its library...). A chart counts keys; a click is a filter "dimension = key";
// the manuscripts behind a click are the ones whose keys include it. So every number on the page can be
// opened, and filters from any chart combine with any other.
"use strict";

const marc = require("./marc_builder");
const gaz = require("./gazetteer");
const libPlaces = require("./library_places");
const norm = marc.normalizeArabic;

// ----------------------------------------------------
// Per-manuscript facts (computed once when the record is indexed, kept on the search entry as e.x)
// ----------------------------------------------------
const MONTHS = [
  [/محرم/, 1], [/صفر/, 2], [/ربيع (ال)?اول/, 3], [/ربيع (ال)?(ثاني|اخر)/, 4], [/جمادي (ال)?اول/, 5],
  [/جمادي (ال)?(اخره|ثانيه|اخر|ثاني)/, 6], [/رجب/, 7], [/شعبان/, 8], [/رمضان/, 9], [/شوال/, 10],
  [/(ذي|ذو) ?(ال)?قعده/, 11], [/(ذي|ذو) ?(ال)?حج/, 12]
];
const MONTH_NAMES = ["", "محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"];
const WEEKDAYS = [[/السبت/, 0], [/الاحد/, 1], [/الاثنين/, 2], [/الثلاثاء/, 3], [/الاربعاء/, 4], [/الخميس/, 5], [/الجمعه/, 6]];
const WEEKDAY_NAMES = ["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];
const TIMES = [
  ["dawn", "الفجر والسحر", /فجر|سحر/], ["morning", "الضحى والصباح", /ضحي|صباح|غداه|بكره/], ["noon", "الظهر", /ظهر|زوال/],
  ["afternoon", "العصر", /وقت العصر|بعد العصر|قبل العصر|عصر يوم|عصرا|العصر من/], ["sunset", "المغرب", /مغرب|غروب/],
  ["evening", "العشاء", /عشاء|العشا(?!\p{L})/u], ["night", "الليل", /ليله|ليلا|الليل|منتصف الليل/]
];
const TIME_NAMES = Object.fromEntries(TIMES.map(([k, l]) => [k, l]));

// Physical features named in وصف النسخة (normalized text)
const FEATURES = [
  ["rubric", "عناوين وتمييز بالمداد الأحمر", /(مداد|حبر|لون|خط|بالخط|مميز[ه]?)\s*(ال)?احمر|حمرا|بالحمره|باللون الاحمر/],
  ["annot", "حواشٍ وتعليقات", /حواش|حاشيه|هوامش|هامش|تعليقات|تعليقه/],
  ["corrected", "مصححة أو مقابلة", /مصحح|تصحيح|مقابل|قوبلت|بلاغ|نسخ البدل/],
  ["owner", "تملّكات", /تملك/],
  ["waqf", "وقفيات", /وقف|موقوف/],
  ["seal", "أختام", /ختم|خاتم|اختام/],
  ["vocal", "مشكولة (مضبوطة بالحركات)", /مشكول|بالحركات|مضبوط[ه]? بال|بالشكل/],
  ["ruled", "مجدولة أو مؤطرة", /مجدول|جداول|مؤطر|اطار/],
  ["illum", "مذهّبة أو مزخرفة", /مذهب|تذهيب|بالذهب|مزخرف|زخرف|سرلوح|ترنج|شمسه|مزوق|تزويق|منمنم/],
  ["binding", "وصف التجليد", /جلد|تجليد|غلاف/],
  ["damage", "آثار رطوبة أو أرضة أو تلف", /رطوب|ارضه|تاكل|اكله|خروم|خرم|ترميم|تلف|ممزق|تمزق|بقع/],
  ["figures", "رسوم وأشكال", /رسوم|رسم|اشكال|منمنمات|دوائر/]
];
const FEATURE_NAMES = Object.fromEntries(FEATURES.map(([k, l]) => [k, l]));

const COPYIST_TYPES = { named: "ناسخ مسمّى", unknown: "ناسخ مجهول", autograph: "بخط المؤلف أو الجامع", multi: "نسّاخ متعددون", none: "لم يُسجّل الناسخ" };
const CONDITION_NAMES = { both: "ناقصة الأول والآخر", start: "ناقصة الأول", end: "ناقصة الآخر", other: "نقص أو خرم آخر", none: "لم يُذكر نقص", nodesc: "بلا وصف للنسخة" };

const authorCache = new Map();  // raw author -> { key, name, death }
const scribeCache = new Map();  // raw copyist -> { type, key, name }

function authorFacts(raw) {
  let hit = authorCache.get(raw);
  if (hit) return hit;
  const p = marc.parsePersonName(raw);
  hit = { key: "", name: "", death: null };
  if (p) {
    // honorifics in brackets are not part of the name: "كلام الله (عز وجل)" and "كلام الله" are one author
    hit.name = p.name.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim() || p.name;
    hit.key = norm(hit.name).replace(/[\s،,.]+$/, "");
    // "(ت842هـ)", "ت 842 هـ", "(ت. 1091هـ)" — Hijri death years only; a year marked م is Gregorian
    const m = norm(raw).match(/ت\s*\.?\s*(\d{3,4})\s*(هـ|ه|م)?/);
    if (m && m[2] !== "م") {
      const y = +m[1];
      if (y >= 1 && y <= 1450) hit.death = y;
    }
  }
  authorCache.set(raw, hit);
  return hit;
}

function scribeFacts(raw) {
  let hit = scribeCache.get(raw);
  if (hit) return hit;
  const n = norm(raw);
  if (!n || n === "بلا" || /^[؟?\-.\s]+$/.test(n)) hit = { type: "none", key: "", name: "" };
  else if (/^مجهول/.test(n) || n === "غير معروف") hit = { type: "unknown", key: "", name: "" };
  else {
    const s = marc.parseScribe(raw);
    if (s.note) hit = { type: /متعدد/.test(s.note) ? "multi" : "autograph", key: "", name: "" };
    else if (s.person) hit = { type: "named", key: norm(s.person.name), name: s.person.name };
    else hit = { type: "unknown", key: "", name: "" };
  }
  scribeCache.set(raw, hit);
  return hit;
}

// Uniform-title key: the first title before "=" (other titles of the same work), normalized
function workOf(title) {
  const first = marc.cleanText(title).split(/\s*=\s*/)[0].replace(/[\s.،,:/]+$/, "").trim();
  const key = norm(first).replace(/^[^\p{L}\p{N}]+/u, "");
  if (!key || key.length < 3 || /^(مجموع|مجموعه|بلا|بلا عنوان|رساله|كتاب|ورقه|اوراق|نبذه|فوائد|فائده|اجازه|كشكول)$/.test(key)) return ["", ""];
  return [key, first];
}

function insightFacts(get) {
  const a = authorFacts(get("المؤلف"));
  const s = scribeFacts(get("الناسخ"));
  const dateText = norm(get("تاريخ النسخ"));
  let mo = 0, wd = -1, tod = "";
  if (dateText && dateText !== "بلا") {
    for (const [re, n] of MONTHS) if (re.test(dateText)) { mo = n; break; }
    for (const [re, n] of WEEKDAYS) if (re.test(dateText)) { wd = n; break; }
    for (const [k, , re] of TIMES) if (re.test(dateText)) { tod = k; break; }
  }
  const desc = norm(get("وصف النسخة"));
  const hasDesc = desc && desc !== "بلا" && !/^[؟?]+$/.test(desc);
  let ft = 0;
  if (hasDesc) FEATURES.forEach(([, , re], b) => { if (re.test(desc)) ft |= 1 << b; });
  let cond = "nodesc";
  if (hasDesc) {
    if (/ناقص[ه]? (ال)?(اول|بدايه) ?و ?(ال)?(اخر|نهايه)|ناقص[ه]? الطرفين|مبتور[ه]? (ال)?طرفين/.test(desc)) cond = "both";
    else if (/ناقص[ه]? (من )?(ال)?(اول|بدايه)|مبتور[ه]? (ال)?(اول|بدايه)/.test(desc)) cond = "start";
    else if (/ناقص[ه]? (من )?(ال)?(اخر|نهايه)|مبتور[ه]? (ال)?(اخر|نهايه)/.test(desc)) cond = "end";
    else if (/ناقص|مبتور|خرم|سقط/.test(desc)) cond = "other";
    else cond = "none";
  }
  const leavesRaw = marc.cleanText(get("عدد الاوراق"));
  const lv = /^\d{1,4}$/.test(leavesRaw) ? +leavesRaw : null;
  const cpRaw = get("مكان النسخ");
  const cp = cpRaw && cpRaw !== "بلا" ? gaz.findPlace(cpRaw) : null;
  const [wk, wn] = workOf(get("العنوان"));
  // data-quality signals that need the raw text (the rest are worked out from the entry)
  const scriptField = norm(get("نوع الخط"));
  const scriptEmpty = !scriptField || scriptField === "بلا" || /^[؟?]+$/.test(scriptField);
  const q = {
    scriptInDesc: scriptEmpty && hasDesc && /نوع الخط|^(نسخ|نستعليق|ثلث|رقعه|شكسته)(\s|،|,|$)/.test(desc),
    placeUnmatched: !!(cpRaw && cpRaw !== "بلا" && !cp && /\p{L}{3}/u.test(cpRaw)),
    leavesOdd: !!(leavesRaw && leavesRaw !== "بلا" && !/^[؟?\-ـ\s]+$/.test(leavesRaw) && lv === null && !/^\d+\s*-\s*\d+$|ص|مجلد|مختلف/.test(leavesRaw))
  };
  return {
    ak: a.key, an: a.name, ad: a.death,
    st: s.type, ck: s.key, cn: s.name,
    mo, wd, tod, ft, cond, lv: lv && lv > 0 ? lv : null,
    cp: cp ? cp.key : "", wk, wn, q,
    // duplicate key: same title, same copy number (the library is added by the engine)
    dk: norm(get("العنوان")).replace(/[^\p{L}\p{N}]+/gu, "") + "|" + marc.cleanText(get("رقم النسخة"))
  };
}

// Data-quality checks: [key, label, explanation]
const ISSUES = [
  ["noDate", "بلا تاريخ نسخ مفهوم", "حقل تاريخ النسخ فارغ أو لا يُستخرج منه عام"],
  ["oddYear", "سنة نسخ غير معقولة", "قبل سنة 50 هـ أو بعد 1450 هـ"],
  ["beforeDeath", "النسخ قبل وفاة المؤلف بأكثر من 150 سنة", "خطأ في تاريخ النسخ أو في وفاة المؤلف"],
  ["noAuthor", "بلا مؤلف", "حقل المؤلف فارغ أو مجهول"],
  ["noSubject", "بلا موضوع", "حقل الموضوع فارغ أو «؟»"],
  ["noLang", "بلا لغة", "حقل اللغة فارغ"],
  ["noLeaves", "بلا عدد أوراق", "حقل عدد الأوراق فارغ"],
  ["leavesOdd", "عدد أوراق بصيغة غير موحّدة", "مثل «للمجموعة 215» أو «110/9»: يوحَّد إلى رقم أو مدى"],
  ["leavesHuge", "عدد أوراق كبير جداً (أكثر من 1500)", "تحقق من الرقم"],
  ["scriptInDesc", "نوع الخط مكتوب في الوصف لا في حقله", "يُنقل إلى حقل نوع الخط"],
  ["placeUnmatched", "مكان نسخ غير معروف على الخريطة", "اسم المكان غير موجود في معجم الأماكن"],
  ["libUnplaced", "خزانة بلا مكان", "اسم الخزانة لا يذكر مدينة أو بلداً"],
  ["duplicate", "سجل مكرر محتمل", "العنوان ورقم النسخة والخزانة نفسها في أكثر من سجل"]
];
const ISSUE_NAMES = Object.fromEntries(ISSUES.map(([k, l]) => [k, l]));

// ----------------------------------------------------
// Buckets
// ----------------------------------------------------
const LEAF_BUCKETS = [[1, 1, "ورقة واحدة"], [2, 5, "2–5"], [6, 10, "6–10"], [11, 20, "11–20"], [21, 50, "21–50"],
  [51, 100, "51–100"], [101, 200, "101–200"], [201, 400, "201–400"], [401, 1e9, "أكثر من 400"]];
const leafBucket = n => (n == null ? -1 : LEAF_BUCKETS.findIndex(([lo, hi]) => n >= lo && n <= hi));

const GAP_BUCKETS = [[-1e9, -1, "في حياة المؤلف"], [0, 25, "خلال 25 سنة من وفاته"], [26, 100, "26–100 سنة"],
  [101, 200, "101–200 سنة"], [201, 300, "201–300 سنة"], [301, 500, "301–500 سنة"], [501, 1e9, "أكثر من 500 سنة"]];
const gapBucket = (copyH, deathH) => {
  if (copyH == null || deathH == null) return -1;
  const g = copyH - deathH;
  // a copy made more than 150 years before the death year is a data error, not a fact
  if (g < -150) return -1;
  return GAP_BUCKETS.findIndex(([lo, hi]) => g >= lo && g <= hi);
};

function popcount(n) { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; }

// The kinds of value the network and a node's neighbours are made of.
const NET_ALLOWED = ["subject", "lang", "century", "country", "holdCity", "script", "author", "copyPlace", "authorCentury", "copyistType", "work", "feature", "library", "copyist", "institution"];

// ----------------------------------------------------
// The engine
// ----------------------------------------------------
class Insights {
  constructor(searchIndex, opts = {}) {
    this.si = searchIndex;
    this.languageNames = opts.languageNames || {};
    this.cache = new Map();
    this.libPlaceCache = new Map();
    this.dims = this.buildDimensions();
  }

  // A library's own point (library_places.js): { key, lat, lon, exact, osm } or null (cached; ~200 libraries)
  libPoint(lib) {
    if (lib < 0) return null;
    if (!this.libPointCache) this.libPointCache = new Map();
    if (!this.libPointCache.has(lib)) {
      const name = this.si.libraries[lib];
      const pt = libPlaces.libraryPoint(name);
      if (pt) { if (!this.instLabels) this.instLabels = new Map(); if (!this.instLabels.has(pt.key)) this.instLabels.set(pt.key, libPlaces.institutionName(name)); }
      this.libPointCache.set(lib, pt);
    }
    return this.libPointCache.get(lib);
  }
  instLabel(key) {
    if (!this.instLabels || !this.instLabels.has(key)) this.si.libraries.forEach((_, i) => this.libPoint(i));
    return (this.instLabels && this.instLabels.get(key)) || String(key).split("|")[0];
  }

  // place of a library id: { place, approx } (cached; ~200 libraries)
  libPlace(lib) {
    if (lib < 0) return { place: null, approx: false };
    let hit = this.libPlaceCache.get(lib);
    if (!hit) { hit = gaz.libraryPlace(this.si.libraries[lib]); this.libPlaceCache.set(lib, hit); }
    return hit;
  }

  // Data-quality issues of one manuscript (keys of ISSUES)
  issuesOf(e) {
    const out = [];
    const has = b => (e.has & (1 << b)) !== 0; // bits: COMPLETENESS_FIELDS in search_index.js
    if (!e.hStart) out.push("noDate");
    else if (e.hStart < 50 || e.hStart > 1450) out.push("oddYear");
    if (e.hStart && e.x.ad && e.hStart < e.x.ad - 150) out.push("beforeDeath");
    if (!has(0)) out.push("noAuthor");
    if (!has(2)) out.push("noSubject");
    if (!has(3)) out.push("noLang");
    if (!has(5)) out.push("noLeaves");
    if (e.x.q.leavesOdd) out.push("leavesOdd");
    if (e.x.lv > 1500) out.push("leavesHuge");
    if (e.x.q.scriptInDesc) out.push("scriptInDesc");
    if (e.x.q.placeUnmatched) out.push("placeUnmatched");
    if (!this.libPlace(e.lib).place) out.push("libUnplaced");
    if (this.duplicates().has(e.x.dk + "|" + e.lib)) out.push("duplicate");
    return out;
  }

  // keys (title | copy number | library) held by more than one record; rebuilt when a record is saved
  duplicates() {
    const v = this.si.version || 0;
    if (this._dups && this._dupsVersion === v) return this._dups;
    const seen = new Map();
    for (const e of this.si.entries) {
      if (!e || !e.x.dk || /\|(|بلا|0)$/.test(e.x.dk) || e.x.dk.startsWith("|")) continue;
      const k = e.x.dk + "|" + e.lib;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    this._dups = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
    this._dupsVersion = v;
    return this._dups;
  }

  buildDimensions() {
    const si = this.si;
    const cityName = k => (gaz.BY_KEY.get(k) || {}).label || k;
    const countryName = k => (k === "none" ? "غير محدد" : gaz.COUNTRY_LABELS[k] || k);
    const one = v => (v === null || v === undefined || v === "" || v === -1 ? [] : [v]);
    return {
      century: { label: "قرن النسخ", ordinal: true, keys: e => one(e.century), name: k => `ق ${k} هـ` },
      period: { label: "ربع القرن الهجري", ordinal: true, keys: e => (e.hStart ? [Math.floor(e.hStart / 25) * 25] : []), name: k => `${k}–${+k + 24} هـ` },
      lang: { label: "اللغة", keys: e => e.langs, name: k => this.languageNames[k] || k },
      country: { label: "دولة الحفظ", keys: e => { const p = this.libPlace(e.lib).place; return [p ? p.country : "none"]; }, name: countryName },
      library: { label: "الخزانة", keys: e => (e.lib >= 0 ? [e.lib] : []), name: k => si.libraries[k] || String(k) },
      // the institution in its city: the volumes of one library's catalogue ("(ج1)" … "(ج5)") together, as on the map
      institution: { label: "المؤسسة", keys: e => { const p = this.libPoint(e.lib); return p ? [p.key] : []; }, name: k => this.instLabel(k) },
      holdCity: { label: "مدينة الحفظ", keys: e => { const p = this.libPlace(e.lib).place; return p ? [p.key] : []; }, name: cityName },
      subject: { label: "الموضوع", keys: e => e.subjects, name: k => k },
      script: { label: "الخط", keys: e => e.scripts, name: k => k },
      author: { label: "المؤلف", keys: e => one(e.x.ak), name: (k, e) => (e && e.x.an) || k },
      work: { label: "العمل", keys: e => one(e.x.wk), name: (k, e) => (e && e.x.wn) || k },
      copyist: { label: "الناسخ", keys: e => one(e.x.ck), name: (k, e) => (e && e.x.cn) || k },
      copyistType: { label: "نوع النسخ", keys: e => [e.x.st], name: k => COPYIST_TYPES[k] || k },
      copyPlace: { label: "مكان النسخ", keys: e => one(e.x.cp), name: cityName },
      copyCountry: { label: "بلد النسخ", keys: e => { const p = e.x.cp && gaz.BY_KEY.get(e.x.cp); return p ? [p.country] : []; }, name: countryName },
      authorCentury: { label: "قرن وفاة المؤلف", ordinal: true, keys: e => (e.x.ad ? [Math.floor((e.x.ad - 1) / 100) + 1] : []), name: k => `ق ${k} هـ` },
      gap: { label: "المسافة بين وفاة المؤلف والنسخ", ordinal: true, keys: e => one(gapBucket(e.hStart, e.x.ad)), name: k => GAP_BUCKETS[k][2] },
      leaves: { label: "عدد الأوراق", ordinal: true, keys: e => one(leafBucket(e.x.lv)), name: k => LEAF_BUCKETS[k][2] },
      feature: { label: "سمة مادية", keys: e => { const out = []; for (let b = 0; b < FEATURES.length; b++) if (e.x.ft & (1 << b)) out.push(FEATURES[b][0]); return out; }, name: k => FEATURE_NAMES[k] || k },
      condition: { label: "حالة الاكتمال", keys: e => [e.x.cond], name: k => CONDITION_NAMES[k] || k },
      month: { label: "شهر النسخ", ordinal: true, keys: e => one(e.x.mo || ""), name: k => MONTH_NAMES[k] },
      weekday: { label: "يوم النسخ", ordinal: true, keys: e => one(e.x.wd), name: k => WEEKDAY_NAMES[k] },
      timeOfDay: { label: "وقت النسخ", keys: e => one(e.x.tod), name: k => TIME_NAMES[k] || k },
      completeness: { label: "درجة اكتمال الفهرسة", ordinal: true, keys: e => [popcount(e.has)], name: k => `${k} من 10 حقول` },
      issue: { label: "مشكلة في البيانات", keys: e => this.issuesOf(e), name: k => ISSUE_NAMES[k] || k }
    };
  }

  // filters: [[dim, key], ...] from "dim:key" strings; unknown dimensions are dropped
  parseFilters(list) {
    const out = [];
    for (const raw of list || []) {
      const s = String(raw);
      const i = s.indexOf(":");
      if (i < 1) continue;
      const dim = s.slice(0, i), key = s.slice(i + 1);
      if (this.dims[dim] && key !== "" && out.length < 8) out.push([dim, key]);
    }
    return out;
  }

  // Calls fn(e) for every manuscript passing all filters
  each(filters, fn) {
    const dims = filters.map(([d, k]) => [this.dims[d], k]);
    const entries = this.si.entries;
    outer: for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      for (const [dim, k] of dims) {
        const keys = dim.keys(e);
        let hit = false;
        for (let j = 0; j < keys.length; j++) if (String(keys[j]) === k) { hit = true; break; }
        if (!hit) continue outer;
      }
      fn(e);
    }
  }

  cached(key, compute) {
    const v = this.si.version || 0;
    const full = v + "|" + key;
    if (this.cache.has(full)) return this.cache.get(full);
    const result = compute();
    if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(full, result);
    return result;
  }

  // ---------------- All chart data ----------------
  summary(filters) {
    return this.cached("summary:" + JSON.stringify(filters), () => {
      const t0 = Date.now();
      const CHART_DIMS = ["century", "period", "lang", "country", "library", "holdCity", "subject", "script", "author", "work",
        "copyist", "copyistType", "copyPlace", "copyCountry", "authorCentury", "gap", "leaves", "feature", "condition", "month",
        "weekday", "timeOfDay", "completeness", "issue"];
      const counts = Object.fromEntries(CHART_DIMS.map(d => [d, new Map()]));
      const sample = Object.fromEntries(CHART_DIMS.map(d => [d, new Map()])); // key -> an entry, for display names
      const HEAT = [["subject", "century"], ["lang", "century"], ["country", "century"], ["library", "issue"]];
      const heat = HEAT.map(() => new Map());
      let total = 0, dated = 0, withAuthorDeath = 0, withLeaves = 0, leavesSum = 0, withDesc = 0, withCopyPlace = 0, withDateParts = 0;
      const authors = new Set(), works = new Set(), copyists = new Set(), libs = new Set();
      const years = [];

      this.each(filters, e => {
        total++;
        if (e.century) dated++;
        if (e.x.ad) withAuthorDeath++;
        if (e.x.lv) { withLeaves++; leavesSum += e.x.lv; }
        if (e.x.cond !== "nodesc") withDesc++;
        if (e.x.cp) withCopyPlace++;
        if (e.x.mo || e.x.wd >= 0) withDateParts++;
        if (e.x.ak) authors.add(e.x.ak);
        if (e.x.wk) works.add(e.x.wk);
        if (e.x.ck) copyists.add(e.x.ck);
        if (e.lib >= 0) libs.add(e.lib);
        if (e.hStart) years.push(e.hStart);
        for (const d of CHART_DIMS) {
          const keys = this.dims[d].keys(e);
          const m = counts[d];
          for (const k of keys) {
            m.set(k, (m.get(k) || 0) + 1);
            if (!sample[d].has(k)) sample[d].set(k, e);
          }
        }
        HEAT.forEach(([a, b], i) => {
          const ka = this.dims[a].keys(e), kb = this.dims[b].keys(e);
          for (const x of ka) for (const y of kb) { const key = x + "\u0001" + y; heat[i].set(key, (heat[i].get(key) || 0) + 1); }
        });
      });

      const list = (d, n) => {
        const dim = this.dims[d];
        let arr = [...counts[d].entries()];
        if (dim.ordinal) arr.sort((a, b) => +a[0] - +b[0]);
        else arr.sort((a, b) => b[1] - a[1]);
        if (n && !dim.ordinal) arr = arr.slice(0, n);
        return arr.map(([k, c]) => ({ value: String(k), label: dim.name(k, sample[d].get(k)), count: c }));
      };
      const charts = {};
      const TOP = { library: 15, holdCity: 15, subject: 15, author: 15, work: 15, copyist: 15, copyPlace: 15, country: 15, copyCountry: 12, lang: 8, script: 10 };
      for (const d of CHART_DIMS) charts[d] = list(d, TOP[d] || 0);
      // fill gaps in ordinal series so time axes are continuous
      for (const d of ["century", "authorCentury"]) {
        const arr = charts[d];
        if (arr.length > 1) {
          const have = new Map(arr.map(x => [+x.value, x]));
          const lo = +arr[0].value, hi = +arr[arr.length - 1].value, out = [];
          for (let c = lo; c <= hi; c++) out.push(have.get(c) || { value: String(c), label: `ق ${c} هـ`, count: 0 });
          charts[d] = out;
        }
      }
      if (charts.period.length) charts.period = charts.period.filter(p => +p.value >= 1);

      const heatmaps = HEAT.map(([a, b], i) => {
        const rowsTop = charts[a].slice(0, a === "subject" ? 14 : a === "library" ? 15 : a === "country" ? 10 : 6).map(r => r.value);
        const cols = charts[b].filter(c => c.count > 0).map(c => c.value);
        const cells = [];
        for (const r of rowsTop) for (const c of cols) {
          const n = heat[i].get(r + "\u0001" + c) || 0;
          if (n) cells.push([r, c, n]);
        }
        return {
          rows: rowsTop.map(r => { const x = charts[a].find(y => y.value === r); return { value: r, label: x.label, count: x.count }; }),
          cols: cols.map(c => ({ value: c, label: this.dims[b].name(c) })),
          rowDim: a, colDim: b, cells
        };
      });

      return {
        total, dated, withAuthorDeath, withLeaves, withDesc, withCopyPlace, withDateParts,
        avgLeaves: withLeaves ? Math.round(leavesSum / withLeaves) : 0,
        distinct: { authors: authors.size, works: works.size, copyists: copyists.size, libraries: libs.size },
        // median and middle-80% span of copy years (the extremes hold data-entry errors such as "year 1")
        years: years.length ? (() => {
          years.sort((a, b) => a - b);
          const q = f => years[Math.min(years.length - 1, Math.floor(f * years.length))];
          return { median: q(0.5), p10: q(0.1), p90: q(0.9) };
        })() : null,
        charts, heatmaps,
        dimLabels: Object.fromEntries(Object.entries(this.dims).map(([k, d]) => [k, d.label])),
        tookMs: Date.now() - t0
      };
    });
  }

  // ---------------- Manuscripts behind a click ----------------
  matching(filters, sort = "") {
    const matched = [];
    this.each(filters, e => matched.push(e));
    if (sort === "date") matched.sort((a, b) => (a.hStart == null) - (b.hStart == null) || (a.hStart || 0) - (b.hStart || 0) || a.idx - b.idx);
    else if (sort === "leaves") matched.sort((a, b) => (b.x.lv || 0) - (a.x.lv || 0) || a.idx - b.idx);
    return matched;
  }

  records(filters, offset = 0, limit = 50, sort = "") {
    const matched = this.matching(filters, sort);
    const items = matched.slice(offset, offset + limit).map(e => ({
      idx: e.idx, id: e.id, title: e.title, author: e.author, subject: e.subject, copyNum: e.copyNum,
      hijriYear: e.hStart, year: e.gStart, library: e.lib >= 0 ? this.si.libraries[e.lib] : "",
      copyist: e.x.cn || COPYIST_TYPES[e.x.st], leaves: e.x.lv, copyPlace: e.x.cp ? (gaz.BY_KEY.get(e.x.cp) || {}).label : "",
      issues: this.issuesOf(e).map(k => ISSUE_NAMES[k])
    }));
    return {
      total: matched.length, items,
      filters: filters.map(([d, k]) => ({ dim: d, dimLabel: this.dims[d].label, value: k, label: this.labelOf(d, k) }))
    };
  }

  // The same list as CSV (UTF-8 with BOM so Excel reads the Arabic). Cells that a spreadsheet would run as a
  // formula (= + - @ at the start) get a leading apostrophe.
  exportCsv(filters, sort = "") {
    const cell = v => {
      let s = v === null || v === undefined ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ["رقم السجل", "المعرف", "العنوان", "المؤلف", "وفاة المؤلف (هـ)", "الموضوع", "اللغة", "سنة النسخ (هـ)", "سنة النسخ (م)",
      "الناسخ", "مكان النسخ", "عدد الأوراق", "الخزانة", "رقم النسخة", "مشكلات البيانات"];
    const lines = [head.map(cell).join(",")];
    for (const e of this.matching(filters, sort)) {
      lines.push([
        e.idx + 1, e.id, e.title, e.author, e.x.ad, e.subject, e.langs.map(l => this.languageNames[l] || l).join("، "),
        e.hStart, e.gStart, e.x.cn || COPYIST_TYPES[e.x.st], e.x.cp ? (gaz.BY_KEY.get(e.x.cp) || {}).label : "", e.x.lv,
        e.lib >= 0 ? this.si.libraries[e.lib] : "", e.copyNum, this.issuesOf(e).map(k => ISSUE_NAMES[k]).join("؛ ")
      ].map(cell).join(","));
    }
    return "﻿" + lines.join("\r\n") + "\r\n";
  }

  labelOf(dim, key) {
    const d = this.dims[dim];
    if (!d) return key;
    if (dim === "author" || dim === "work" || dim === "copyist") {
      // display name from any manuscript holding that key
      const field = { author: ["ak", "an"], work: ["wk", "wn"], copyist: ["ck", "cn"] }[dim];
      for (const e of this.si.entries) if (e && e.x[field[0]] === key) return e.x[field[1]];
      return key;
    }
    try { return d.name(isNaN(key) ? key : (dim === "library" || d.ordinal ? +key : key)) || key; } catch (err) { return key; }
  }

  // ---------------- Map ----------------
  geo(filters) {
    return this.cached("geo:" + JSON.stringify(filters), () => {
      const places = new Map(); // key -> { held, copied, libs: Map, approx }
      const flows = new Map();
      const P = key => {
        let p = places.get(key);
        if (!p) { p = { held: 0, copied: 0, libs: new Map(), approx: false, centuries: new Map() }; places.set(key, p); }
        return p;
      };
      let held = 0, unplaced = 0, copied = 0;
      const insts = new Map(); // institution key -> { count, point, libs: Map(id -> count) }
      const instFlows = new Map(); // "copy place>institution" -> manuscripts copied there and kept here
      const workInsts = new Map(); // work -> Map(institution -> copies held)
      this.each(filters, e => {
        const pt = this.libPoint(e.lib);
        if (pt) {
          let it = insts.get(pt.key);
          if (!it) { it = { count: 0, pt, libs: new Map() }; insts.set(pt.key, it); }
          it.count++;
          it.libs.set(e.lib, (it.libs.get(e.lib) || 0) + 1);
          if (e.x.cp) { const k = e.x.cp + ">" + pt.key; instFlows.set(k, (instFlows.get(k) || 0) + 1); }
          if (e.x.wk) {
            let m = workInsts.get(e.x.wk);
            if (!m) { m = new Map(); workInsts.set(e.x.wk, m); }
            m.set(pt.key, (m.get(pt.key) || 0) + 1);
          }
        }
        const lp = this.libPlace(e.lib);
        if (lp.place) {
          const p = P(lp.place.key);
          p.held++; held++;
          if (lp.approx) p.approx = true;
          p.libs.set(e.lib, (p.libs.get(e.lib) || 0) + 1);
        } else unplaced++;
        if (e.x.cp) {
          const p = P(e.x.cp);
          p.copied++; copied++;
          if (e.century) p.centuries.set(e.century, (p.centuries.get(e.century) || 0) + 1);
          if (lp.place && lp.place.key !== e.x.cp) {
            const k = e.x.cp + ">" + lp.place.key;
            flows.set(k, (flows.get(k) || 0) + 1);
          }
        }
      });
      // Libraries linked by the works they both hold a copy of. A work found in very many libraries (the Qur'an,
      // the standard textbooks) says little about any two of them, so works in more than 40 libraries are left out.
      const pairs = new Map(), pairWorks = new Map();
      for (const [wk, m] of workInsts) {
        if (m.size < 2 || m.size > 40) continue;
        const ks = [...m.keys()].sort();
        for (let a = 0; a < ks.length; a++) for (let b = a + 1; b < ks.length; b++) {
          const k = ks[a] + "\u0000" + ks[b];
          pairs.set(k, (pairs.get(k) || 0) + 1);
          if (!pairWorks.has(k)) pairWorks.set(k, wk);
        }
      }
      const shared = [...pairs.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 600)
        .map(([k, n]) => { const [a, b] = k.split("\u0000"); return { a, b, works: n }; });
      return {
        held, unplaced, copied,
        // copy place -> the institution that keeps the manuscript today (not just its city)
        instFlows: [...instFlows.entries()].map(([k, n]) => { const i = k.indexOf(">"); return { from: k.slice(0, i), to: k.slice(i + 1), count: n }; })
          .sort((a, b) => b.count - a.count).slice(0, 800),
        // institution <-> institution: how many works both hold (works held by 2 to 40 libraries, at least 3 shared)
        shared,
        places: [...places.entries()].map(([key, p]) => {
          const g = gaz.BY_KEY.get(key);
          return {
            key, label: g.label, country: g.countryLabel, lat: g.lat, lon: g.lon, held: p.held, copied: p.copied, approx: p.approx,
            libraries: [...p.libs.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, name: this.si.libraries[id], count: n })),
            centuries: [...p.centuries.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => ({ century: c, count: n }))
          };
        }),
        flows: [...flows.entries()].map(([k, n]) => { const [from, to] = k.split(">"); return { from, to, count: n }; }).sort((a, b) => b.count - a.count),
        // each holding institution at its own point (OpenStreetMap), or near its city when none was found
        libraries: [...insts.entries()].map(([key, it]) => {
          const city = key.split("|").pop();
          return {
            key, label: this.instLabel(key), city, cityLabel: (gaz.BY_KEY.get(city) || {}).label || city,
            lat: +it.pt.lat.toFixed(5), lon: +it.pt.lon.toFixed(5), exact: it.pt.exact, osm: it.pt.osm, count: it.count,
            catalogues: [...it.libs.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, name: this.si.libraries[id], count: n }))
          };
        }).sort((a, b) => b.count - a.count)
      };
    });
  }

  // ---------------- Relationship network ----------------
  // Nodes: the top values of each chosen dimension; edges: how many manuscripts share both.
  // How many manuscripts in the scope have each value of one dimension (cached; used for lift).
  valueCounts(filters, dim) {
    return this.cached("vc:" + JSON.stringify([filters, dim]), () => {
      const m = new Map();
      let total = 0;
      this.each(filters, e => { total++; for (const k of this.dims[dim].keys(e)) m.set(k, (m.get(k) || 0) + 1); });
      return { total, m };
    });
  }

  // Everything one value goes together with: for each kind of value, the ones found in the most of its manuscripts,
  // with the share of its manuscripts and the lift (how much more often than chance), plus the most distinctive
  // links overall (highest lift among those with enough manuscripts to mean something).
  neighbors(filters, dim, value, perType = 8) {
    if (!NET_ALLOWED.includes(dim)) return null;
    perType = Math.max(3, Math.min(20, perType | 0 || 8));
    value = String(value);
    return this.cached("nb:" + JSON.stringify([filters, dim, value, perType]), () => {
      const counts = Object.fromEntries(NET_ALLOWED.map(t => [t, new Map()]));
      const sample = new Map();
      let n = 0, nodeSample = null;
      this.each([...filters, [dim, value]], e => {
        n++;
        if (!nodeSample) nodeSample = e;
        for (const t of NET_ALLOWED) for (const k of this.dims[t].keys(e)) {
          if (t === dim && String(k) === value) continue;
          counts[t].set(k, (counts[t].get(k) || 0) + 1);
          if (!sample.has(t + ":" + k)) sample.set(t + ":" + k, e);
        }
      });
      const scope = this.valueCounts(filters, dim);
      const groups = [], all = [];
      for (const t of NET_ALLOWED) {
        const base = this.valueCounts(filters, t);
        const items = [...counts[t].entries()]
          .filter(([k]) => k !== "none" && k !== "nodesc")
          .map(([k, c]) => {
            const lift = (c * base.total) / (n * (base.m.get(k) || c));
            return { dim: t, value: String(k), label: this.dims[t].name(k, sample.get(t + ":" + k)), count: c, share: Math.round(1000 * c / n) / 10, lift: Math.round(lift * 100) / 100 };
          })
          .sort((a, b) => b.count - a.count);
        all.push(...items);
        if (items.length) groups.push({ dim: t, label: this.dims[t].label, total: items.length, items: items.slice(0, perType) });
      }
      const floor = Math.max(5, Math.ceil(n * 0.02));
      const distinctive = all.filter(x => x.dim !== "library" && x.count >= floor && x.lift >= 1.5).sort((a, b) => b.lift - a.lift).slice(0, 10);
      return {
        node: { dim, value, label: this.dims[dim].name(value, nodeSample), count: n, share: Math.round(1000 * n / (scope.total || 1)) / 10 },
        total: scope.total, groups, distinctive
      };
    });
  }

  network(filters, types, perType = 10, minWeight = 5, include = []) {
    const allowed = NET_ALLOWED;
    types = (types || []).filter(t => allowed.includes(t)).slice(0, 8);
    if (!types.length) types = ["subject", "lang", "century", "country", "script"];
    // Nodes added by hand (expanding from a node): kept even when not in their type's top values. A type that only
    // comes in this way shows just those nodes, not its whole top list.
    include = [...new Set((include || []).map(String))].filter(id => allowed.includes(id.split(":")[0])).slice(0, 200);
    const chosen = new Set(types);
    for (const id of include) { const t = id.split(":")[0]; if (!types.includes(t)) types.push(t); }
    // up to 60 per type: the galaxy view draws a few hundred nodes
    perType = Math.max(3, Math.min(60, perType | 0 || 10));
    minWeight = Math.max(1, minWeight | 0 || 1);
    const forced = new Set(include);
    return this.cached("net:" + JSON.stringify([filters, types, perType, minWeight, include]), () => {
      // own count of every value of the chosen types (the charts keep only their top 15)
      const counts = Object.fromEntries(types.map(t => [t, new Map()]));
      const sample = Object.fromEntries(types.map(t => [t, new Map()]));
      let total = 0;
      this.each(filters, e => {
        total++;
        for (const t of types) for (const k of this.dims[t].keys(e)) {
          counts[t].set(k, (counts[t].get(k) || 0) + 1);
          if (!sample[t].has(k)) sample[t].set(k, e);
        }
      });
      const s = { total, dimLabels: Object.fromEntries(Object.entries(this.dims).map(([k, d]) => [k, d.label])) };
      const nodes = [];
      const index = new Map();
      for (const t of types) {
        const arr = [...counts[t].entries()]
          .filter(([k, c]) => c > 0 && k !== "none" && k !== "nodesc")
          .sort((a, b) => b[1] - a[1])
          .map(([k, c]) => ({ value: String(k), label: this.dims[t].name(k, sample[t].get(k)), count: c }));
        const top = chosen.has(t) ? perType : 0;
        arr.forEach((x, rank) => {
          const id = t + ":" + x.value;
          if (rank >= top && !forced.has(id)) return;
          index.set(id, nodes.length);
          nodes.push({ id, dim: t, value: x.value, label: x.label, count: x.count, added: rank >= top });
        });
      }
      const pairs = new Map();
      this.each(filters, e => {
        const mine = [];
        for (const t of types) for (const k of this.dims[t].keys(e)) { const i = index.get(t + ":" + k); if (i !== undefined) mine.push(i); }
        for (let a = 0; a < mine.length; a++) for (let b = a + 1; b < mine.length; b++) {
          const x = Math.min(mine[a], mine[b]), y = Math.max(mine[a], mine[b]);
          if (nodes[x].dim === nodes[y].dim && nodes[x].dim !== "subject" && nodes[x].dim !== "feature" && nodes[x].dim !== "lang") continue;
          const key = x * 4096 + y;
          pairs.set(key, (pairs.get(key) || 0) + 1);
        }
      });
      const base = s.total || 1;
      const links = [];
      for (const [key, w] of pairs) {
        if (w < minWeight) continue;
        const x = Math.floor(key / 4096), y = key % 4096;
        // lift > 1: the two go together more often than chance
        const lift = (w * base) / (nodes[x].count * nodes[y].count);
        links.push({ source: x, target: y, weight: w, lift: Math.round(lift * 100) / 100 });
      }
      links.sort((a, b) => b.weight - a.weight);
      return { total: s.total, types, include, nodes, links: links.slice(0, 6000), dimLabels: s.dimLabels };
    });
  }
}

module.exports = { Insights, insightFacts, FEATURES, MONTH_NAMES, WEEKDAY_NAMES, LEAF_BUCKETS, GAP_BUCKETS };
