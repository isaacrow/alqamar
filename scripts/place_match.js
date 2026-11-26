// How a library name is compared with a place found in OpenStreetMap or Wikidata (used by geocode_libraries.js,
// checked by tests/insights.test.js).
"use strict";

// Kinds of OpenStreetMap object a library can be: a library, school, university, mosque or shrine, museum, building.
const GOOD_CLASS = /^(amenity:(library|university|college|school|place_of_worship)|building:|historic:|tourism:(museum|attraction)|office:)/;
// Anything else (a road, a shop, a farm) counts only when its own name says it is a library.
const LIBRARY_WORD = /library|کتابخانه|كتابخانه|مكتبة|مكتبه|kütüphane|kutuphane|bibliothe/i;

// A hit counts only when it shares a real word with what was searched: words like "library", "mosque" or
// "university" alone don't count, so the wrong mosque or university next door is never taken.
const STOP = new Set(("library libraries central national public mosque masjid shrine holy university school madrasa madrasah institute " +
  "center centre museum college tomb mausoleum of the and al el ul de der des kutuphanesi kutuphane yazma eser imam ayatollah sayyid كليه " +
  "كتابخانه مكتبه مكتبات مسجد جامع جامعه مدرسه مركز ملي وطنيه عامه مركزيه مقدسه عتبه حرم مرقد روضه ضريح ايه ايت الله " +
  "سيد امام شيخ مخطوطات مصورات دار حضرت موزه و في اشرف منوره مشرفه معظم معظمه شريف شريفه محروسه مباركه مقدس ارامكاه مزار بقعه امامزاده").split(/\s+/));
function words(s, keepStop = false) {
  return String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/[ىی]/g, "ي").replace(/ک/g, "ك").replace(/گ/g, "ك").replace(/چ/g, "ج").replace(/پ/g, "ب").replace(/ژ/g, "ز").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/ـ/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .map(w => (w.length > 4 && w.startsWith("ال") ? w.slice(2) : w))
    .filter(w => w.length >= 3 && (keepStop || !STOP.has(w)));
}
const near = (a, b) => a.startsWith(b) || b.startsWith(a);
const HONORIFIC = new Set(["of", "the", "and", "al", "el", "و", "في", "اشرف", "منوره", "مشرفه", "معظم", "معظمه", "شريف", "شريفه", "محروسه", "مباركه", "مقدسه", "مقدس"]);
function sameName(query, hit, cityWords = new Set(), cityMain = cityWords) {
  let q = words(query).filter(w => !cityWords.has(w));
  // A library named after something its city is also called by ("شاه چراغ" for Shiraz): only the main city name is left out.
  if (!q.length) q = words(query).filter(w => !cityMain.has(w));
  const nameList = Object.values(hit.namedetails || {}).concat(hit.name || "");
  if (q.length) {
    // Judged on the place's best-fitting name. A library may differ in a few words; any other place (a school,
    // a shrine, a mosque) may share one word with the search only if it has at most one other telling word:
    // "دبستان امام موسی صدر" is not "مدرسة صدر".
    const libraryish = hit.category === "amenity" && hit.type === "library" || LIBRARY_WORD.test(nameList.join(" "));
    return nameList.some(n => {
      // matching uses all the place's words ("رضوي" names both Mashhad and its shrine); extras leave the city out
      const all = words(n), hv = all.filter(w => !cityWords.has(w));
      const matched = q.filter(a => all.some(b => near(a, b))).length;
      const extras = hv.filter(b => !q.some(a => near(a, b))).length;
      return matched >= 1 && (matched >= 2 || libraryish || extras <= 1);
    });
  }
  // Only generic words and the city ("Central Library University of Tehran"): one of the place's names must have
  // all those words and nothing else that tells it apart ("Isfahan University of Technology" is another place).
  const need = words(query, true).filter(w => STOP.has(w) && !HONORIFIC.has(w));
  return need.length >= 1 && nameList.some(n => {
    const all = words(n, true);
    return need.every(w => all.some(b => near(w, b))) && all.every(b => STOP.has(b) || cityWords.has(b));
  });
}
const persian = s => s.replace(/^مكتبة\s+/, "کتابخانه ").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/ة/g, "ه");

module.exports = { GOOD_CLASS, LIBRARY_WORD, STOP, words, sameName, persian };
