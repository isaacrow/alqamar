// Coordinates entered by hand in places_to_fill.json (in the project folder): libraries whose building wasn't found
// automatically, corrections to ones that were, and copy places the gazetteer doesn't know. Read once at start;
// restart the server after editing the file. Entries without valid numbers are ignored.
"use strict";

const fs = require("fs");
const path = require("path");

const FILE = process.env.ALQAMAR_PLACES_FILE || path.join(__dirname, "..", "places_to_fill.json");

// A number (or a number written as text) in range, else null.
function num(v, lo, hi) {
  const x = typeof v === "string" ? parseFloat(v.replace(",", ".")) : v;
  return Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x * 1e6) / 1e6 : null;
}
const point = e => {
  const lat = num(e && e.lat, -90, 90), lon = num(e && e.lon, -180, 180);
  // 0,0 is the default of some tools, never a library here
  return lat !== null && lon !== null && !(lat === 0 && lon === 0) ? { lat, lon } : null;
};

let cache = null;
function load() {
  if (cache) return cache;
  cache = { libraries: new Map(), copyPlaces: [], file: FILE, error: "" };
  let data;
  try { data = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {
    if (e.code !== "ENOENT") cache.error = `${path.basename(FILE)}: ${e.message}`;
    return cache;
  }
  for (const list of [data.libraries_to_fill, data.libraries_placed]) {
    for (const e of Array.isArray(list) ? list : []) {
      const p = point(e);
      if (p && typeof e.id === "string") cache.libraries.set(e.id, { ...p, note: String(e.note || "").slice(0, 300) });
    }
  }
  for (const e of Array.isArray(data.copy_places) ? data.copy_places : []) {
    const p = point(e);
    if (p && typeof e.text === "string" && e.text.trim()) {
      cache.copyPlaces.push({ text: e.text.trim(), label: String(e.place_name || "").trim().slice(0, 80) || e.text.trim().slice(0, 80), ...p });
    }
  }
  return cache;
}

module.exports = { load, FILE };
