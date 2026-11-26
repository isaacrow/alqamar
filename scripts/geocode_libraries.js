// Finds where each holding library actually is, with OpenStreetMap's Nominatim geocoder, and writes
// server/library_places.json (committed, so the server never needs the internet for this).
//   node scripts/geocode_libraries.js            new libraries only (keeps what is already found)
//   node scripts/geocode_libraries.js --all      look every library up again
//   node scripts/geocode_libraries.js --retry    look again only for those still left at their city
// Every search is bounded to a box around the library's city (from the gazetteer), so a same-named place in
// another country can't be picked; a library with no reliable match stays at its city, marked approximate.
// Nominatim's usage policy: at most one request per second, with an identifying User-Agent.
// Map data © OpenStreetMap contributors (ODbL); each entry keeps its OSM object id.
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const gaz = require("../server/gazetteer");
const { placeKey, institutionName: searchName } = require("../server/library_places");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.ALQAMAR_DATA_DIR ? path.resolve(process.env.ALQAMAR_DATA_DIR) : path.join(ROOT, "data");
const CATALOG = ["dromh_marc21_rda_catalog_v2.jsonl", "dromh_marc21_rda_catalog.jsonl"].map(f => path.join(DATA_DIR, f)).find(fs.existsSync);
const OUT = path.join(ROOT, "server", "library_places.json");
const BOX_DEG = 0.35; // about 35-40 km either side of the city centre
const sleep = ms => new Promise(r => setTimeout(r, ms));

// English names OpenStreetMap knows the big institutions by (matched against the Arabic catalogue name).
const ENGLISH = [
  [/مجلس الشورى/, "Library of the Islamic Consultative Assembly"], [/جامعة طهران/, "Central Library University of Tehran"],
  [/ملك الوطنية/, "Malek National Library and Museum"], [/المستنصرية/, "Mustansiriyah University"],
  [/العتبة الرضوية/, "Astan Quds Razavi Central Library"], [/الفيضية/, "Feyziyeh School"],
  [/جامعة الملك سعود/, "King Saud University Library"], [/فيض الله/, "Millet Kütüphanesi"],
  [/المكتبة الوطنية - طهران/, "National Library of Iran"], [/راغب باشا/, "Ragıp Paşa Kütüphanesi"],
  [/جامعة اصفهان/, "University of Isfahan"], [/دار الكتب القطرية/, "Qatar National Library"],
  [/السيدة معصومة/, "Fatima Masumeh Shrine"], [/المجمع العلمي العراقي/, "Iraqi Academy of Sciences"],
  [/جامعة طوكيو/, "Institute for Advanced Studies on Asia University of Tokyo"], [/ابن مسكويه/, "Ibn Miskawayh Library"],
  [/شاه چراغ/, "Shah Cheragh"], [/علي أميري|علي اميري/, "Millet Kütüphanesi"], [/دار المثنوي/, "Darülmesnevi"],
  [/مسجد الكوفة/, "Great Mosque of Kufa"], [/جامعة بغداد/, "University of Baghdad"], [/الامام الحكيم/, "Imam al-Hakim Library"],
  [/جامعة لايبزك/, "Bibliotheca Albertina"], [/الازهرية|الأزهرية/, "Al-Azhar Mosque"], [/دار الحديث/, "Dar al-Hadith"],
  [/گلپايگاني/, "Golpaygani"], [/العتبة العباسية/, "Al-Abbas Holy Shrine"], [/تشستربيتي/, "Chester Beatty"],
  [/الجوادين|العتبة الكاظمية|الروضة الكاظمية/, "Al-Kadhimiya Mosque"], [/المرعشي|مرعشي/, "Marashi Najafi Library"], [/السليمانية/, "Süleymaniye Kütüphanesi"],
  [/العتبة الحسينية/, "Imam Husayn Shrine"], [/العتبة العلوية|الروضة الحيدرية/, "Imam Ali Holy Shrine"],
  [/كاشف الغطاء/, "Kashif al-Ghita"], [/يوسف أغا|يوسف اغا/, "Yusuf Ağa Kütüphanesi"], [/جامع الكبير|الجامع الكبير - صنعاء/, "Great Mosque of Sanaa"],
  [/مسجد گوهرشاد/, "Goharshad Mosque"], [/سپهسالار|مدرسة الشهيد مطهري/, "Sepahsalar Mosque"], [/المكتبة البريطانية/, "British Library"],
  [/بودليان|اكسفورد/, "Bodleian Library"], [/برلين/, "Staatsbibliothek zu Berlin"], [/المكتبة الوطنية الفرنسية|باريس الوطنية/, "Bibliothèque nationale de France"],
  [/جامعة الكويت/, "Kuwait University"], [/خدابخش/, "Khuda Bakhsh Oriental Library"], [/رضا رامبور/, "Raza Library"],
  [/سالار جنك/, "Salar Jung Museum"], [/المسجد النبوي/, "Prophet's Mosque"], [/الحرم المكي/, "Masjid al-Haram"],
  [/ملك فهد/, "King Fahd National Library"], [/الظاهرية/, "Az-Zahiriyya Library"], [/الأسد|الاسد الوطنية/, "Al-Assad National Library"]
];

// More names to try, the way OpenStreetMap writes them (Persian for Iran, other forms for Iraq and elsewhere).
const MORE = [
  [/مجلس الشورى/, ["کتابخانه مجلس", "Majlis Library"]], [/ملك الوطنية/, ["کتابخانه و موزه ملی ملک", "Malek Museum"]],
  [/الفيضية/, ["مدرسه فیضیه"]], [/المكتبة الوطنية - طهران/, ["کتابخانه ملی ایران"]], [/السيدة معصومة/, ["حرم حضرت معصومه"]],
  [/مدرسة مروي/, ["مدرسه مروی"]], [/ابن مسكويه/, ["کتابخانه ابن مسکویه"]], [/البروجردي/, ["مسجد اعظم قم"]],
  [/گلپايگاني/, ["کتابخانه آیت الله گلپایگانی"]], [/دار الحديث/, ["دارالحدیث"]], [/المرعشي|مرعشي/, ["کتابخانه آیت الله مرعشی نجفی"]],
  [/چهل ستون/, ["مدرسه چهل ستون"]], [/مركز إحياء التراث الإسلامي|مركز احياء التراث الاسلامي/, ["مرکز احیای میراث اسلامی"]],
  [/العتبة العباسية/, ["Al-Abbas Shrine", "حرم العباس", "مرقد العباس"]], [/العتبة الحسينية/, ["حرم الإمام الحسين", "Imam Hussein Shrine"]],
  [/الجوادين|العتبة الكاظمية|الروضة الكاظمية/, ["Kadhimiya Shrine", "الروضة الكاظمية", "العتبة الكاظمية"]], [/العتبة العلوية|الروضة الحيدرية/, ["حرم الإمام علي", "Imam Ali Shrine"]],
  [/جامعة طوكيو/, ["東京大学東洋文化研究所"]], [/السليمانية/, ["Süleymaniye Yazma Eser Kütüphanesi"]]
];

const { GOOD_CLASS, LIBRARY_WORD, words, sameName, persian } = require("./place_match");
// Every right match in testing was within 10 km of the city centre; the ones further out were other places.
const MAX_KM = 12;
// Matches checked by hand and found wrong or doubtful: these libraries stay at their city (approximate).
const REVIEWED_WRONG = {
  "way/457077690": "Imam Musa Sadr school, not the Sadr madrasa library",
  "way/452030735": "a girls' school named after Ayatollah Sadr, not the Sadr madrasa library",
  "node/8402124017": "a mosque in Hay al-Zirai; not shown to be this library"
};


function km(a, b, c, d) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const h = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function libraries() {
  const counts = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(CATALOG) });
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    const f = (r.marc21_rda || []).find(x => x.tag === "852");
    const a = f && (f.subfields.find(s => s.code === "a") || {}).value;
    if (a) counts.set(a.trim(), (counts.get(a.trim()) || 0) + 1);
  }
  return [...counts].sort((x, y) => y[1] - x[1]);
}

async function nominatim(q, p) {
  const box = [p.lon - BOX_DEG, p.lat + BOX_DEG, p.lon + BOX_DEG, p.lat - BOX_DEG].join(",");
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&bounded=1&namedetails=1&accept-language=ar,en"
    + `&viewbox=${box}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "User-Agent": "AlQamar-manuscript-catalog/1.0 (library locations, run by the catalogue owner)" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  await sleep(1100);
  return res.json();
}

// Second source: Wikidata (CC0). Items found by name, kept only with coordinates within MAX_KM of the city,
// a kind that fits (library, mosque, shrine, madrasa, university, school, museum, mausoleum) or "library" in
// their name, and the same name check as OpenStreetMap hits. Returned in Nominatim's shape for the same rules.
const WD_KINDS = new Set(["Q7075", "Q856584", "Q1438040", "Q32815", "Q697295", "Q132834", "Q3918", "Q3914", "Q33506", "Q162875",
  "Q2977", "Q1370598", "Q2221906", "Q15238777", "Q875538", "Q9826", "Q189004", "Q38723"]);
const WD_UA = { "User-Agent": "AlQamar-manuscript-catalog/1.0 (library locations, run by the catalogue owner)" };
// Wikidata turns away clients that ask too often ("You are making too many requests"); after that it is left alone
// for the rest of the run.
let wikidataRefused = false;
async function wdGet(url) {
  const res = await fetch(url, { headers: WD_UA });
  const text = await res.text();
  if (res.status === 429 || /^You are making too many requests/.test(text)) { wikidataRefused = true; throw new Error("Wikidata: too many requests, skipped for the rest of this run"); }
  if (!res.ok) throw new Error("Wikidata HTTP " + res.status);
  return JSON.parse(text);
}
async function wikidata(q) {
  if (wikidataRefused) return [];
  const lang = /[؀-ۿ]/.test(q) ? (/[پچژگکی]/.test(q) ? "fa" : "ar") : "en";
  const s = await wdGet(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&limit=8&type=item&language=${lang}&uselang=${lang}&search=${encodeURIComponent(q)}`);
  await sleep(1000);
  const ids = (s.search || []).map(x => x.id).slice(0, 8);
  if (!ids.length) return [];
  const g = await wdGet(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|labels|aliases&languages=ar|fa|en&ids=${ids.join("|")}`);
  await sleep(1000);
  const out = [];
  for (const id of ids) {
    const e = g.entities && g.entities[id];
    const c = e && e.claims && e.claims.P625 && e.claims.P625[0].mainsnak.datavalue;
    if (!c) continue;
    const names = {};
    for (const [l, v] of Object.entries(e.labels || {})) names["name:" + l] = v.value;
    for (const [l, list] of Object.entries(e.aliases || {})) list.forEach((v, i) => { names[`alt:${l}:${i}`] = v.value; });
    const kinds = ((e.claims.P31 || []).map(x => x.mainsnak.datavalue && x.mainsnak.datavalue.value.id)).filter(Boolean);
    const fits = kinds.some(k => WD_KINDS.has(k));
    out.push({
      lat: c.value.latitude, lon: c.value.longitude, osm_type: "wikidata", osm_id: id, namedetails: names,
      name: names["name:" + lang] || Object.values(names)[0] || id, display_name: names["name:" + lang] || Object.values(names)[0] || id,
      // in OpenStreetMap's terms: a library is a library; any other fitting kind counts like a school or shrine
      category: fits ? "amenity" : "wikidata",
      type: kinds.some(k => ["Q7075", "Q856584", "Q1438040"].includes(k)) ? "library" : fits ? "school" : kinds.join("+"),
      addresstype: "wikidata", importance: 0
    });
  }
  return out;
}

(async () => {
  if (!CATALOG) throw new Error("catalogue not found in " + DATA_DIR);
  const all = process.argv.includes("--all");
  const retry = process.argv.includes("--retry"); // look again only for the libraries still left at their city
  // --only=<part of a name>: just those libraries (nothing is written); --debug: every candidate and why it was kept or not
  const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7);
  const debug = process.argv.includes("--debug");
  const out = !all && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { institutions: {} };
  const libs = await libraries();
  let found = 0, approx = 0, skipped = 0;
  for (const [name] of libs) {
    if (only && !name.includes(only)) continue;
    const key = placeKey(name);
    if (!key) { console.log("no city      ", name); continue; }
    if (!only && out.institutions[key] && !(retry && out.institutions[key].approx)) { skipped++; continue; }
    const { place } = gaz.libraryPlace(name);
    if (!place) { console.log("no city      ", name); continue; }
    const own = searchName(name);
    const queries = [];
    const en = ENGLISH.find(([re]) => re.test(name));
    if (en) queries.push(en[1]);
    for (const [re, alts] of MORE) if (re.test(name)) queries.push(...alts);
    queries.push(own);
    if (place.country === "ir") queries.push(persian(own));
    const core = own.replace(/^(مكتبة|مكتبات)\s+/, "");
    if (core !== own && words(core).length) queries.push(core);
    const cityWords = new Set(words([place.label, place.en, ...place.aliases].join(" ")));
    const cityMain = new Set(words([place.label, place.en].join(" ")));
    // The same rules for both sources: near the city, a fitting kind of place, the same name.
    const judge = (hits, q) => {
      if (debug) for (const h of hits) {
        const d = km(place.lat, place.lon, +h.lat, +h.lon);
        const kind = GOOD_CLASS.test(`${h.category}:${h.type}`) || LIBRARY_WORD.test(Object.values(h.namedetails || {}).join(" "));
        console.log("   ", q, "=>", (h.namedetails && (h.namedetails.name || h.namedetails["name:ar"])) || h.name, `[${h.osm_type} ${h.category}:${h.type} ${h.addresstype}] ${d.toFixed(1)} km`,
          "kind:", kind, "name:", sameName(q, h, cityWords, cityMain));
      }
      return hits
        .map(h => ({ h, d: km(place.lat, place.lon, +h.lat, +h.lon), good: GOOD_CLASS.test(`${h.category}:${h.type}`) }))
        .filter(x => x.d <= MAX_KM && (x.good || LIBRARY_WORD.test(Object.values(x.h.namedetails || {}).join(" "))) && x.h.addresstype !== "city" && x.h.addresstype !== "state" && x.h.addresstype !== "country"
          && x.h.addresstype !== "suburb" && x.h.addresstype !== "neighbourhood" && x.h.addresstype !== "road" && sameName(q, x.h, cityWords, cityMain))
        .sort((a, b) => (b.good - a.good) || ((+b.h.importance || 0) - (+a.h.importance || 0)))
        .filter(x => !REVIEWED_WRONG[`${x.h.osm_type}/${x.h.osm_id}`]);
    };
    let best = null;
    for (const q of [...new Set(queries)].slice(0, 5)) {
      let hits = [];
      try { hits = await nominatim(q, place); } catch (e) { console.log("error", e.message); await sleep(5000); continue; }
      const kept = judge(hits, q);
      if (kept.length) { best = { ...kept[0], q }; break; }
    }
    // Not in OpenStreetMap under a name we can trust: try Wikidata with the library's own name (and its Persian
    // and English forms).
    if (!best) {
      const wq = [own, place.country === "ir" ? persian(own) : null, en ? en[1] : null].filter(Boolean);
      for (const q of [...new Set(wq)]) {
        let hits = [];
        try { hits = await wikidata(q); } catch (e) { console.log("error", e.message); if (wikidataRefused) break; await sleep(5000); continue; }
        const kept = judge(hits, q);
        if (kept.length) { best = { ...kept[0], q }; break; }
      }
    }
    if (best) {
      found++;
      out.institutions[key] = {
        label: searchName(name), city: place.key, lat: +(+best.h.lat).toFixed(5), lon: +(+best.h.lon).toFixed(5),
        osm: `${best.h.osm_type}/${best.h.osm_id}`, osmName: best.h.display_name.split(",")[0], kind: `${best.h.category}:${best.h.type}`,
        query: best.q, km: Math.round(best.d * 10) / 10
      };
      console.log("found  ", String(out.institutions[key].km).padStart(5), "km", name, "->", out.institutions[key].osmName);
    } else {
      approx++;
      out.institutions[key] = { label: searchName(name), city: place.key, approx: true };
      console.log("at city      ", name);
    }
    if (!only) fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  }
  if (only) return; // a look at a few libraries changes nothing
  // entries no library in the catalogue leads to any more (renamed or removed) are dropped
  const live = new Set(libs.map(([n]) => placeKey(n)).filter(Boolean));
  for (const k of Object.keys(out.institutions)) if (!live.has(k)) delete out.institutions[k];
  out.generated = new Date().toISOString().slice(0, 10);
  out.attribution = "Locations © OpenStreetMap contributors (ODbL), found with Nominatim; and Wikidata (CC0), where osm starts with wikidata/";
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  console.log(`\n${found} found, ${approx} left at their city, ${skipped} already known. Written to ${path.relative(ROOT, OUT)}.`);
})();
