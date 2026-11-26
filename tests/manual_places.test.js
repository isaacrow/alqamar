// Coordinates entered by hand in places_to_fill.json reach the map: a library's own spot, a correction, a new
// copy place. Uses a file of its own (each test file runs in its own process, so the env is set before loading).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "alqamar-places-")), "places_to_fill.json");
fs.writeFileSync(file, JSON.stringify({
  libraries_to_fill: [
    { id: "مكتبه مجهوله الموقع|yazd", name: "x", lat: "31.889", lon: 54.364 },
    { id: "مكتبه اخري|yazd", lat: null, lon: null },
    { id: "مكتبه خاطئه|yazd", lat: 95, lon: 54 },
    { id: "مكتبه صفر|yazd", lat: 0, lon: 0 },
    { id: "مكتبه المركز|yazd", lat: 31.8974, lon: 54.3569 }
  ],
  libraries_placed: [],
  copy_places: [
    { text: "قرية مباركة لنگر", place_name: "لنگر", lat: 33.5, lon: 52.1 },
    { text: "زشك", lat: null, lon: null }
  ]
}));
process.env.ALQAMAR_PLACES_FILE = file;
const lp = require("../server/library_places");
const gaz = require("../server/gazetteer");
const manual = require("../server/manual_places");

test("hand-entered coordinates: used when valid, ignored when empty or impossible", () => {
  const m = manual.load();
  assert.equal(m.libraries.size, 2, "only the valid library entries");
  const centre = lp.libraryPoint("مكتبة المركز - يزد");
  assert.deepEqual([centre.exact, centre.osm], [false, "manual-city"], "the city's own centre point is not the building");
  assert.equal(m.copyPlaces.length, 1);
  const p = lp.libraryPoint("مكتبة مجهولة الموقع - يزد");
  assert.deepEqual([p.lat, p.lon, p.exact, p.osm], [31.889, 54.364, true, "manual"]);
  assert.equal(lp.libraryPoint("مكتبة أخرى - يزد").exact, false, "left empty: still approximate");
  assert.equal(lp.libraryPoint("مكتبة خاطئة - يزد").exact, false, "latitude 95 is ignored");
  assert.equal(lp.libraryPoint("مكتبة صفر - يزد").exact, false, "0, 0 is ignored");
});

test("hand-entered copy places: matched by their exact text, with a country", () => {
  const p = gaz.findPlace("قرية مباركة لنگر");
  assert.ok(p && p.manual);
  assert.deepEqual([p.label, p.lat, p.lon, p.country], ["لنگر", 33.5, 52.1, "ir"]);
  assert.equal(gaz.findPlace("زشك"), null, "left empty: still unknown");
  assert.equal(gaz.findPlace("دار العلم شيراز").key, "shiraz", "the gazetteer still works as before");
});
