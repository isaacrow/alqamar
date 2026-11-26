# القمر (Al-Qamar)

A cataloging system for 107,149 Arabic, Persian and Ottoman manuscripts: MARC 21 / RDA records,
Arabic-aware search, review workflow, and author/subject authorities.

## Run

- Double-click `Start_Viewer.bat`, or run `npm start`. Opens at http://localhost:3456.
- `Start_Cloudflare_AlQamar.bat` also opens a public `trycloudflare.com` link. Everything is behind login,
  but anyone with the link sees the login page, so use strong passwords.
- First login with a starter account (`admin`, `cataloger`, `reviewer`) asks for a new password.

## Insights page (http://localhost:3456/insights)

Open it from the top bar ("التحليلات") or the dashboard. Everything on it is computed live from the catalog:

- **28 charts** in six groups: time (copy century, quarter-century timeline, author death century, years between the
  author's death and the copy, Hijri month, weekday, time of day), places (languages, holding country / city / library,
  copy places and countries, scripts), people and works (subjects, authors, most-copied works, copyists, who copied it),
  physical features and condition, three heatmaps (subject, language and country by century), and **data quality**.
- **Data quality** («جودة البيانات»): 13 automatic checks — no usable copy date, impossible years, copies dated more
  than 150 years before the author's death, missing author / subject / language / leaves, non-standard leaf counts,
  script written in the description instead of its field, copy places and libraries with no known place, and likely
  duplicate records (same title, copy number and library) — with a heatmap of issues per library. Each issue lists its
  records, and each record in a list shows its issues.
- **Bulk fixes** («إصلاحات جماعية», under data quality; rules live in `server/fixes.js`). The first rule moves the
  script name out of «وصف النسخة» into an empty «نوع الخط» when the description starts with it («نسخ، ق13، …») or
  says «نوع الخط: …». Only exact script names count, so «نسخ متعددة» ("several copies") is left alone; on the full
  catalog that is 6,383 records fixed and 8 left for review. The MARC fields those two source fields produce (546 $b
  and the 500 note) are rebuilt; a record whose MARC was edited by hand is skipped rather than guessed at.
  - Anyone with `catalog:write` can preview (counts, reasons for skips, before / after of the first records). Applying
    or undoing needs `catalog:approve` as well (reviewers and admins), and the preview count must still match.
  - The fix runs on the page's current filter (for example one library), takes a database backup first, saves each
    record as a new version in its history, and writes one line to the audit log for the batch.
  - «تراجع عن الدفعة» puts every record of a batch back; records edited again after the fix are left as they are.
- **CSV export** of any list (needs the `catalog:export` permission; written to the audit log). UTF-8 with BOM so
  Excel shows the Arabic; cells that a spreadsheet would run as a formula are neutralised.
- **Every bar, percentage, heatmap cell, map point, flow line and network node opens its manuscripts** in a side list;
  each one links to the record in the catalog (`/#record=N`). "تصفية الصفحة بهذا الاختيار" filters the whole page by
  it, and filters combine (they are kept in the URL, so a view can be shared).
- **Map** (OpenStreetMap via MapLibre GL, tilted 3D view; «مسطّح» for a flat one): every holding institution is a
  column at its own place, its height the number of manuscripts (paler: approximate place). Layers:
  - arcs from each copy place to the institution that keeps those manuscripts today (click: those manuscripts);
  - dashed links between two institutions that hold copies of the same works (works found in 2–40 libraries, at
    least 3 shared);
  - copy places, and city totals (off by default).
  - Click an institution: its column turns gold, its arcs and links light up and the rest dim; its popup opens.
    Click empty map to clear. Lines fade as you zoom into a city. Right-drag (or Ctrl-drag) turns and tilts the view.
  - Volumes of one library's catalogue («(ج1)» … «(ج5)») are one institution, in its city; its point opens all its
    manuscripts (filter `institution:`) and lists its catalogue volumes.
  - Institution points come from OpenStreetMap, then Wikidata: `node scripts/geocode_libraries.js` looks each one up
    (Nominatim, then Wikidata's search; about one request a second) and writes `server/library_places.json`, committed
    with each match's OSM or Wikidata id, so the server needs no internet for it. A match must lie within 12 km of the
    library's city, be a fitting kind of place (library, school, mosque or shrine, museum…, or named a library), and
    share a real word of the library's name in Arabic, Persian or English (generic words like "library", "mosque" and
    the city's main name don't count). Matches checked by hand and found wrong are listed in the script
    (`REVIEWED_WRONG`). Otherwise the library is shown 1.5–4 km from its city centre with a dashed edge (approximate).
  - **By hand:** `places_to_fill.json` (project folder) lists the libraries still approximate and the copy places the
    gazetteer doesn't know, with empty `lat` / `lon`, plus the libraries already placed (to correct). Filled numbers are
    used after a server restart: a library goes to that spot (shown as entered by hand; a changed placed one replaces
    the automatic point), a copy place becomes a place on the map matched by its exact text. Empty or impossible values
    are ignored; the startup log says how many entries were read.
  - `--retry` looks again for the approximate ones, `--all` for every library, `--only=<part of a name> --debug` shows
    each candidate for one library and why it was kept or not (writes nothing).
  - Cities and copy places come from `server/gazetteer.js`; `node scripts/verify_gazetteer.js` re-checks them.
  - Basemaps, none needing a key: OpenStreetMap; the same tiles darkened by a CSS filter for the dark theme; and the
    German OpenStreetMap community server (openstreetmap.de) as a stand-by. (CARTO's styles now require an API key
    and draw "API KEY REQUIRED" over the map, so they were dropped.) Picked by the theme; switch with the layers
    button. If a tile server refuses or is unreachable the map moves to the next one by itself. Tile servers need the site's origin as Referer, so the server sends
  `Referrer-Policy: strict-origin-when-cross-origin` (the origin only, never page paths).
- **Galaxy of knowledge** («مجرّة المعرفة»): the same links drawn as a night sky on a canvas — the largest subjects are
  glowing hubs, each author / work / city / language / century clusters around the subject it is most specifically
  tied to (weight × lift), and light flows along the strongest threads. Hover a star for its connections, click for its
  manuscripts, double-click to fly to it, search by name, or go full screen.
- **Relationship network**: values of up to six kinds (subjects, languages, centuries, authors, cities, scripts by
  default; also works, institutions, copyists, copy places…) as nodes, linked by how many manuscripts share them, links
  coloured by lift (observed ÷ expected), with a table of the strongest associations.
  - Click a node: the panel beside the graph lists everything it goes with, by kind (authors, works, institutions,
    copyists, cities, centuries, features…), with counts, its share and the lift, plus its most distinctive links.
    Any row opens the manuscripts the two share; «+» adds that value to the graph.
  - Double-click a node (or «توسيع الشبكة منها»): its closest links of each kind join the graph and every link among
    all nodes is recounted. Added nodes have a dashed edge; «إزالة العقد المضافة» removes them.
  - The layout is computed at once and fitted to the box; drag nodes, zoom with the wheel. Points are drawn as lit
    spheres.
  - «فضاء ثلاثي الأبعاد»: the same network in 3D (WebGL): drag to rotate, wheel to zoom; click a sphere for its
    panel (the camera flies to it), click it twice to expand from it.

The facts behind it (author death year, copyist type, leaves, copy month/day/time, features named in the description)
are read from the source fields by `server/insights.js`; coverage notes under each chart say how many manuscripts
actually record that field. MapLibre GL, d3 and 3d-force-graph are npm dependencies served by the app itself (`/vendor/...`), so the
page works on a LAN without internet; only the map tiles need it. The whole-catalog figures are computed once at
startup, so the page opens instantly.

## Working inside Moon (BIBFRAME)

Al-Qamar is also part of [Moon](https://github.com/isaacrow/moon3), the BIBFRAME 3.0.1 cataloguing system. With both
folders side by side (`MAN/MAN` and `MAN/moon3`), `npm run dev:all` in Moon starts the two together:

- Moon's top bar has **المخطوطات** (`/manuscripts/`: this catalogue and editor) and **التحليلات** (`/analytics/`: the
  Insights page). They are Al-Qamar's own pages, served at Moon's address through its `/alqamar` dev proxy, so one
  sign-in to Al-Qamar works in every Moon screen.
- **فتح في Moon** on any record opens it in Moon Studio as a new BIBFRAME record: Work / Instance (`bf:Manuscript`) /
  Item with the holding library and number, and a note saying which Al-Qamar record it came from. Inside Moon it
  opens in place; on its own it opens Moon in a new tab (`ALQAMAR_MOON_URL`, default `http://localhost:5173/moon/`).
  Manuscript links on the Insights page open in Moon's manuscripts screen.
- Moon's import dialog has **Copy from Al-Qamar**: search by title, author, copyist, subject, library or number.
- Nothing is written to Al-Qamar from Moon. Moon saves copies through its own review workflow.
- The pages use relative addresses so they work at `/` and under `/alqamar/`. They may be framed only by their own
  origin (`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`).

## Folders

| Folder | What's in it |
|---|---|
| `server/` | The app: `server.js` (HTTP + API), `auth.js` (users, sessions, audit log), `db.js` (SQLite), `marc_builder.js` (MARC 21 build / validate / .mrc / .mrk), `search_index.js` (Arabic search and filters), `insights.js` (charts, map and network data), `gazetteer.js` (places and coordinates) |
| `public/` | `ui.html` (the cataloging interface), `insights.html` (charts, map, network) and `logo.png` |
| `data/` | Not in git. The catalog (`dromh_marc21_rda_catalog_v2.jsonl` = cleaned, `..._catalog.jsonl` = original), `alqamar.db` (users, edits with full history, workflow, audit log), `backups/` (daily, last 14 kept), MARC exports and harvested source files |
| `scripts/` | `clean_catalog.js` rebuilds the cleaned catalog and bulk MARC files: `npm run clean-catalog` |
| `scripts/legacy/` | The one-off scripts used to first build the catalog. They write to an old `D:/MAN` path and some overwrite the UI or server, so **don't run them**; they're kept for reference |
| `tests/` | `npm test` |
| `bin/` | `cloudflared.exe` (not in git) |

## Data safety

- Every save of a record is kept as a new version (who, when). The history window in the app shows them and can
  restore any version, including the catalog original; a restore is itself a new version, so it can be undone.
- `alqamar.db` uses SQLite's WAL mode: a crash or power cut can't leave a half-written save.
- A backup copy of the database is written to `data/backups/` once a day (and on demand from the dashboard).
  To go back to a backup: stop the server, replace `data/alqamar.db` with the backup file, delete
  `alqamar.db-wal` and `alqamar.db-shm` if present, and start again.
- On its first start after the upgrade, the server imports the old `users.json`, `sessions.json`,
  `edited_records.json`, `workflow_state.json` and `audit_log.json`, and renames each to `*.imported.json`.

## Requirements

Node.js 20 or newer. After upgrading Node, run `npm rebuild better-sqlite3`.
