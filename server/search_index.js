// Al-Qamar search: an in-memory index over all manuscripts with Arabic-aware matching,
// field search, filters (language, century, script, library, subject, date range),
// counts for each filter value, and sorting.
//
// Matching ignores the differences that make Arabic searches miss:
//   أ إ آ ٱ -> ا, ى/ی -> ي, ة -> ه, ؤ -> و, ئ -> ي, ک -> ك, tashkeel and tatweel removed,
//   Persian/Arabic-Indic digits -> 0-9.  So "اصول" finds "أصول" and "الطوسى" finds "الطوسي".
"use strict";

const marc = require("./marc_builder");
const { insightFacts } = require("./insights");
const norm = marc.normalizeArabic;

// ----------------------------------------------------
// Facet vocabularies
// ----------------------------------------------------
const LANGUAGE_NAMES = {
  ara: "عربي", per: "فارسي", ota: "تركي عثماني", urd: "أردو", kur: "كردي", pus: "پشتو", syr: "سرياني",
  heb: "عبري", may: "ملايو", lat: "لاتيني", eng: "إنجليزي", fre: "فرنسي", ger: "ألماني", und: "غير محددة"
};

const SCRIPTS = [
  ["نسخ", /نسخ/], ["نستعليق", /نستعلي?ق/], ["شكسته", /شكسته|شكست/], ["ثلث", /ثلث/], ["رقعة", /رقعه/],
  ["كوفي", /كوفي/], ["مغربي", /مغربي/], ["سياق", /سياق/], ["ديواني", /ديواني/], ["تعليق", /تعليق/]
];

function scriptsOf(raw) {
  const n = norm(raw);
  if (!n || n === "بلا") return [];
  // "نستعليق" contains "تعليق"; test the plain تعليق script on the text without it
  const withoutNastaliq = n.replace(/نستعلي?ق/g, " ");
  const out = SCRIPTS.filter(([name, re]) => re.test(name === "تعليق" ? withoutNastaliq : n)).map(([name]) => name);
  return out.length ? out : ["أخرى"];
}

// Exact (tabular) Hijri year of a Gregorian day, for the century facet.
function gregorianToJdn(y, m, d) {
  const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}
function hijriYearOfJdn(jdn) {
  return Math.floor((30 * (jdn - 1948440) + 10646) / 10631);
}
// Hijri century of a record, from its earliest copy date (the same date the range filter uses).
//   A Hijri year given alone is stored as two Gregorian years (1688-1689 for 1100 AH): the Hijri year is the
//   one in force on 1 January of the second.  A single Gregorian year: take its middle (1 July).
function hijriStartYear(gStart, gEnd) {
  if (gStart == null) return null;
  const jdn = gEnd != null && gEnd > gStart ? gregorianToJdn(gStart + 1, 1, 1) : gregorianToJdn(gStart, 7, 1);
  const h = hijriYearOfJdn(jdn);
  return h >= 1 ? h : null;
}
function hijriCenturyOf(gStart, gEnd) {
  const h = hijriStartYear(gStart, gEnd);
  return h ? Math.floor((h - 1) / 100) + 1 : null;
}

// 008/06-14 -> Gregorian start/end years (null when unknown)
function datesFrom008(f008) {
  if (!f008 || f008.length < 15) return [null, null];
  const type = f008[6];
  const d1 = f008.slice(7, 11), d2 = f008.slice(11, 15);
  if (type === "n" || !/^\d{4}$/.test(d1)) {
    // "s18uu" style partial year from older records
    if (/^\d{2}uu$/.test(d1)) return [+d1.slice(0, 2) * 100, +d1.slice(0, 2) * 100 + 99];
    return [null, null];
  }
  const start = +d1;
  const end = /^\d{4}$/.test(d2) && (type === "q" || type === "i" || type === "m" || type === "k") ? +d2 : start;
  return [start, Math.max(start, end)];
}

// ----------------------------------------------------
// Index
// ----------------------------------------------------
class SearchIndex {
  constructor() {
    this.entries = [];
    this.libraries = [];          // id -> name
    this.libraryIds = new Map();  // name -> id
    this.collator = new Intl.Collator("ar");
  }

  libraryId(name) {
    const clean = marc.cleanText(name);
    if (!clean || clean === "بلا") return -1;
    let id = this.libraryIds.get(clean);
    if (id === undefined) {
      id = this.libraries.length;
      this.libraries.push(clean);
      this.libraryIds.set(clean, id);
    }
    return id;
  }

  // record: { id, source_fields }, f008: the 008 value (or ""), edited: boolean
  makeEntry(idx, record, f008, edited) {
    const f = (record && record.source_fields) || {};
    const get = k => (typeof f[k] === "string" ? f[k] : "");
    const [gStart, gEnd] = datesFrom008(f008);
    const subjects = get("الموضوع").split(/\s*[،,]\s*/).map(s => norm(s)).filter(s => s && s !== "بلا" && s !== "؟");
    return {
      idx,
      id: String(record && record.id || ""),
      title: get("العنوان"),
      author: get("المؤلف"),
      subject: get("الموضوع"),
      copyNum: get("رقم النسخة"),
      edited: !!edited,
      // normalized search fields
      nt: norm(get("العنوان")),
      // filing form: leading punctuation and the article "ال" are ignored, as in Arabic catalogs
      sortTitle: norm(get("العنوان")).replace(/^[^\p{L}\p{N}]+/u, "").replace(/^ال(?=\S{2})/, ""),
      na: norm(get("المؤلف")),
      ns: norm(get("الموضوع")),
      nc: norm(get("الناسخ")),
      nx: norm([get("أول النسخة"), get("آخر النسخة"), get("وصف النسخة"), get("مكان النسخ")].join(" ")),
      nl: norm(get("المصدر")),
      // facets
      langs: marc.parseLanguages(get("اللغة")).codes,
      scripts: scriptsOf(get("نوع الخط")),
      lib: this.libraryId(get("المصدر")),
      subjects,
      gStart,
      gEnd,
      hStart: hijriStartYear(gStart, gEnd),
      century: hijriCenturyOf(gStart, gEnd),
      // completeness flags (which source fields actually hold information)
      has: completenessBits(get),
      // facts for the Insights page (author death year, copyist, leaves, copy place, features...)
      x: insightFacts(get)
    };
  }

  set(idx, record, f008, edited) {
    this.entries[idx] = this.makeEntry(idx, record, f008, edited);
    this.version = (this.version || 0) + 1; // lets cached analytics notice a saved edit
  }

  // Country code of a library id (cached: ~200 libraries)
  countryOf(lib) {
    if (lib < 0) return null;
    if (!this._countries) this._countries = new Map();
    if (!this._countries.has(lib)) this._countries.set(lib, marc.countryCode(this.libraries[lib]) || null);
    return this._countries.get(lib);
  }

  // ----------------------------------------------------
  // Dashboard analytics over the whole catalog, or a filtered slice of it
  // params: { lang, country, library, century, subject, script }
  // ----------------------------------------------------
  analytics(params, workflow) {
    const t0 = Date.now();
    const want = {
      lang: params.lang || "",
      country: params.country || "",
      library: params.library !== undefined && params.library !== "" ? parseInt(params.library, 10) : null,
      century: params.century ? parseInt(params.century, 10) : null,
      subject: params.subject ? norm(params.subject) : "",
      script: params.script || ""
    };
    const centuries = new Map(), langs = new Map(), countries = new Map(), libs = new Map(), subjects = new Map(), scripts = new Map();
    const fieldCounts = new Array(COMPLETENESS_FIELDS.length).fill(0);
    let total = 0, dated = 0, withScript = 0;
    const wf = { approved: 0, review: 0, attention: 0, bookmarked: 0 };

    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e) continue;
      const country = this.countryOf(e.lib);
      if (want.lang && !e.langs.includes(want.lang)) continue;
      if (want.country && (country || "none") !== want.country) continue;
      if (want.library !== null && e.lib !== want.library) continue;
      if (want.century !== null && e.century !== want.century) continue;
      if (want.subject && !e.subjects.includes(want.subject)) continue;
      if (want.script && !e.scripts.includes(want.script)) continue;

      total++;
      if (e.century) { dated++; bump(centuries, e.century); }
      for (const l of e.langs) bump(langs, l);
      bump(countries, country || "none");
      if (e.lib >= 0) bump(libs, e.lib);
      for (const s of e.subjects) bump(subjects, s);
      if (e.scripts.length) { withScript++; for (const s of e.scripts) bump(scripts, s); }
      for (let b = 0; b < COMPLETENESS_FIELDS.length; b++) if (e.has & (1 << b)) fieldCounts[b]++;
      const w = workflow[i];
      if (w) {
        if (w.status === "approved") wf.approved++;
        else if (w.status === "review") wf.review++;
        else if (w.status === "attention") wf.attention++;
        if (w.bookmarked) wf.bookmarked++;
      }
    }

    const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    const centuryList = [];
    if (centuries.size) {
      const cs = [...centuries.keys()];
      for (let c = Math.min(...cs); c <= Math.max(...cs); c++) {
        centuryList.push({ value: c, label: `ق ${c} هـ`, count: centuries.get(c) || 0,
          gFrom: marc.hijriToGregorianYears((c - 1) * 100 + 1)[0], gTo: marc.hijriToGregorianYears(c * 100)[1] });
      }
    }
    return {
      total, dated, undated: total - dated, withScript,
      workflow: wf,
      centuries: centuryList,
      languages: top(langs, 20).map(([k, n]) => ({ value: k, label: LANGUAGE_NAMES[k] || k, count: n })),
      countries: top(countries, 30).map(([k, n]) => ({ value: k, label: COUNTRY_NAMES[k] || k, count: n })),
      libraries: top(libs, 15).map(([k, n]) => ({ value: k, label: this.libraries[k], count: n, country: this.countryOf(k) })),
      subjects: top(subjects, 15).map(([k, n]) => ({ value: k, label: k, count: n })),
      scripts: top(scripts, 12).map(([k, n]) => ({ value: k, label: k, count: n })),
      completeness: COMPLETENESS_FIELDS.map(([key, label], b) => ({ value: key, label, count: fieldCounts[b] })),
      tookMs: Date.now() - t0
    };
  }

  // Values for the dashboard's filter row
  filterOptions() {
    const all = this.analytics({}, {});
    return {
      languages: all.languages,
      countries: all.countries,
      libraries: [...this.libraries.keys()].map(i => ({ value: i, label: this.libraries[i] })).sort((a, b) => this.collator.compare(a.label, b.label))
    };
  }

  // ----------------------------------------------------
  // Query
  // ----------------------------------------------------
  // params: { q, field, lang, script, library, subject, century, from, to, calendar, sort, offset, limit, facets }
  // workflow: { idx: { status, bookmarked } }, flt: "all" | "edited" | "bookmarked" | "approved" | "review" | "attention"
  search(params, workflow, flt) {
    const t0 = Date.now();
    const terms = parseQuery(params.q || "");
    const field = params.field || "all";
    const exactNumber = (params.q || "").trim();

    // Date range: Hijri years by default (compared with each record's Hijri year), or Gregorian.
    const useHijri = params.calendar !== "g";
    const from = parseInt(params.from, 10), to = parseInt(params.to, 10);
    const dFrom = isNaN(from) ? null : from, dTo = isNaN(to) ? null : to;
    const hasDate = dFrom !== null || dTo !== null;

    const want = {
      lang: params.lang || "",
      script: params.script || "",
      library: params.library !== undefined && params.library !== "" ? parseInt(params.library, 10) : null,
      subject: params.subject ? norm(params.subject) : "",
      century: params.century ? parseInt(params.century, 10) : null
    };

    const withFacets = !!params.facets;
    const facetCounts = { lang: new Map(), script: new Map(), library: new Map(), subject: new Map(), century: new Map() };
    const matched = [];

    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e) continue;
      const wf = workflow[i];

      // workflow chips
      if (flt === "edited" && !e.edited) continue;
      if (flt === "bookmarked" && !(wf && wf.bookmarked)) continue;
      if ((flt === "approved" || flt === "review" || flt === "attention") && !(wf && wf.status === flt)) continue;

      // text
      let score = 0;
      if (terms.length) {
        score = matchScore(e, terms, field, exactNumber);
        if (score === 0) continue;
      }

      // date range: the record's (earliest) copy date must fall inside the range
      if (hasDate) {
        const y = useHijri ? e.hStart : e.gStart;
        if (y === null) continue;
        if (dFrom !== null && y < dFrom) continue;
        if (dTo !== null && y > dTo) continue;
      }

      // filters (track which ones fail, for "disjunctive" facet counts)
      const failLang = want.lang && !e.langs.includes(want.lang);
      const failScript = want.script && !e.scripts.includes(want.script);
      const failLib = want.library !== null && e.lib !== want.library;
      const failSubj = want.subject && !e.subjects.includes(want.subject);
      const failCent = want.century !== null && e.century !== want.century;
      const fails = (failLang ? 1 : 0) + (failScript ? 1 : 0) + (failLib ? 1 : 0) + (failSubj ? 1 : 0) + (failCent ? 1 : 0);

      if (withFacets && fails <= 1) {
        // A record counts toward a facet if it passes every *other* filter,
        // so the counts show what you would get by switching that one filter.
        if (!fails || failLang) for (const l of e.langs) bump(facetCounts.lang, l);
        if (!fails || failScript) for (const s of e.scripts) bump(facetCounts.script, s);
        if (!fails || failLib) if (e.lib >= 0) bump(facetCounts.library, e.lib);
        if (!fails || failSubj) for (const s of e.subjects) bump(facetCounts.subject, s);
        if (!fails || failCent) if (e.century) bump(facetCounts.century, e.century);
      }
      if (fails) continue;

      matched.push({ e, score });
    }

    // sort
    const sort = params.sort || (terms.length ? "relevance" : "catalog");
    if (sort === "relevance") matched.sort((a, b) => b.score - a.score || a.e.idx - b.e.idx);
    else if (sort === "title") matched.sort((a, b) => this.collator.compare(a.e.sortTitle, b.e.sortTitle) || a.e.idx - b.e.idx);
    else if (sort === "date_asc") matched.sort((a, b) => nullLast(a.e.gStart, b.e.gStart, 1) || a.e.idx - b.e.idx);
    else if (sort === "date_desc") matched.sort((a, b) => nullLast(a.e.gStart, b.e.gStart, -1) || a.e.idx - b.e.idx);
    // "catalog": already in catalog order

    const offset = Math.max(0, params.offset | 0);
    const limit = Math.min(200, Math.max(1, params.limit | 0 || 50));
    const items = matched.slice(offset, offset + limit).map(({ e }) => {
      const wf = workflow[e.idx] || { bookmarked: false, status: "none" };
      return {
        idx: e.idx, id: e.id, title: e.title, author: e.author, subject: e.subject, copyNum: e.copyNum,
        edited: e.edited, bookmarked: !!wf.bookmarked, status: wf.status || "none",
        year: e.gStart, hijriYear: e.hStart, century: e.century
      };
    });

    const result = { total: matched.length, items, sort, tookMs: Date.now() - t0 };
    if (withFacets) result.facets = this.formatFacets(facetCounts);
    return result;
  }

  formatFacets(c) {
    const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    return {
      lang: top(c.lang, 20).map(([k, n]) => ({ value: k, label: LANGUAGE_NAMES[k] || k, count: n })),
      script: top(c.script, 20).map(([k, n]) => ({ value: k, label: k, count: n })),
      century: [...c.century.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => ({ value: k, label: `ق ${k} هـ`, count: n })),
      library: top(c.library, 300).map(([k, n]) => ({ value: k, label: this.libraries[k], count: n })),
      subject: top(c.subject, 60).map(([k, n]) => ({ value: k, label: k, count: n }))
    };
  }
}

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

// ----------------------------------------------------
// Data completeness: does the source record actually say something in each field?
// ----------------------------------------------------
// Checked on the raw trimmed text (no full normalization: this runs 10 times per record at startup)
const EMPTY_RE = /^(|بلا|[؟?]+|-+|مجهول.*|غير معروف|لا يوجد|الجامع\s*[:/]\s*مجهول)$/;
const COMPLETENESS_FIELDS = [
  ["author", "المؤلف", f => f("المؤلف")],
  ["date", "تاريخ النسخ", f => f("تاريخ النسخ")],
  ["subject", "الموضوع", f => f("الموضوع")],
  ["language", "اللغة", f => f("اللغة")],
  ["copyist", "الناسخ", f => f("الناسخ")],
  ["folios", "عدد الأوراق", f => f("عدد الاوراق")],
  ["script", "نوع الخط", f => f("نوع الخط")],
  ["place", "مكان النسخ", f => f("مكان النسخ")],
  ["incipit", "أول النسخة", f => f("أول النسخة")],
  ["description", "وصف النسخة", f => f("وصف النسخة")]
];
function completenessBits(get) {
  let bits = 0;
  COMPLETENESS_FIELDS.forEach(([, , pick], b) => {
    const v = pick(get).trim();
    if (!EMPTY_RE.test(v)) bits |= 1 << b;
  });
  return bits;
}

const COUNTRY_NAMES = {
  iq: "العراق", ir: "إيران", su: "السعودية", tu: "تركيا", ye: "اليمن", ua: "مصر", qa: "قطر", ku: "الكويت",
  ba: "البحرين", le: "لبنان", sy: "سوريا", ii: "الهند", pk: "باكستان", af: "أفغانستان", ja: "اليابان",
  gw: "ألمانيا", xxk: "بريطانيا", fr: "فرنسا", mr: "المغرب", ti: "تونس", ae: "الجزائر", aj: "أذربيجان",
  ru: "روسيا", uz: "أوزبكستان", none: "غير محدد"
};

function nullLast(a, b, dir) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
}

// Words and "quoted phrases", normalized. Single letters are ignored (too broad).
function parseQuery(q) {
  const terms = [];
  const text = String(q || "");
  for (const m of text.matchAll(/"([^"]+)"|«([^»]+)»|(\S+)/g)) {
    const t = norm(m[1] || m[2] || m[3]);
    if (t && (t.length > 1 || /\d/.test(t))) terms.push(t);
  }
  return terms;
}

// 0 = no match. Every term must be found; title and author matches rank higher.
function matchScore(e, terms, field, exactNumber) {
  if (field === "number") {
    return e.copyNum === exactNumber || e.id === exactNumber ? 10 : 0;
  }
  const fields =
    field === "title" ? [["nt", 5]] :
    field === "author" ? [["na", 5]] :
    field === "copyist" ? [["nc", 5]] :
    field === "subject" ? [["ns", 5]] :
    field === "text" ? [["nx", 5]] :
    field === "library" ? [["nl", 5]] :
    [["nt", 5], ["na", 4], ["ns", 3], ["nc", 2], ["nl", 1], ["nx", 1]];

  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const [key, weight] of fields) {
      if (e[key].includes(term)) { best = Math.max(best, weight); if (best === 5) break; }
    }
    if (!best) {
      // the box also accepts a copy number or record id
      if (field === "all" && terms.length === 1 && (e.copyNum === exactNumber || e.id === exactNumber)) return 20;
      return 0;
    }
    score += best;
  }
  // bonus: the title starts with the query, or contains it as one phrase
  const phrase = terms.join(" ");
  if (field === "all" || field === "title") {
    if (e.nt.startsWith(phrase)) score += 6;
    else if (terms.length > 1 && e.nt.includes(phrase)) score += 3;
  }
  if (field === "all" && (e.copyNum === exactNumber || e.id === exactNumber)) score += 20;
  return score;
}

module.exports = { SearchIndex, parseQuery, scriptsOf, datesFrom008, hijriCenturyOf, hijriStartYear, LANGUAGE_NAMES };
