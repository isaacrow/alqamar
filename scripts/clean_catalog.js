// Rebuild every record's MARC 21 / RDA fields from its source fields with marc_builder.js.
//
//   node scripts/clean_catalog.js            -> dromh_marc21_rda_catalog_v2.jsonl + clean_catalog_report.json
//   node scripts/clean_catalog.js --files    -> also marc21_files_v2/ (.mrc + .mrk, 5,000 records per file)
//
// The original dromh_marc21_rda_catalog.jsonl is only read, never changed. Records keep their order,
// so saved edits and workflow states (stored by position) still point at the same manuscripts.
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const marc = require("../server/marc_builder");

const ROOT = process.env.ALQAMAR_DATA_DIR ? path.resolve(process.env.ALQAMAR_DATA_DIR) : path.join(__dirname, "..", "data");
const SRC = path.join(ROOT, "dromh_marc21_rda_catalog.jsonl");
const OUT = path.join(ROOT, "dromh_marc21_rda_catalog_v2.jsonl");
const REPORT = path.join(ROOT, "clean_catalog_report.json");
const FILES_DIR = path.join(ROOT, "marc21_files_v2");
const PER_FILE = 5000;
const writeFiles = process.argv.includes("--files");

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`not found: ${SRC}`);
  const t0 = Date.now();
  const timestamp = (() => {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.0`;
  })();

  const tmp = OUT + ".tmp";
  const out = fs.createWriteStream(tmp, { encoding: "utf8" });
  if (writeFiles) fs.mkdirSync(FILES_DIR, { recursive: true });

  const report = {
    builtAt: new Date().toISOString(),
    records: 0,
    invalidRecords: 0,
    exportErrors: 0,
    problemSamples: [],
    dateTypes: {},            // 008/06
    languages: {},            // 008/35-37
    withAuthor: 0,
    copyistNotes: 0,          // "بخط المؤلف" etc. turned into a note instead of a fake person
    copyistNames: 0,
    unknownSubject: 0,
    tagsBefore: {},
    tagsAfter: {}
  };

  let mrcChunk = [], mrkChunk = [], part = 1;
  const flush = () => {
    if (!writeFiles || !mrcChunk.length) return;
    const name = `dromh_marc21_part_${String(part).padStart(2, "0")}`;
    fs.writeFileSync(path.join(FILES_DIR, name + ".mrc"), Buffer.concat(mrcChunk));
    fs.writeFileSync(path.join(FILES_DIR, name + ".mrk"), mrkChunk.join("\n"), "utf8");
    mrcChunk = []; mrkChunk = []; part++;
  };

  const rl = readline.createInterface({ input: fs.createReadStream(SRC, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    for (const m of rec.marc21_rda || []) bump(report.tagsBefore, m.tag);

    const fields = marc.buildMarcRecord(rec, { timestamp });
    const cleaned = { id: rec.id, viewUrl: rec.viewUrl, source_fields: rec.source_fields, marc21_rda: fields };
    report.records++;

    const problems = marc.validateMarc(fields);
    if (problems.length) {
      report.invalidRecords++;
      if (report.problemSamples.length < 20) report.problemSamples.push({ id: rec.id, problems });
    }
    for (const m of fields) bump(report.tagsAfter, m.tag);
    const f008 = fields.find(m => m.tag === "008").value;
    bump(report.dateTypes, f008[6]);
    bump(report.languages, f008.slice(35, 38));
    if (fields.some(m => m.tag === "100")) report.withAuthor++;
    if (fields.some(m => m.tag === "700")) report.copyistNames++;
    if (fields.some(m => m.tag === "500" && /^النسخة بخط/.test(m.subfields[0].value))) report.copyistNotes++;
    if (!fields.some(m => m.tag === "650")) report.unknownSubject++;

    if (!out.write(JSON.stringify(cleaned) + "\n")) await new Promise(r => out.once("drain", r));

    if (writeFiles) {
      try {
        const iso = marc.toIso2709(fields);
        marc.parseIso2709(iso); // prove it reads back
        mrcChunk.push(iso);
        mrkChunk.push(marc.toMrk(fields));
      } catch (e) {
        report.exportErrors++;
        if (report.problemSamples.length < 20) report.problemSamples.push({ id: rec.id, problems: [e.message] });
      }
      if (mrcChunk.length >= PER_FILE) flush();
    }
    if (report.records % 20000 === 0) console.log(`  ${report.records.toLocaleString()} records...`);
  }
  flush();
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  fs.renameSync(tmp, OUT);

  report.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");

  console.log(`Done: ${report.records.toLocaleString()} records in ${report.seconds}s`);
  console.log(`  invalid records: ${report.invalidRecords}, export errors: ${report.exportErrors}`);
  console.log(`  wrote ${path.basename(OUT)}${writeFiles ? ` and ${part - 1} .mrc/.mrk pairs in ${path.basename(FILES_DIR)}/` : ""}`);
  console.log(`  report: ${path.basename(REPORT)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
