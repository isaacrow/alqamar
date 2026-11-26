// Al-Qamar gazetteer: places named in the catalog (holding libraries in المصدر, copy places in مكان النسخ),
// with coordinates for the map. Coordinates were checked against OpenStreetMap (Nominatim) — see
// scripts/verify_gazetteer.js, which re-checks them and reports any that drifted.
//
// Matching runs on normalized Arabic (أ/إ/آ -> ا, ة -> ه, ى -> ي, tashkeel removed), so aliases are
// written in that normalized form. Longer / more specific aliases are listed before shorter ones.
"use strict";

const marc = require("./marc_builder");
// hamza on the line (ء) is dropped too, so "كربلاء" and "كربلا", "سامراء" and "سامرا" match alike
const norm = s => marc.normalizeArabic(s).replace(/ء/g, "");

// country code -> Arabic name (MARC codes where they exist, as in search_index.js)
const COUNTRY_LABELS = {
  ir: "إيران", iq: "العراق", tu: "تركيا", su: "السعودية", ye: "اليمن", ua: "مصر", qa: "قطر", ku: "الكويت",
  ba: "البحرين", le: "لبنان", sy: "سوريا", ii: "الهند", pk: "باكستان", af: "أفغانستان", ja: "اليابان",
  gw: "ألمانيا", xxk: "بريطانيا", ie: "أيرلندا", xxu: "أمريكا", mr: "المغرب", ti: "تونس", ts: "الإمارات",
  aj: "أذربيجان", gs: "جورجيا", ai: "أرمينيا", uz: "أوزبكستان", tk: "تركمانستان", sp: "إسبانيا", ps: "فلسطين"
};

// [key, Arabic label, English (for geocoding), country, lat, lon, aliases...]
const RAW = [
  // ---------------- Iran ----------------
  ["tehran", "طهران", "Tehran", "ir", 35.6892, 51.3890, "طهران", "تهران", "مدرسه مروي"],
  ["qom", "قم", "Qom", "ir", 34.6401, 50.8764, "قم المقدسه", "دار الايمان", "دار الامان", "دار المؤمنين قم", "قم"],
  ["mashhad", "مشهد", "Mashhad", "ir", 36.2972, 59.6067, "المشهد الرضوي", "مشهد الرضا", "مشهد رضوي", "مشهد الامام الرضا", "الرضويه", "الروضه الرضويه", "امام الجن والانس", "الامام الثامن", "مشهد المقدس", "مشهد مقدس", "مشهد"],
  ["tus", "طوس", "Tus, Razavi Khorasan", "ir", 36.4847, 59.5147, "طوس", "توس"],
  ["isfahan", "أصفهان", "Isfahan", "ir", 32.6539, 51.6660, "اصفهان", "اصبهان", "سفاهان", "اصفاهان", "بيدآباد", "بيد اباد"],
  ["shiraz", "شيراز", "Shiraz", "ir", 29.6100, 52.5311, "شيراز", "شيرراز"],
  ["yazd", "يزد", "Yazd", "ir", 31.8974, 54.3569, "يزد"],
  ["tabriz", "تبريز", "Tabriz", "ir", 38.0800, 46.2919, "تبريز"],
  ["qazvin", "قزوين", "Qazvin", "ir", 36.2797, 50.0049, "قزوين"],
  ["kashan", "كاشان", "Kashan", "ir", 33.9850, 51.4100, "دار المؤمنين كاشان", "كاشان", "قاسان"],
  ["aran", "آران", "Aran va Bidgol", "ir", 34.0577, 51.4833, "اران"],
  ["hamadan", "همدان", "Hamadan", "ir", 34.7989, 48.5146, "همدان"],
  ["kermanshah", "كرمانشاه", "Kermanshah", "ir", 34.3142, 47.0650, "كرمانشاه", "كرمنشاه", "كرمان شاهان"],
  ["kerman", "كرمان", "Kerman", "ir", 30.2839, 57.0834, "ماهان كرمان", "الكرمن", "كرمان"],
  ["zanjan", "زنجان", "Zanjan", "ir", 36.6736, 48.4787, "زنجان"],
  ["khoy", "خوي", "Khoy", "ir", 38.5503, 44.9521, "خويي", "خوي"],
  ["maragheh", "مراغة", "Maragheh", "ir", 37.3917, 46.2397, "مراغه"],
  ["ardabil", "أردبيل", "Ardabil", "ir", 38.2498, 48.2933, "اردبيل"],
  ["rasht", "رشت", "Rasht", "ir", 37.2808, 49.5832, "رشت", "جيلان"],
  ["lahijan", "لاهيجان", "Lahijan", "ir", 37.2072, 50.0039, "لاهيجان"],
  ["borujerd", "بروجرد", "Borujerd", "ir", 33.8973, 48.7516, "بروجرد"],
  ["sabzevar", "سبزوار", "Sabzevar", "ir", 36.2126, 57.6819, "سبزوار"],
  ["birjand", "بيرجند", "Birjand", "ir", 32.8663, 59.2211, "بيرجند"],
  ["qaen", "قائن", "Qaen", "ir", 33.7265, 59.1844, "زهان", "قائن", "قاين", "القائن", "قايني", "قائني"],
  ["boshruyeh", "بشرويه", "Boshruyeh", "ir", 33.8683, 57.4281, "بشرويه"],
  ["ferdows", "فردوس (تون)", "Ferdows, South Khorasan", "ir", 34.0186, 58.1722, "فردوس", "مدينه تون", "بلده تون", "التون"],
  ["kakhk", "كاخك", "Kakhk", "ir", 34.1483, 58.6430, "كاخك"],
  ["khansar", "خوانسار", "Khansar", "ir", 33.2205, 50.3150, "خوانسار"],
  ["ardakan", "أردكان", "Ardakan, Yazd", "ir", 32.3100, 54.0175, "اردكان"],
  ["najafabad", "نجف آباد", "Najafabad", "ir", 32.6342, 51.3667, "نجف اباد", "نجف آباد"],
  ["arak", "أراك", "Arak, Iran", "ir", 34.0917, 49.6892, "اراك"],
  ["shahroud", "شاهرود", "Shahrud", "ir", 36.4182, 54.9763, "شاهرود"],
  ["karaj", "كرج", "Karaj", "ir", 35.8400, 50.9391, "كرج"],
  ["shushtar", "شوشتر", "Shushtar", "ir", 32.0455, 48.8566, "شوشتر", "ششتر"],
  ["hoveyzeh", "الحويزة", "Hoveyzeh", "ir", 31.4611, 48.0739, "الحويزه"],
  ["sanandaj", "سنندج", "Sanandaj", "ir", 35.3140, 46.9988, "سنندج"],
  ["gorgan", "أستراباد (گرگان)", "Gorgan", "ir", 36.8427, 54.4439, "استراباد", "استرباد", "استرآباد", "طبرستان"],
  ["semnan", "سمنان", "Semnan", "ir", 35.5729, 53.3971, "سمنان"],
  ["malayer", "ملاير", "Malayer", "ir", 34.2969, 48.8235, "ملاير", "دوله اباد"],
  ["nahavand", "نهاوند", "Nahavand", "ir", 34.1883, 48.3769, "نهاوند"],
  ["nain", "نائين", "Nain, Iran", "ir", 32.8600, 53.0875, "نايين", "نائين"],
  ["salmas", "سلماس", "Salmas", "ir", 38.1973, 44.7653, "سلماس"],
  ["ahar", "أهر", "Ahar", "ir", 38.4774, 47.0699, "الاهر", "اهر"],
  ["kashmar", "ترشيز (كاشمر)", "Kashmar", "ir", 35.2383, 58.4656, "ترشيز"],
  ["tabas", "طبس", "Tabas", "ir", 33.5959, 56.9244, "طبس"],
  ["amol", "آمل", "Amol", "ir", 36.4697, 52.3507, "امل", "مازندران"],
  ["damavand", "دماوند", "Damavand", "ir", 35.7178, 52.0697, "دماوند"],
  ["urmia", "أرومية", "Urmia", "ir", 37.5527, 45.0761, "الارومیه", "الاروميه", "اروميه"],
  ["golpayegan", "گلپايگان", "Golpayegan", "ir", 33.4537, 50.2884, "جرفادقان", "كلبايكان"],
  // ---------------- Iraq ----------------
  ["najaf", "النجف", "Najaf", "iq", 32.0000, 44.3350, "النجف", "نجفيه", "نجف", "الغري", "المشهد الغروي", "مشهد الغري", "الحضره الغرويه", "الصحن العلوي"],
  ["karbala", "كربلاء", "Karbala", "iq", 32.6160, 44.0249, "كربلا", "الحائر", "حائر الحسين", "بلده الحسين", "بلد الحسين", "كربلائيه"],
  ["kadhimiya", "الكاظمية", "Kadhimiya, Baghdad", "iq", 33.3797, 44.3375, "الكاظميه", "الكاظمين", "كاظمين", "مشهد الكاظم"],
  ["samarra", "سامراء", "Samarra", "iq", 34.1983, 43.8742, "سامرا", "سر من راي", "حائر العسكريين", "الناحيه المقدسه"],
  ["baghdad", "بغداد", "Baghdad", "iq", 33.3152, 44.3661, "بغداد", "المستنصريه", "المجمع العلمي العراقي", "المركز الوطني للمخطوطات", "حسين علي محفوظ"],
  ["basra", "البصرة", "Basra", "iq", 30.5085, 47.7804, "البصره"],
  ["mosul", "الموصل", "Mosul", "iq", 36.3350, 43.1189, "الموصل", "الحجيات"],
  ["hilla", "الحلة", "Hillah", "iq", 32.4721, 44.4217, "الحله"],
  ["kufa", "الكوفة", "Kufa", "iq", 32.0300, 44.4000, "الكوفه"],
  ["khanaqin", "خانقين", "Khanaqin", "iq", 34.3480, 45.3910, "خانقين"],
  ["sulaymaniyah", "السليمانية", "Sulaymaniyah", "iq", 35.5613, 45.4300, "السليمانيه", "قرداغ"],
  ["wasit", "واسط", "Wasit, Iraq", "iq", 32.1800, 46.3000, "واسط"],
  // ---------------- Turkey ----------------
  ["istanbul", "إسطنبول", "Istanbul", "tu", 41.0082, 28.9784, "اسطنبول", "استانبول", "القسطنطينيه", "فيض الله افندي", "راغب باشا", "علي اميري", "دار المثنوي", "يوسف اغا", "نوربانو", "جلبي عبد الله"],
  ["bursa", "بورصة", "Bursa", "tu", 40.1885, 29.0610, "بورسه", "بورصه"],
  ["ankara", "أنقرة", "Ankara", "tu", 39.9334, 32.8597, "انقره", "آنقره"],
  ["amasya", "أماسيا", "Amasya", "tu", 40.6499, 35.8353, "اماسيه"],
  ["trabzon", "طرابزون", "Trabzon", "tu", 41.0027, 39.7168, "طرابزون"],
  ["erzurum", "أرضروم", "Erzurum", "tu", 39.9043, 41.2679, "ارزن الروم", "ارضروم"],
  // ---------------- Arabia, Levant, Egypt, Maghreb ----------------
  ["mecca", "مكة", "Mecca", "su", 21.4225, 39.8262, "مكه", "المسجد الحرام", "بيت الله الحرام", "الكعبه"],
  ["medina", "المدينة المنورة", "Medina", "su", 24.4672, 39.6111, "المدينه المنوره"],
  ["riyadh", "الرياض", "Riyadh", "su", 24.7136, 46.6753, "جامعه الملك سعود", "الرياض"],
  ["taif", "الطائف", "Taif", "su", 21.2703, 40.4158, "عبد الله بن عباس", "الطائف"],
  ["qatif", "القطيف", "Qatif", "su", 26.5196, 50.0115, "القطيف"],
  ["sanaa", "صنعاء", "Sanaa", "ye", 15.3694, 44.1910, "صنعاء", "زيد بن علي", "طاووس اليماني"],
  ["damascus", "دمشق", "Damascus", "sy", 33.5138, 36.2765, "دمشق"],
  ["jerusalem", "القدس", "Jerusalem", "ps", 31.7780, 35.2354, "المسجد الاقصي", "القدس"],
  ["beirut", "بيروت", "Beirut", "le", 33.8938, 35.5018, "الفقيه العاملي", "بيروت"],
  ["cairo", "القاهرة", "Cairo", "ua", 30.0444, 31.2357, "القاهره", "الازهر", "مصر"],
  ["doha", "الدوحة", "Doha", "qa", 25.2854, 51.5310, "دار الكتب القطريه", "مكتبات قطر", "الدوحه"],
  ["kuwait", "الكويت", "Kuwait City", "ku", 29.3759, 47.9774, "الكويت"],
  ["manama", "المنامة", "Manama", "ba", 26.2285, 50.5860, "البحرين", "المنامه"],
  ["dubai", "دبي (الإمارات)", "Dubai", "ts", 25.2048, 55.2708, "الامارات", "دبي"],
  ["rabat", "الرباط (المغرب)", "Rabat", "mr", 34.0209, -6.8416, "المغرب", "الرباط"],
  ["tunis", "تونس", "Tunis", "ti", 36.8065, 10.1815, "تونس"],
  ["granada", "غرناطة", "Granada", "sp", 37.1773, -3.5986, "غرناطه"],
  // ---------------- South & Central Asia, Caucasus ----------------
  ["hyderabad", "حيدر آباد", "Hyderabad, Telangana", "ii", 17.3850, 78.4867, "حيدر اباد", "حيدر آباد", "كلكنده"],
  ["lucknow", "لكهنو", "Lucknow", "ii", 26.8467, 80.9462, "لكهنو", "لكنهو", "لكنو"],
  ["zangipur", "زنكي بور", "Zangipur, Uttar Pradesh", "ii", 25.7300, 83.4800, "زنكي بور", "زنكيبور"],
  ["delhi", "دهلي (شاه جهان آباد)", "Delhi", "ii", 28.6562, 77.2410, "شاه جهان اباد", "دهلي"],
  ["patna", "عظيم آباد (پتنا)", "Patna", "ii", 25.5941, 85.1376, "عظيم اباد"],
  ["surat", "سورت", "Surat", "ii", 21.1702, 72.8311, "السورت", "سورت"],
  ["ahmedabad", "أحمد آباد", "Ahmedabad", "ii", 23.0225, 72.5714, "احمد اباد"],
  ["ahmednagar", "أحمد نگر", "Ahmednagar", "ii", 19.0948, 74.7480, "احمد نگر", "احمد نكر"],
  ["vadodara", "بروده", "Vadodara", "ii", 22.3072, 73.1812, "بروده"],
  ["burhanpur", "برهانپور", "Burhanpur", "ii", 21.3090, 76.2300, "برهانپور", "برهانبور"],
  ["lahore", "لاهور", "Lahore", "pk", 31.5204, 74.3587, "لاهور"],
  ["multan", "ملتان", "Multan", "pk", 30.1575, 71.5249, "ملتان"],
  ["islamabad", "إسلام آباد", "Islamabad", "pk", 33.6844, 73.0479, "جامعه الكوثر", "باكستان", "اسلام اباد"],
  ["herat", "هرات", "Herat", "af", 34.3529, 62.2040, "هرات", "هراه"],
  ["kandahar", "قندهار", "Kandahar", "af", 31.6289, 65.7372, "قندهار"],
  ["fayzabad", "فيض آباد", "Fayzabad, Badakhshan", "af", 37.1166, 70.5800, "فيض اباد"],
  ["bukhara", "بخارى", "Bukhara", "uz", 39.7681, 64.4556, "بخارا", "بخاري"],
  ["samarkand", "سمرقند", "Samarkand", "uz", 39.6270, 66.9750, "سمرقند"],
  ["khwarazm", "خوارزم (خيوة)", "Khiva", "uz", 41.3783, 60.3639, "خوارزم", "جرجانيه"],
  ["tbilisi", "تفليس", "Tbilisi", "gs", 41.7151, 44.8271, "تفليس"],
  ["shamakhi", "شماخي", "Shamakhi", "aj", 40.6314, 48.6414, "شماخي"],
  ["baku", "باكو", "Baku", "aj", 40.4093, 49.8671, "بادكوبه", "بادكويه", "باكو"],
  ["yerevan", "إيروان", "Yerevan", "ai", 40.1872, 44.5152, "ايروان"],
  // ---------------- Europe, America, East Asia (holding libraries) ----------------
  ["london", "لندن", "London", "xxk", 51.5299, -0.1270, "لندن", "البريطانيه"],
  ["dublin", "دبلن", "Dublin", "ie", 53.3428, -6.2662, "دبلن", "تشستربيتي"],
  ["leipzig", "لايبزك", "Leipzig", "gw", 51.3397, 12.3731, "لايبزك", "لايبزيغ"],
  ["munich", "ميونخ", "Munich", "gw", 48.1351, 11.5820, "ميونخ"],
  ["princeton", "برنستون", "Princeton, New Jersey", "xxu", 40.3431, -74.6551, "برنستون"],
  ["tokyo", "طوكيو", "Tokyo", "ja", 35.7128, 139.7620, "طوكيو"]
];

// Country fallbacks: a library that names only a country ("مكتبات اليمن") gets the country's main city,
// flagged approximate so the map can say so.
const COUNTRY_FALLBACK = [
  [/اليمن/, "sanaa"], [/سوريا/, "damascus"], [/السعوديه/, "riyadh"], [/تركيا/, "istanbul"], [/الهند/, "delhi"],
  [/مصر/, "cairo"], [/العراق/, "baghdad"], [/ايران/, "tehran"], [/المانيا/, "leipzig"], [/لبنان/, "beirut"],
  [/خراسان/, "mashhad"]
];

const PLACES = RAW.map(([key, label, en, country, lat, lon, ...aliases]) => ({
  key, label, en, country, countryLabel: COUNTRY_LABELS[country] || country, lat, lon,
  aliases: aliases.map(a => norm(a))
}));
const BY_KEY = new Map(PLACES.map(p => [p.key, p]));

// Copy places entered by hand (places_to_fill.json): matched by their exact text, never inside other text.
// Each gets the country of the nearest known place within about 400 km.
const MANUAL_TEXT = new Map();
require("./manual_places").load().copyPlaces.forEach((m, i) => {
  let near = null, best = Infinity;
  for (const p of PLACES) {
    const d = Math.hypot(p.lat - m.lat, (p.lon - m.lon) * Math.cos(m.lat * Math.PI / 180));
    if (d < best) { best = d; near = p; }
  }
  const country = near && best < 3.6 ? near.country : "none";
  const place = { key: `manual-${i + 1}`, label: m.label, en: m.label, country, countryLabel: COUNTRY_LABELS[country] || "غير محدد", lat: m.lat, lon: m.lon, aliases: [], manual: true };
  PLACES.push(place);
  BY_KEY.set(place.key, place);
  MANUAL_TEXT.set(norm(m.text).replace(/ـ/g, " "), place.key);
});

// One regex over all aliases, longest first, bounded by non-letters so "قم" doesn't match inside "قمر".
const ALIAS_LIST = [];
for (const p of PLACES) for (const a of p.aliases) ALIAS_LIST.push([a, p.key]);
ALIAS_LIST.sort((a, b) => b[0].length - a[0].length);
const ALIAS_MAP = new Map(ALIAS_LIST);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALIAS_RE = new RegExp(`(?:^|[^\\p{L}])(?:ب|و|في\\s)?(${ALIAS_LIST.map(([a]) => escapeRe(a)).join("|")})(?=$|[^\\p{L}])`, "u");

// First place named in a free-text string (normalized), or null.
function findPlace(text) {
  const n = norm(text).replace(/ـ/g, " ");
  if (!n) return null;
  if (MANUAL_TEXT.has(n)) return BY_KEY.get(MANUAL_TEXT.get(n));
  const m = n.match(ALIAS_RE);
  if (m) return BY_KEY.get(ALIAS_MAP.get(m[1]));
  // "دار الخلافة" alone meant Tehran under the Qajars (but "دار الخلافة شاه جهان آباد" is Delhi, matched above)
  if (/دار الخلافه/.test(n)) return BY_KEY.get("tehran");
  return null;
}

// Place of a holding library: { place, approx }.
// Places whose point is only roughly known (not found in OpenStreetMap, or an ancient site)
const APPROX = new Set(["zangipur"]);

function libraryPlace(name) {
  const p = findPlace(name);
  if (p) return { place: p, approx: APPROX.has(p.key) };
  const n = norm(name);
  for (const [re, key] of COUNTRY_FALLBACK) if (re.test(n)) return { place: BY_KEY.get(key), approx: true };
  return { place: null, approx: false };
}

module.exports = { PLACES, BY_KEY, COUNTRY_LABELS, findPlace, libraryPlace };
