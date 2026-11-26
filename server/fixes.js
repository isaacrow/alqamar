"use strict";
// Bulk data fixes. Each fix proposes new values for a few source fields of one record; the MARC fields are
// brought in line by rebuilding only what those source fields produce, so hand edits elsewhere are kept.
// Anything the rule is not sure about is skipped and left for a person to review.
const marc = require("./marc_builder");

// Script names as catalogers write them. "نسخ" alone is also the plural of "copy", so a segment counts only
// when it is made of script names and nothing else ("نسخ متعددة" is skipped).
const SCRIPT_WORDS = ["شكسته نستعليق", "شكسته", "نستعليق", "نستعلیق", "تعليق", "نسخ", "ثلث", "رقعة", "رقعه", "كوفي", "مغربي", "ديواني", "محقق", "ريحاني", "بهار", "سنبلي", "غبار"];
const SCRIPT = `(?:${SCRIPT_WORDS.join("|")})`;
const SCRIPT_LIST = new RegExp(`^${SCRIPT}(?:\\s*(?:و|،|-|\\s)\\s*${SCRIPT})*$`);
const LABELLED = /نوع\s*الخط\s*[:：]\s*([^،,.؛:]+)/;

const clean = s => marc.cleanText(s || "");
const isEmpty = s => { const t = clean(s); return !t || t === "بلا" || /^[؟?\-ـ\s]+$/.test(t); };
const tidyScript = s => clean(s).replace(/\s*-\s*|\s*،\s*/g, " و").replace(/\s+و\s+/g, " و").replace(/\s{2,}/g, " ").trim();
// Glue the text before and after a removed piece back together without doubled or leading separators.
function joinRest(before, after) {
  const a = before.replace(/[\s،,.؛]+$/, "");
  const b = after.replace(/^[\s،,.؛]+/, "");
  return clean(a && b ? `${a}، ${b}` : a || b);
}

const FIXES = {
  scriptInDesc: {
    label: "نقل نوع الخط من الوصف إلى حقله",
    help: "حين يكون حقل «نوع الخط» فارغاً ويبدأ «وصف النسخة» باسم الخط (مثل «نسخ، ق13، …») أو يحوي «نوع الخط: …»، يُنقل اسم الخط إلى حقله ويُحذف من الوصف.",
    fields: ["نوع الخط", "وصف النسخة"],
    plan(sf) {
      if (!isEmpty(sf["نوع الخط"])) return { skip: "حقل نوع الخط غير فارغ" };
      const desc = clean(sf["وصف النسخة"]);
      if (isEmpty(desc)) return { skip: "الوصف فارغ" };
      // "نوع الخط: نسخ" anywhere in the text
      const lab = desc.match(LABELLED);
      if (lab) {
        const script = clean(lab[1]);
        if (!SCRIPT_LIST.test(script)) return { skip: "ما بعد «نوع الخط:» ليس اسم خط معروفاً" };
        return { set: { "نوع الخط": tidyScript(script), "وصف النسخة": joinRest(desc.slice(0, lab.index), desc.slice(lab.index + lab[0].length)) } };
      }
      // the description starts with the script: "نسخ، ق13، مشكّلة"
      const m = desc.match(/^([^،,.؛(]+?)\s*(?=[،,.؛]|$)/);
      if (m && SCRIPT_LIST.test(clean(m[1]))) {
        return { set: { "نوع الخط": tidyScript(m[1]), "وصف النسخة": joinRest("", desc.slice(m[0].length)) } };
      }
      return { skip: "اسم الخط داخل جملة؛ يحتاج مراجعة يدوية" };
    }
  }
};

const key = f => JSON.stringify([f.tag, f.indicators || "", f.subfields || f.value || ""]);
const STAMP = { timestamp: "00000000000000.0" };

// Apply new source-field values to a record. Returns { record, changes } or { skip }.
function applyFix(fixId, record) {
  const fix = FIXES[fixId];
  if (!fix) throw new Error("unknown fix " + fixId);
  const sf = record.source_fields || {};
  const p = fix.plan(sf);
  if (p.skip) return { skip: p.skip };
  const newSf = { ...sf, ...p.set };
  const changes = Object.keys(p.set)
    .filter(k => clean(sf[k]) !== clean(newSf[k]))
    .map(k => ({ field: k, before: clean(sf[k]), after: clean(newSf[k]) }));
  if (!changes.length) return { skip: "لا تغيير" };

  // MARC: fields the old source values produced go out, fields the new ones produce come in.
  const oldBuilt = marc.buildMarcRecord({ ...record, source_fields: sf }, STAMP);
  const newBuilt = marc.buildMarcRecord({ ...record, source_fields: newSf }, STAMP);
  const count = list => { const m = new Map(); for (const f of list) { const k = key(f); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const oldC = count(oldBuilt), newC = count(newBuilt);
  const removed = [], added = [];
  for (const f of oldBuilt) { const k = key(f); if ((newC.get(k) || 0) < oldC.get(k)) { removed.push(f); newC.set(k, (newC.get(k) || 0) + 1); } }
  const oldC2 = count(oldBuilt);
  for (const f of newBuilt) { const k = key(f); if ((oldC2.get(k) || 0) > 0) oldC2.set(k, oldC2.get(k) - 1); else added.push(f); }

  const fields = (record.marc21_rda || []).slice();
  const at = new Map(); // tag -> position of the first field taken out with that tag
  for (const f of removed) {
    const k = key(f);
    const i = fields.findIndex(x => key(x) === k);
    // The cataloger changed this MARC field by hand: do not guess, leave the record for review.
    if (i < 0) return { skip: "حقول MARC معدّلة يدوياً" };
    if (!at.has(f.tag)) at.set(f.tag, i);
    fields.splice(i, 1);
    for (const [t, pos] of at) if (pos > i) at.set(t, pos - 1);
  }
  for (const f of added) {
    let i = at.has(f.tag) ? at.get(f.tag) : fields.findIndex(x => x.tag > f.tag);
    if (i < 0) i = fields.length;
    fields.splice(i, 0, f);
    at.set(f.tag, i + 1);
    for (const [t, pos] of at) if (t !== f.tag && pos >= i) at.set(t, pos + 1);
  }
  return { record: { ...record, source_fields: newSf, marc21_rda: fields }, changes };
}

const fixList = () => Object.entries(FIXES).map(([id, f]) => ({ id, label: f.label, help: f.help, fields: f.fields }));

module.exports = { FIXES, applyFix, fixList };
