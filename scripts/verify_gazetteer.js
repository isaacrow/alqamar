// Re-checks the gazetteer's coordinates against OpenStreetMap's Nominatim geocoder and lists any place whose
// stored point is more than 15 km from what OpenStreetMap returns.  Run: node scripts/verify_gazetteer.js
// Expect a few false alarms: for some names Nominatim returns the province centroid (استان یزد) or a same-named
// town abroad (Medina, Texas); those entries are right as they are.
// Nominatim's usage policy: at most one request per second, with an identifying User-Agent.
"use strict";

const { PLACES } = require("../server/gazetteer");

const sleep = ms => new Promise(r => setTimeout(r, ms));
function km(a, b, c, d) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(c - a), dLon = rad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

(async () => {
  const out = [];
  for (const p of PLACES) {
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(p.en);
    try {
      const res = await fetch(url, { headers: { "User-Agent": "AlQamar-manuscript-catalog/1.0 (gazetteer check)" } });
      const [hit] = await res.json();
      if (!hit) { out.push({ key: p.key, status: "not found" }); console.log(p.key, "NOT FOUND"); }
      else {
        const lat = +hit.lat, lon = +hit.lon, d = km(p.lat, p.lon, lat, lon);
        out.push({ key: p.key, lat: +lat.toFixed(4), lon: +lon.toFixed(4), km: Math.round(d), name: hit.display_name });
        console.log(p.key.padEnd(14), String(Math.round(d)).padStart(5), "km", d > 15 ? "<-- CHECK  " + hit.display_name : "");
      }
    } catch (e) {
      console.log(p.key, "ERROR", e.message);
    }
    await sleep(1100);
  }
  const bad = out.filter(o => o.status || o.km > 15);
  console.log(`\n${PLACES.length - bad.length}/${PLACES.length} within 15 km of OpenStreetMap.`);
  if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 1));
})();
