// Where each holding library is: its own point from OpenStreetMap when one was found (library_places.json,
// made by scripts/geocode_libraries.js), otherwise its city. Libraries left at their city are spread on a small
// ring around it so each one can still be seen and clicked; those points are marked approximate.
"use strict";

const fs = require("fs");
const path = require("path");
const gaz = require("./gazetteer");
const manual = require("./manual_places");

const FILE = path.join(__dirname, "library_places.json");

// The words that name the institution: without "manuscripts / microfilms of", volume numbers ("(ج1)" … "(ج5)"),
// or the city and country after a dash or "في".
function institutionName(name) {
  return String(name || "")
    .replace(/\(ج\s*\d+\)/g, " ")
    // "microfilm / paper copies (kept) in …" first, then a bare "manuscripts / copies / documents of"
    .replace(/^(فهرس\s+)?((ال)?مصورات(\s+(ال)?(مايكروفيلم|ميكروفيلم|ورقي|للنسخ|محفوظ)\S*){1,4}\s+في\s+|(مخطوطات|مصورات|وثائق)\s+)/, "")
    .split(/\s+[-–]\s*|\s*[-–]\s+|-(?=[^\s])/)[0]
    .replace(/\s+في\s+\S+(\s+\S+)?$/, "")
    .replace(/\(ع\)|\(عليه السلام\)/g, "")
    .replace(/\s+/g, " ").trim();
}
// So the volumes of one library, written slightly differently, are one place.
function institutionKey(name) {
  return institutionName(name).replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/\s+/g, " ").trim();
}

let table = null;
function load() {
  if (table) return table;
  try { table = JSON.parse(fs.readFileSync(FILE, "utf8")).institutions || {}; } catch (e) { table = {}; }
  return table;
}

function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

// { lat, lon, exact, osm, key } for a library name, or null when not even its city is known.
// The table key: the institution in its city ("the central library" of Baghdad and of Mosul are two places).
function placeKey(name) {
  const { place } = gaz.libraryPlace(name);
  return place ? `${institutionKey(name)}|${place.key}` : null;
}

function libraryPoint(name) {
  const { place, approx } = gaz.libraryPlace(name);
  if (!place) return null;
  const key = `${institutionKey(name)}|${place.key}`;
  const t = load()[key];
  // Entered by hand (places_to_fill.json): used when it is new, or differs from the automatic point (a correction).
  const m = manual.load().libraries.get(key);
  const auto = t && !t.approx && Number.isFinite(t.lat);
  // A point entered on the city's own centre (within ~30 m) says "in this city", not where the building is.
  const cityCentre = m && Math.hypot(m.lat - place.lat, (m.lon - place.lon) * Math.cos(place.lat * Math.PI / 180)) * 111 < 0.03;
  if (m && !cityCentre && !(auto && Math.abs(m.lat - t.lat) < 1e-4 && Math.abs(m.lon - t.lon) < 1e-4)) {
    return { key, lat: m.lat, lon: m.lon, exact: true, osm: "manual" };
  }
  if (auto) return { key, lat: t.lat, lon: t.lon, exact: true, osm: t.osm || "" };
  // A steady spot 1.5 to 4 km from the city centre, the same every time for the same library.
  const h = hash(key), ang = (h % 360) * Math.PI / 180, r = (1.5 + (h >>> 9) % 25 / 10) / 111;
  return { key, lat: place.lat + r * Math.sin(ang), lon: place.lon + r * Math.cos(ang) / Math.cos(place.lat * Math.PI / 180), exact: false, cityApprox: !!approx, osm: cityCentre ? "manual-city" : "" };
}

module.exports = { institutionName, institutionKey, placeKey, libraryPoint, load };
