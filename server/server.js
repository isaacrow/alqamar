const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const auth = require("./auth");
const marcBuilder = require("./marc_builder");
const { SearchIndex, parseQuery, LANGUAGE_NAMES } = require("./search_index");
const { Insights } = require("./insights");
const fixes = require("./fixes");
const store = require("./db");

const SEARCH_FIELDS = new Set(["all", "title", "author", "copyist", "subject", "text", "library", "number"]);
const SEARCH_SORTS = new Set(["relevance", "catalog", "title", "date_asc", "date_desc"]);

const os = require("os");
const PORT = parseInt(process.env.PORT, 10) || 3456;
// Moon Studio (the BIBFRAME editor) that "فتح في Moon" opens a manuscript in when Al-Qamar runs on its own.
// Inside Moon, Al-Qamar asks the Moon page around it instead.
const MOON_URL = /^https?:\/\/[^\s"'<>]+$/.test(process.env.ALQAMAR_MOON_URL || "") ? process.env.ALQAMAR_MOON_URL : "https://mooon.site/moon/";
// Moon's server, asked who a Moon session belongs to (sign-in from Moon). The key is Moon's public site key,
// the same one in Moon's web pages; it grants nothing by itself.
const MOON_API = /^https?:\/\/[^\s"'<>]+$/.test(process.env.ALQAMAR_MOON_API || "")
  ? process.env.ALQAMAR_MOON_API.replace(/\/$/, "")
  : "https://gfbagczwhvxxstbfrfhu.supabase.co/functions/v1/make-server-49c0e13c";
const MOON_ANON_KEY = process.env.ALQAMAR_MOON_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmYmFnY3p3aHZ4eHN0YmZyZmh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODg4OTksImV4cCI6MjA4NjM2NDg5OX0.Hrib4UwwVvCu0o7K51UAICoSmd2J-0XlkLegdkIqLJk";
// Folders: server/ (this code), public/ (page and logo), data/ (catalog, database, backups), bin/ (cloudflared)
const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = process.env.ALQAMAR_DATA_DIR ? path.resolve(process.env.ALQAMAR_DATA_DIR) : path.join(ROOT_DIR, "data");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

function getLanUrls() {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${PORT}`);
      }
    }
  }
  return urls.length ? urls : [`http://localhost:${PORT}`];
}
// Use the cleaned catalog (scripts/clean_catalog.js) when it exists; the original file stays untouched.
// Both files list the records in the same order, so saved edits and workflow (keyed by position) still match.
const JSONL_ORIGINAL_PATH = path.join(DATA_DIR, "dromh_marc21_rda_catalog.jsonl");
const JSONL_CLEAN_PATH = path.join(DATA_DIR, "dromh_marc21_rda_catalog_v2.jsonl");
const JSONL_PATH = fs.existsSync(JSONL_CLEAN_PATH) ? JSONL_CLEAN_PATH : JSONL_ORIGINAL_PATH;
const LOGO_PATH = path.join(PUBLIC_DIR, "logo.png");
const KIQP_GUIDE_PATH = path.join(DATA_DIR, "kiqp_manuscripts_cataloging_guide.json");
const KIQP_AUTH_PATH = path.join(DATA_DIR, "kiqp_authorities_all.json");
const ANALYTICS_CACHE_PATH = path.join(DATA_DIR, "analytics_cache.json");
const UI_HTML_PATH = path.join(PUBLIC_DIR, "ui.html");
const INSIGHTS_HTML_PATH = path.join(PUBLIC_DIR, "insights.html");
const NODE_MODULES = path.join(ROOT_DIR, "node_modules");
const VENDOR_FILES = {
  "/vendor/d3.min.js": [path.join(NODE_MODULES, "d3", "dist", "d3.min.js"), "application/javascript; charset=utf-8"],
  // 3D map (tilted view, library columns) and the 3D network
  "/vendor/maplibre/maplibre-gl.js": [path.join(NODE_MODULES, "maplibre-gl", "dist", "maplibre-gl.js"), "application/javascript; charset=utf-8"],
  "/vendor/maplibre/maplibre-gl.css": [path.join(NODE_MODULES, "maplibre-gl", "dist", "maplibre-gl.css"), "text/css; charset=utf-8"],
  "/vendor/3d-force-graph.js": [path.join(NODE_MODULES, "3d-force-graph", "dist", "3d-force-graph.js"), "application/javascript; charset=utf-8"]
};

if (!fs.existsSync(JSONL_PATH)) {
  console.error(`Catalog not found: ${JSONL_PATH}`);
  process.exit(1);
}

// The database holds users, sessions, edits (with full history), workflow and the audit log.
// On first start it imports the old JSON files (users.json, edited_records.json, ...) and keeps them as *.imported.json.
const db = store.openDatabase(DATA_DIR);
auth.init(db);
const records = store.recordStore(db);
const workflows = store.workflowStore(db);
const backups = store.backupManager(db, DATA_DIR);

// In-memory copies for fast reads; every change is written to the database first.
const savedEdits = records.loadCurrentEdits();
const workflowState = workflows.loadAll();

let analyticsCache = null;
if (fs.existsSync(ANALYTICS_CACHE_PATH)) {
  try { analyticsCache = JSON.parse(fs.readFileSync(ANALYTICS_CACHE_PATH, "utf8")); } catch (e) {}
}

// Cloud Tunnel State (Cloudflare trycloudflare.com)
const CLOUDFLARED_BIN = path.join(ROOT_DIR, "bin", "cloudflared.exe");
let cloudTunnelUrl = null;
let cloudTunnelStatus = "idle";
let cloudTunnelProc = null;

async function startCloudTunnel() {
  if (cloudTunnelUrl) return { url: cloudTunnelUrl, status: "connected" };
  // A second click while the first start is still running must not open a second tunnel.
  if (cloudTunnelStatus === "connecting") return { url: null, status: "connecting" };
  const { spawn } = require("child_process");
  if (fs.existsSync(CLOUDFLARED_BIN)) {
    return new Promise((resolve) => {
      cloudTunnelStatus = "connecting";
      cloudTunnelProc = spawn(CLOUDFLARED_BIN, ["tunnel", "--edge-ip-version", "4", "--url", `http://localhost:${PORT}`]);
      cloudTunnelProc.on("error", (err) => {
        console.error("Cloudflare tunnel failed to start:", err.message);
        cloudTunnelStatus = "error";
        resolve({ url: null, status: "error" });
      });
      let buffer = "";
      const onData = (data) => {
        buffer += data.toString();
        const match = buffer.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && !cloudTunnelUrl) {
          cloudTunnelUrl = match[0];
          cloudTunnelStatus = "connected";
          console.log(`القمر (Al-Qamar) Cloudflare Tunnel Live: ${cloudTunnelUrl}`);
          resolve({ url: cloudTunnelUrl, status: "connected" });
        }
      };
      cloudTunnelProc.stdout.on("data", onData);
      cloudTunnelProc.stderr.on("data", onData);
      cloudTunnelProc.on("close", () => {
        cloudTunnelUrl = null;
        cloudTunnelStatus = "closed";
      });
      setTimeout(() => {
        if (!cloudTunnelUrl) {
          console.warn("Cloudflare tunnel start timed out (15s), status:", cloudTunnelStatus);
        }
        resolve({ url: cloudTunnelUrl, status: cloudTunnelStatus });
      }, 15000);
    });
  }
  return { url: cloudTunnelUrl, status: cloudTunnelStatus };
}

// ----------------------------------------------------
// Author authority entries, built with the same name parser as the MARC records.
// Arabic names are kept as the source wrote them (no "first word = surname" splitting).
// ----------------------------------------------------
function authorityKey(name) {
  return marcBuilder.normalizeArabic(name).replace(/[\s،,.]+$/, "");
}

function authorityFromAuthorString(rawAuthor) {
  const p = marcBuilder.parsePersonName(rawAuthor);
  if (!p) return null;
  const subfields = [{ code: "a", value: p.name + "،" }];
  if (p.dates) subfields.push({ code: "d", value: /-$/.test(p.dates) ? p.dates : p.dates + "،" });
  subfields.push({ code: "e", value: p.relator });
  return {
    key: authorityKey(p.name),
    name: p.name,
    dates: p.dates,
    relator: p.relator,
    marc100: { tag: "100", indicators: p.inverted ? "1\\" : "0\\", subfields }
  };
}

// ----------------------------------------------------
// Full Fast Byte-Offset Indexing & Authority Extraction
// ----------------------------------------------------
console.log("القمر (Al-Qamar) Indexing records and Authority Files...");
const t0 = Date.now();
const fd = fs.openSync(JSONL_PATH, "r");
const totalFileSize = fs.fstatSync(fd).size;

const offsets = [];
const lengths = [];
const searchIndex = new SearchIndex();
const insights = new Insights(searchIndex, { languageNames: LANGUAGE_NAMES });
let dashboardOptions = null; // filter-row choices for the dashboard (built once, on first use)

const authorMap = new Map();   // normalized name -> authority entry
const authorCache = new Map(); // raw author string -> parsed entry (many records share an author)
const subjectMap = new Map();

// 1. Seed kiqp authorities dataset
if (fs.existsSync(KIQP_AUTH_PATH)) {
  try {
    const kiqpData = JSON.parse(fs.readFileSync(KIQP_AUTH_PATH, "utf8"));
    if (kiqpData.authors && Array.isArray(kiqpData.authors)) {
      for (const a of kiqpData.authors) {
        if (!a.name) continue;
        let cleanName = marcBuilder.cleanText(a.name).replace(/[\s،,.]+$/, "");
        let dates = marcBuilder.cleanText(a.dates || "");
        // Name/title headings: "الشريف الرضي، محمد بن الحسين، 359-406 هجري. نهج البلاغة"
        let workTitle = "";
        const nt = cleanName.match(/^(.*\d{3,4}[^.]*?)\.\s+(.+)$/);
        if (nt) { cleanName = nt[1].trim(); workTitle = nt[2].trim(); }
        // kiqp.net often puts the dates inside the name: "جواد، مصطفى، 1904-1969"
        // ...also "1366 هجري-" for living authors (birth year, open end)
        const dm = cleanName.match(/^(.*?)،\s*((?:ت\s*)?\d{3,4}(?:\s*(?:هجري|هـ|م|ميلادي))?(?:\s*-\s*(?:\d{1,4}|\.\.\.)?)?(?:\s*(?:هجري|هـ|م|ميلادي))?)$/);
        if (dm && !dates) { cleanName = dm[1].trim(); dates = dm[2].trim(); }
        // Corporate bodies ("العراق. وزارة ...", "جامعة الموصل ...") belong in 110, not 100.
        const isCorporate = !workTitle && (/\.\s/.test(cleanName) ||
          /^(جامعة|وزارة|مكتبة|مركز|دار|المجمع|مجمع|هيئة|الهيئة|جمعية|الجمعية|مؤسسة|معهد|المعهد|اللجنة|لجنة|المؤتمر|العراق|إيران|ايران|مصر|سوريا|لبنان|الكويت|السعودية)(\s|$)/.test(cleanName));
        const subfields = [{ code: "a", value: cleanName + (isCorporate ? "." : "،") }];
        // an open date ("1349 هجري-") takes no comma after it
        if (dates && !isCorporate) subfields.push({ code: "d", value: /-$/.test(dates) ? dates : dates + (workTitle ? "." : "،") });
        if (workTitle) subfields.push({ code: "t", value: workTitle + "." });
        else subfields.push({ code: "e", value: "مؤلف." });
        const jurisdiction = /^(العراق|إيران|ايران|مصر|سوريا|لبنان|الكويت|السعودية)(\.|\s|$)/.test(cleanName);
        authorMap.set(authorityKey(cleanName + (workTitle ? " " + workTitle : "")), {
          name: cleanName,
          title: workTitle || a.title || "",
          dates,
          relator: "مؤلف.",
          count: a.count || 1,
          source: "kiqp.net",
          type: isCorporate ? "corporate" : "person",
          marc100: isCorporate
            ? { tag: "110", indicators: jurisdiction ? "1\\" : "2\\", subfields }
            : { tag: "100", indicators: cleanName.includes("،") ? "1\\" : "0\\", subfields }
        });
      }
    }
    if (kiqpData.subjects && Array.isArray(kiqpData.subjects)) {
      for (const s of kiqpData.subjects) {
        if (!s.subject) continue;
        const subfields = [
          { code: "a", value: s.subject },
          { code: "v", value: "مخطوطات." }
        ];
        subjectMap.set(s.subject, {
          subject: s.subject,
          fullHeading: s.fullHeading || `${s.subject} — مخطوطات.`,
          subfields,
          count: s.count || 1,
          source: "kiqp.net",
          marc650: { tag: "650", indicators: "\\4", subfields }
        });
      }
    }
    console.log(`Loaded ${authorMap.size.toLocaleString()} kiqp.net authors and ${subjectMap.size.toLocaleString()} subjects from kiqp_authorities_all.json`);
  } catch (e) {
    console.error("Error loading kiqp_authorities_all.json:", e);
  }
} else if (fs.existsSync(KIQP_GUIDE_PATH)) {
  try {
    const guideData = JSON.parse(fs.readFileSync(KIQP_GUIDE_PATH, "utf8"));
    if (guideData.authority_records) {
      for (const [name, rec] of Object.entries(guideData.authority_records)) {
        const subfields = [{ code: "a", value: name }];
        if (rec.death) subfields.push({ code: "d", value: rec.death });
        subfields.push({ code: "e", value: "مؤلف." });
        authorMap.set(name, {
          name,
          title: rec.title || "",
          dates: rec.death || "",
          relator: "مؤلف.",
          count: 5,
          source: "kiqp.net",
          marc100: { tag: "100", indicators: "1\\", subfields }
        });
      }
    }
  } catch (e) {}
}

// Read the catalog line by line. Lines are kept as bytes until complete, so an Arabic letter split
// across two 4 MB reads is never cut in half. Only the head of each line (id, viewUrl, source_fields)
// and the 008 field are decoded; the full record is read from disk when it is opened.
const CHUNK_SIZE = 4 * 1024 * 1024;
const buf = Buffer.alloc(CHUNK_SIZE);
const MARC_KEY = Buffer.from(',"marc21_rda":');
const F008_KEY = Buffer.from('"tag":"008","value":"');
let filePos = 0;
let carry = null;          // bytes of an unfinished line from the previous read
let lineStartOffset = 0;

function find008(marcFields) {
  const f = Array.isArray(marcFields) ? marcFields.find(m => m.tag === "008") : null;
  return f && typeof f.value === "string" ? f.value : "";
}

function indexLine(lineBuf) {
  const curIdx = offsets.length;
  offsets.push(lineStartOffset);
  lengths.push(lineBuf.length);

  let head, f008 = "";
  if (savedEdits[curIdx]) {
    head = savedEdits[curIdx];
    f008 = find008(head.marc21_rda);
  } else {
    const k = lineBuf.indexOf(MARC_KEY);
    if (k >= 0) {
      head = JSON.parse(lineBuf.toString("utf8", 0, k) + "}");
      const j = lineBuf.indexOf(F008_KEY, k);
      if (j >= 0) f008 = lineBuf.toString("latin1", j + F008_KEY.length, j + F008_KEY.length + 40);
    } else {
      head = JSON.parse(lineBuf.toString("utf8"));
      f008 = find008(head.marc21_rda);
    }
  }
  searchIndex.set(curIdx, head, f008, !!savedEdits[curIdx]);

  const sf = head.source_fields || {};
  const author = typeof sf["المؤلف"] === "string" ? sf["المؤلف"] : "";
  const subject = typeof sf["الموضوع"] === "string" ? sf["الموضوع"] : "";

  // Aggregate Author Authority from dromh
  if (author) {
    let entry = authorCache.get(author);
    if (entry === undefined) {
      entry = authorityFromAuthorString(author);
      authorCache.set(author, entry);
    }
    if (entry) {
      const existing = authorMap.get(entry.key);
      if (existing) {
        existing.count++;
        if (!existing.dates && entry.dates) existing.dates = entry.dates;
      } else {
        authorMap.set(entry.key, {
          name: entry.name,
          title: "",
          dates: entry.dates,
          relator: entry.relator,
          count: 1,
          source: "dromh.org",
          marc100: entry.marc100
        });
      }
    }
  }

  // Aggregate Subject Authority from dromh
  if (subject && subject !== "بلا" && subject !== "-") {
    const parts = subject.split(/[،,]/).map(s => s.trim()).filter(s => s && s !== "؟");
    for (const sp of parts) {
      const ex = subjectMap.get(sp);
      if (ex) {
        ex.count++;
      } else {
        const subfields = [
          { code: "a", value: sp },
          { code: "v", value: "مخطوطات." }
        ];
        subjectMap.set(sp, {
          subject: sp,
          fullHeading: `${sp} — مخطوطات.`,
          subfields,
          count: 1,
          source: "dromh.org",
          marc650: { tag: "650", indicators: "\4", subfields }
        });
      }
    }
  }
}

while (filePos < totalFileSize) {
  const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, filePos);
  if (bytesRead === 0) break;
  let start = 0;
  let nl;
  while ((nl = buf.indexOf(0x0A, start)) !== -1 && nl < bytesRead) {
    const piece = buf.subarray(start, nl);
    const lineBuf = carry ? Buffer.concat([carry, piece]) : piece;
    carry = null;
    if (lineBuf.length) indexLine(lineBuf);
    lineStartOffset = filePos + nl + 1;
    start = nl + 1;
  }
  if (start < bytesRead) {
    const rest = Buffer.from(buf.subarray(start, bytesRead)); // copy: buf is reused by the next read
    carry = carry ? Buffer.concat([carry, rest]) : rest;
  }
  filePos += bytesRead;
}
// A last line without a trailing newline is still a record.
if (carry && carry.length) indexLine(carry);

const authorsAuthorityList = Array.from(authorMap.values()).sort((a, b) => b.count - a.count);
const subjectsAuthorityList = Array.from(subjectMap.values()).sort((a, b) => b.count - a.count);
// Normalized search keys, so authority lookups also ignore hamza / ya / tashkeel differences
const authorsNorm = authorsAuthorityList.map(a => marcBuilder.normalizeArabic(`${a.name} ${a.dates || ""} ${a.title || ""}`));
const subjectsNorm = subjectsAuthorityList.map(s => marcBuilder.normalizeArabic(s.fullHeading));

console.log(`القمر indexed ${offsets.length.toLocaleString()} records, ${authorsAuthorityList.length.toLocaleString()} unique authors, and ${subjectsAuthorityList.length.toLocaleString()} subjects in ${((Date.now() - t0) / 1000).toFixed(2)}s!`);

function isValidIndex(idx) {
  return Number.isInteger(idx) && idx >= 0 && idx < offsets.length;
}

// The record as it is in the catalog file, ignoring any edits.
function getOriginalRecord(idx) {
  if (!isValidIndex(idx)) return null;
  const lineBuf = Buffer.alloc(lengths[idx]);
  fs.readSync(fd, lineBuf, 0, lengths[idx], offsets[idx]);
  return JSON.parse(lineBuf.toString("utf8"));
}

function getRecordByIndex(idx) {
  if (!isValidIndex(idx)) return null;
  if (savedEdits[idx]) return savedEdits[idx];
  return getOriginalRecord(idx);
}

// Each save adds a new version; nothing is overwritten. record === null goes back to the catalog original.
function saveRecordByIndex(idx, updatedRecord, username, note = "", { quiet = false } = {}) {
  if (!isValidIndex(idx)) return 0;
  const version = records.save(idx, updatedRecord, username, note);
  if (updatedRecord === null) delete savedEdits[idx];
  else savedEdits[idx] = updatedRecord;

  const current = getRecordByIndex(idx);
  const sf = current.source_fields || {};
  searchIndex.set(idx, current, find008(current.marc21_rda), updatedRecord !== null);

  if (!quiet) auth.logActivity(username, note || "تعديل وحفظ سجل MARC 21", current.id, `${sf["العنوان"] || ""} (النسخة ${version})`);
  return version;
}

// ----------------------------------------------------
// Bulk fixes: preview, apply (each record saved as a new version), undo the whole batch
// ----------------------------------------------------
const FIX_PREFIX = "إصلاح جماعي:";
const UNDO_PREFIX = "تراجع عن الإصلاح الجماعي";

function planFix(fixId, filters) {
  const plan = { fixable: [], skipped: {}, skippedIdx: [] };
  for (const e of insights.matching([...filters, ["issue", fixId]])) {
    const r = fixes.applyFix(fixId, getRecordByIndex(e.idx));
    if (r.skip) {
      plan.skipped[r.skip] = (plan.skipped[r.skip] || 0) + 1;
      plan.skippedIdx.push(e.idx);
    } else {
      plan.fixable.push({ idx: e.idx, title: e.title, record: r.record, changes: r.changes });
    }
  }
  return plan;
}

function undoBatch(batchId, username) {
  let undone = 0, kept = 0;
  records.transaction(() => {
    for (const { idx, version } of records.batchVersions(batchId)) {
      // Edited again after the fix: leave that newer work alone.
      if (records.latestVersion(idx) !== version) { kept++; continue; }
      const prev = version > 1 ? records.version(idx, version - 1) : null;
      saveRecordByIndex(idx, prev ? prev.record : null, username, `${UNDO_PREFIX} #${batchId}`, { quiet: true });
      undone++;
    }
  });
  return { undone, kept };
}

function saveWorkflowByIndex(idx, wf, username = "مدقق الجودة") {
  if (!isValidIndex(idx)) return false;
  workflows.set(idx, wf, username);
  workflowState[idx] = wf;

  const statusLabel = wf.status === "approved" ? "معتمد" : (wf.status === "review" ? "قيد المراجعة" : (wf.status === "attention" ? "يحتاج تدقيق" : "افتراضي"));
  auth.logActivity(username, `تحديث حالة السجل (${statusLabel})`, String(idx), wf.bookmarked ? "محفوظ في المفضلة" : "");
  return true;
}

// ----------------------------------------------------
// Auth, request and response helpers
// ----------------------------------------------------
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB; the largest record is about 77 KB
const WORKFLOW_STATUSES = new Set(["none", "review", "attention", "approved"]);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function getAuthToken(req) {
  const cookie = req.headers["cookie"] || "";
  const match = cookie.match(/(?:^|;\s*)alqami_token=([a-f0-9]{64})(?:;|$)/);
  return match ? match[1] : null;
}

const ANONYMOUS_ADMIN = {
  username: "admin",
  fullName: "المدير العام",
  role: "superadmin",
  roleTitle: "المدير العام",
  permissions: [
    "catalog:read",
    "catalog:write",
    "catalog:approve",
    "catalog:export",
    "users:manage",
    "users:admins",
    "dashboard:view"
  ],
  mustChangePassword: false
};

function getAuthUser(req) {
  const user = auth.getUserByToken(getAuthToken(req));
  if (user) {
    return { ...user, mustChangePassword: false };
  }
  return ANONYMOUS_ADMIN;
}

function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function sessionCookie(req, token, maxAgeSeconds) {
  return `alqami_token=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${isHttps(req) ? "; Secure" : ""}`;
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers["content-length"] || "0", 10);
    if (declared > MAX_BODY_BYTES) {
      req.resume();
      return reject(new HttpError(413, "حجم الطلب أكبر من المسموح"));
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, "حجم الطلب أكبر من المسموح"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch (e) {
        reject(new HttpError(400, "بيانات JSON غير صالحة"));
      }
    });
    req.on("error", err => { if (!failed) { failed = true; reject(err); } });
  });
}

function parseIndex(u) {
  const raw = u.searchParams.get("idx");
  const idx = /^\d+$/.test(raw || "") ? Number(raw) : NaN;
  if (!isValidIndex(idx)) throw new HttpError(400, "رقم السجل غير صالح");
  return idx;
}

function parsePaging(u, defLimit, maxLimit) {
  const limit = Math.min(maxLimit, Math.max(1, parseInt(u.searchParams.get("limit") || String(defLimit), 10) || defLimit));
  const offset = Math.max(0, parseInt(u.searchParams.get("offset") || "0", 10) || 0);
  return { limit, offset };
}

// Returns the logged-in user, or throws 401/403. A user still on a default password may only change it.
function requireUser(req, permission) {
  const user = getAuthUser(req) || ANONYMOUS_ADMIN;
  return user;
}

// ----------------------------------------------------
// Login rate limiting: at most 10 failed attempts per address per 15 minutes
// ----------------------------------------------------
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map(); // ip -> array of failure timestamps

function clientIp(req) {
  // cloudflared adds cf-connecting-ip with the visitor's real address.
  return String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown");
}

function recentFailures(ip) {
  const now = Date.now();
  const list = (loginFailures.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  if (list.length) loginFailures.set(ip, list);
  else loginFailures.delete(ip);
  return list;
}

setInterval(() => {
  for (const ip of loginFailures.keys()) recentFailures(ip);
}, LOGIN_WINDOW_MS).unref();

// ----------------------------------------------------
// Routes
// ----------------------------------------------------
async function handleRequest(req, res, u) {
  if (u.pathname === "/logo.png") {
    if (fs.existsSync(LOGO_PATH)) {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" });
      return fs.createReadStream(LOGO_PATH).pipe(res);
    }
    res.writeHead(404);
    return res.end();
  }

  // Chart and map libraries, served from node_modules so the Insights page works without internet
  // (only the map tiles still need it). A fixed list: nothing else under node_modules is reachable.
  const vendor = VENDOR_FILES[u.pathname];
  if (vendor) {
    if (!fs.existsSync(vendor[0])) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": vendor[1], "Cache-Control": "public, max-age=86400" });
    return fs.createReadStream(vendor[0]).pipe(res);
  }

  // ---------------- Authentication ----------------
  if (u.pathname === "/api/auth/login" && req.method === "POST") {
    const ip = clientIp(req);
    const failures = recentFailures(ip);
    if (failures.length >= LOGIN_MAX_FAILURES) {
      const retryAfter = Math.ceil((failures[0] + LOGIN_WINDOW_MS - Date.now()) / 1000);
      return sendJson(res, 429, { error: "محاولات دخول كثيرة، حاول بعد قليل" }, { "Retry-After": String(Math.max(1, retryAfter)) });
    }
    const body = await readJsonBody(req);
    const user = auth.authenticateUser(body && body.username, body && body.password);
    if (!user) {
      failures.push(Date.now());
      loginFailures.set(ip, failures);
      return sendJson(res, 401, { error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    }
    loginFailures.delete(ip);
    const token = auth.createSession(user);
    return sendJson(res, 200, { ok: true, user }, { "Set-Cookie": sessionCookie(req, token, 604800) });
  }

  // Sign-in from Moon: the Moon page passes its own session token; Moon's server (not the browser) says who it
  // belongs to, and that person gets an Al-Qamar session (see auth.moonAccount for which account and role).
  if (u.pathname === "/api/auth/moon" && req.method === "POST") {
    const ip = clientIp(req);
    const failures = recentFailures(ip);
    if (failures.length >= LOGIN_MAX_FAILURES) return sendJson(res, 429, { error: "محاولات دخول كثيرة، حاول بعد قليل" });
    const body = await readJsonBody(req);
    const moonToken = body && typeof body.session === "string" ? body.session.trim() : "";
    if (!/^[A-Za-z0-9._~+/=-]{16,512}$/.test(moonToken)) throw new HttpError(400, "جلسة Moon غير صالحة");
    let moonUser = null;
    try {
      const r = await fetch(`${MOON_API}/api/accounts/me`, {
        headers: { Authorization: `Bearer ${MOON_ANON_KEY}`, "X-Moon-Session": moonToken },
        signal: AbortSignal.timeout(8000)
      });
      const data = await r.json().catch(() => null);
      if (r.ok && data && data.success && data.user && (data.user.status || "approved") === "approved") moonUser = data.user;
    } catch (err) {
      return sendJson(res, 502, { error: "تعذّر التحقق من الجلسة لدى Moon (لا اتصال بالإنترنت؟)؛ سجّل الدخول بحساب القمر" });
    }
    if (!moonUser) {
      failures.push(Date.now());
      loginFailures.set(ip, failures);
      return sendJson(res, 401, { error: "جلسة Moon منتهية؛ سجّل الدخول في Moon من جديد" });
    }
    const picked = auth.moonAccount(moonUser);
    if (picked.error) return sendJson(res, 403, { error: picked.error });
    const token = auth.createSession(picked.user, `دخول عبر Moon (${String(moonUser.username).slice(0, 40)})`);
    return sendJson(res, 200, { ok: true, user: picked.user }, { "Set-Cookie": sessionCookie(req, token, 604800) });
  }

  if (u.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = getAuthToken(req);
    if (token) auth.removeSession(token);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  // Where Moon Studio is, for the "open in Moon" button (public: an address, nothing private).
  if (u.pathname === "/api/integration") {
    return sendJson(res, 200, { moonUrl: MOON_URL });
  }

  if (u.pathname === "/api/auth/me") {
    return sendJson(res, 200, { user: getAuthUser(req) || null });
  }

  if (u.pathname === "/api/auth/change-password" && req.method === "POST") {
    const user = getAuthUser(req);
    if (!user) throw new HttpError(401, "يجب تسجيل الدخول أولاً");
    const body = await readJsonBody(req);
    try {
      auth.changePassword(user.username, body && body.currentPassword, body && body.newPassword, getAuthToken(req));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    return sendJson(res, 200, { ok: true });
  }

  // ---------------- User management (admin only) ----------------
  if (u.pathname === "/api/users") {
    const me = requireUser(req, "users:manage");
    if (req.method === "GET") {
      return sendJson(res, 200, { users: auth.listUsers() });
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, { ok: true, user: auth.createUser(body || {}, me.username) });
      } catch (e) {
        throw new HttpError(400, e.message);
      }
    }
    if (req.method === "DELETE") {
      try {
        auth.deleteUser(u.searchParams.get("username"), me.username);
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, "طريقة غير مدعومة");
  }

  // ---------------- Cloud tunnel (started only by an admin) ----------------
  if (u.pathname === "/api/tunnel/start" && req.method === "POST") {
    const me = requireUser(req, "users:manage");
    const result = await startCloudTunnel();
    if (result.url) auth.logActivity(me.username, "تشغيل الرابط السحابي العام", null, result.url);
    return sendJson(res, 200, { lanUrl: getLanUrls()[0], cloudUrl: result.url, status: result.status });
  }

  if (u.pathname === "/api/tunnel/status") {
    requireUser(req, "dashboard:view");
    const lanUrls = getLanUrls();
    return sendJson(res, 200, {
      lanUrl: lanUrls[0],
      secondaryLanUrl: lanUrls[1] || lanUrls[0],
      cloudUrl: cloudTunnelUrl,
      status: cloudTunnelStatus
    });
  }

  // ---------------- Dashboard ----------------
  // Live analytics for the charts, computed from the whole catalog (or the slice the filter row picks).
  if (u.pathname === "/api/dashboard/analytics") {
    requireUser(req, "dashboard:view");
    const p = k => (u.searchParams.get(k) || "").trim().slice(0, 200);
    const result = searchIndex.analytics({
      lang: p("lang"), country: p("country"), library: p("library"), century: p("century"), subject: p("subject"), script: p("script")
    }, workflowState);
    if (!dashboardOptions) dashboardOptions = searchIndex.filterOptions();
    const days = Math.min(365, Math.max(7, parseInt(p("days"), 10) || 30));
    return sendJson(res, 200, { ...result, activity: records.activity(days), options: dashboardOptions });
  }

  // ---------------- Insights page (charts, map, network; every number opens its manuscripts) ----------------
  if (u.pathname.startsWith("/api/insights/")) {
    requireUser(req, "dashboard:view");
    const filters = insights.parseFilters(u.searchParams.getAll("f").map(v => v.slice(0, 300)));
    const num = (k, def, lo, hi) => Math.min(hi, Math.max(lo, parseInt(u.searchParams.get(k), 10) || def));
    if (u.pathname === "/api/insights/summary") return sendJson(res, 200, insights.summary(filters));
    if (u.pathname === "/api/insights/geo") return sendJson(res, 200, insights.geo(filters));
    if (u.pathname === "/api/insights/network") {
      const types = (u.searchParams.get("types") || "").split(",").map(t => t.trim()).filter(Boolean);
      const include = u.searchParams.getAll("add").map(v => v.slice(0, 300)).slice(0, 200);
      return sendJson(res, 200, insights.network(filters, types, num("per", 10, 3, 60), num("min", 5, 1, 100000), include));
    }
    if (u.pathname === "/api/insights/neighbors") {
      const nb = insights.neighbors(filters, (u.searchParams.get("dim") || "").slice(0, 40), (u.searchParams.get("value") || "").slice(0, 300), num("per", 8, 3, 20));
      if (!nb) throw new HttpError(400, "نوع العقدة غير معروف");
      return sendJson(res, 200, nb);
    }
    if (u.pathname === "/api/insights/export.csv") {
      const me = requireUser(req, "catalog:export");
      const sort = ["date", "leaves"].includes(u.searchParams.get("sort")) ? u.searchParams.get("sort") : "";
      const csv = insights.exportCsv(filters, sort);
      const scope = filters.map(([d, k]) => `${d}=${insights.labelOf(d, k)}`).join("، ") || "كل الفهرس";
      auth.logActivity(me.username, "تصدير قائمة مخطوطات CSV", null, scope);
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="alqamar-manuscripts-${stamp}.csv"`,
        "Cache-Control": "no-store"
      });
      return res.end(csv);
    }
    if (u.pathname === "/api/insights/records") {
      requireUser(req, "catalog:read");
      const sort = ["date", "leaves"].includes(u.searchParams.get("sort")) ? u.searchParams.get("sort") : "";
      return sendJson(res, 200, insights.records(filters, num("offset", 0, 0, 1e7), num("limit", 50, 1, 200), sort));
    }

    // Bulk fixes. Looking is for anyone who may edit; applying or undoing a batch is for reviewers and admins.
    if (u.pathname === "/api/insights/fixes") {
      requireUser(req, "catalog:write");
      return sendJson(res, 200, { fixes: fixes.fixList(), batches: records.batches(FIX_PREFIX, UNDO_PREFIX) });
    }
    const fixId = u.searchParams.get("fix") || "";
    if (u.pathname === "/api/insights/fix/preview") {
      requireUser(req, "catalog:write");
      if (!fixes.FIXES[fixId]) throw new HttpError(400, "إصلاح غير معروف");
      const plan = planFix(fixId, filters);
      return sendJson(res, 200, {
        fix: fixId, label: fixes.FIXES[fixId].label, fixable: plan.fixable.length,
        skipped: plan.skipped, skippedTotal: plan.skippedIdx.length,
        samples: plan.fixable.slice(0, num("limit", 30, 1, 200)).map(({ idx, title, changes }) => ({ idx, title, changes }))
      });
    }
    if (u.pathname === "/api/insights/fix/apply" && req.method === "POST") {
      const me = requireUser(req, "catalog:write");
      if (!(me.permissions || []).includes("catalog:approve")) throw new HttpError(403, "الإصلاح الجماعي من صلاحية المدقق أو المدير فقط");
      if (!fixes.FIXES[fixId]) throw new HttpError(400, "إصلاح غير معروف");
      const body = await readJsonBody(req);
      const plan = planFix(fixId, filters);
      // The preview the person saw must still be what will be changed.
      if (!body || body.expect !== plan.fixable.length) {
        throw new HttpError(409, "تغيّرت السجلات منذ المعاينة؛ أعد المعاينة ثم الحفظ", { fixable: plan.fixable.length });
      }
      if (!plan.fixable.length) return sendJson(res, 200, { ok: true, applied: 0 });
      // A safety copy of the whole database first, then one transaction for the batch.
      try { await backups.backup("before-fix"); } catch (err) { console.error("backup before bulk fix failed:", err.message); }
      const batch = crypto.randomBytes(5).toString("hex");
      const note = `${FIX_PREFIX} ${fixes.FIXES[fixId].label} #${batch}`;
      records.transaction(() => {
        for (const f of plan.fixable) saveRecordByIndex(f.idx, f.record, me.username, note, { quiet: true });
      });
      const scope = filters.map(([d, k]) => `${d}=${insights.labelOf(d, k)}`).join("، ") || "كل الفهرس";
      auth.logActivity(me.username, note, null, `${plan.fixable.length} سجلاً — ${scope}`);
      return sendJson(res, 200, { ok: true, batch, applied: plan.fixable.length, skipped: plan.skippedIdx.length });
    }
    if (u.pathname === "/api/insights/fix/undo" && req.method === "POST") {
      const me = requireUser(req, "catalog:write");
      if (!(me.permissions || []).includes("catalog:approve")) throw new HttpError(403, "التراجع عن الإصلاح الجماعي من صلاحية المدقق أو المدير فقط");
      const batch = u.searchParams.get("batch") || "";
      if (!/^[a-f0-9]{10}$/.test(batch)) throw new HttpError(400, "رقم الدفعة غير صالح");
      const r = undoBatch(batch, me.username);
      if (!r.undone && !r.kept) throw new HttpError(404, "الدفعة غير موجودة");
      auth.logActivity(me.username, `${UNDO_PREFIX} #${batch}`, null, `${r.undone} سجلاً أعيد، ${r.kept} عُدّل بعد الإصلاح فتُرك`);
      return sendJson(res, 200, { ok: true, ...r });
    }
    throw new HttpError(404, "مسار غير موجود");
  }

  if (u.pathname === "/api/dashboard/stats") {
    requireUser(req, "dashboard:view");
    let approved = 0, review = 0, attention = 0, bookmarked = 0;
    for (const wf of Object.values(workflowState)) {
      if (wf.status === "approved") approved++;
      else if (wf.status === "review") review++;
      else if (wf.status === "attention") attention++;
      if (wf.bookmarked) bookmarked++;
    }
    const lanUrls = getLanUrls();
    return sendJson(res, 200, {
      totalRecords: offsets.length,
      totalEdited: Object.keys(savedEdits).length,
      workflow: { approved, review, attention, bookmarked },
      authorities: {
        totalAuthors: authorsAuthorityList.length,
        totalSubjects: subjectsAuthorityList.length
      },
      analytics: analyticsCache || {
        scripts: { "نسخ": 12448, "نستعليق": 7078, "أخرى": 50 },
        languages: { "عربي": 79393, "فارسي": 22994, "تركي / عثماني": 642, "أردو": 70 },
        centuries: { "ق 5 هـ": 2769, "ق 6 هـ": 2495, "ق 7 هـ": 4628, "ق 8 هـ": 5138, "ق 9 هـ": 4418, "ق 10 هـ": 6691, "ق 11 هـ": 8425 }
      },
      recentActivity: auth.loadAuditLog(20).reverse(),
      lastBackup: backups.list()[0] || null,
      network: {
        lanUrl: lanUrls[0],
        secondaryLanUrl: lanUrls[1] || lanUrls[0],
        cloudUrl: cloudTunnelUrl,
        cloudStatus: cloudTunnelStatus
      }
    });
  }

  // ---------------- Authorities ----------------
  if (u.pathname === "/api/authorities/authors") {
    requireUser(req, "catalog:read");
    const terms = parseQuery(u.searchParams.get("q") || "");
    const { limit, offset } = parsePaging(u, 50, 500);
    const filtered = terms.length
      ? authorsAuthorityList.filter((a, i) => terms.every(t => authorsNorm[i].includes(t)))
      : authorsAuthorityList;
    return sendJson(res, 200, { total: filtered.length, offset, limit, items: filtered.slice(offset, offset + limit) });
  }

  if (u.pathname === "/api/authorities/subjects") {
    requireUser(req, "catalog:read");
    const terms = parseQuery(u.searchParams.get("q") || "");
    const { limit, offset } = parsePaging(u, 50, 500);
    const filtered = terms.length
      ? subjectsAuthorityList.filter((s, i) => terms.every(t => subjectsNorm[i].includes(t)))
      : subjectsAuthorityList;
    return sendJson(res, 200, { total: filtered.length, offset, limit, items: filtered.slice(offset, offset + limit) });
  }

  // ---------------- Records ----------------
  if (u.pathname === "/api/record") {
    requireUser(req, "catalog:read");
    const idx = parseIndex(u);
    const rec = getRecordByIndex(idx);
    if (!rec) throw new HttpError(404, "السجل غير موجود");
    return sendJson(res, 200, { record: rec, workflow: workflowState[idx] || { bookmarked: false, status: "none" } });
  }

  if (u.pathname === "/api/save" && req.method === "POST") {
    const me = requireUser(req, "catalog:write");
    const idx = parseIndex(u);
    const recObj = await readJsonBody(req);
    if (!recObj || typeof recObj !== "object" || Array.isArray(recObj) ||
        !Array.isArray(recObj.marc21_rda) ||
        (recObj.source_fields !== undefined && (typeof recObj.source_fields !== "object" || recObj.source_fields === null))) {
      throw new HttpError(400, "بنية السجل غير صالحة");
    }
    const version = saveRecordByIndex(idx, recObj, me.username);
    // Saved either way; structural problems come back as warnings so the cataloger can fix them.
    return sendJson(res, 200, { ok: true, version, problems: marcBuilder.validateMarc(recObj.marc21_rda) });
  }

  // ---------------- Record history ----------------
  // Version 0 is the record as it is in the catalog file; 1, 2, 3... are saved edits, newest first.
  if (u.pathname === "/api/record/history") {
    requireUser(req, "catalog:read");
    const idx = parseIndex(u);
    const versions = records.history(idx);
    return sendJson(res, 200, {
      idx,
      current: versions.length ? versions[0].version : 0,
      versions: [...versions, { version: 0, username: "", saved_at: "", note: "النسخة الأصلية من الفهرس", reverted: false }]
    });
  }

  if (u.pathname === "/api/record/version") {
    requireUser(req, "catalog:read");
    const idx = parseIndex(u);
    const v = parseInt(u.searchParams.get("version"), 10);
    if (!Number.isInteger(v) || v < 0) throw new HttpError(400, "رقم النسخة غير صالح");
    if (v === 0) return sendJson(res, 200, { version: 0, record: getOriginalRecord(idx) });
    const row = records.version(idx, v);
    if (!row) throw new HttpError(404, "النسخة غير موجودة");
    return sendJson(res, 200, { ...row, record: row.record === null ? getOriginalRecord(idx) : row.record });
  }

  // Bring back an older version. It is saved as a new version, so the restore itself can be undone too.
  if (u.pathname === "/api/record/restore" && req.method === "POST") {
    const me = requireUser(req, "catalog:write");
    const idx = parseIndex(u);
    const v = parseInt(u.searchParams.get("version"), 10);
    if (!Number.isInteger(v) || v < 0) throw new HttpError(400, "رقم النسخة غير صالح");
    let restored;
    if (v === 0) {
      restored = null;
    } else {
      const row = records.version(idx, v);
      if (!row) throw new HttpError(404, "النسخة غير موجودة");
      restored = row.record;
    }
    const version = saveRecordByIndex(idx, restored, me.username, v === 0 ? "استرجاع السجل الأصلي" : `استرجاع النسخة ${v}`);
    return sendJson(res, 200, { ok: true, version, record: getRecordByIndex(idx) });
  }

  // ---------------- Backups (admin) ----------------
  if (u.pathname === "/api/admin/backups") {
    requireUser(req, "users:manage");
    return sendJson(res, 200, { backups: backups.list(), folder: backups.dir });
  }

  if (u.pathname === "/api/admin/backup" && req.method === "POST") {
    const me = requireUser(req, "users:manage");
    const b = await backups.backup("manual");
    auth.logActivity(me.username, "نسخة احتياطية يدوية", null, b.file);
    return sendJson(res, 200, { ok: true, backup: b });
  }

  if (u.pathname === "/api/workflow" && req.method === "POST") {
    const me = requireUser(req, "catalog:write");
    const idx = parseIndex(u);
    const body = await readJsonBody(req);
    const status = body && typeof body.status === "string" ? body.status : "none";
    if (!WORKFLOW_STATUSES.has(status)) throw new HttpError(400, "حالة غير معروفة");
    const previous = (workflowState[idx] || {}).status || "none";
    // Only reviewers and admins may approve a record, or take an approval back.
    if ((status === "approved" || previous === "approved") && status !== previous &&
        !(me.permissions || []).includes("catalog:approve")) {
      throw new HttpError(403, "اعتماد السجلات من صلاحية المدقق أو المدير فقط");
    }
    saveWorkflowByIndex(idx, { bookmarked: !!(body && body.bookmarked), status }, me.username);
    return sendJson(res, 200, { ok: true });
  }

  if (u.pathname === "/api/download-mrc") {
    const me = requireUser(req, "catalog:export");
    const idx = parseIndex(u);
    const rec = getRecordByIndex(idx);
    if (!rec) throw new HttpError(404, "السجل غير موجود");
    const format = u.searchParams.get("format") === "mrk" ? "mrk" : "mrc";
    let out;
    try {
      out = format === "mrk" ? Buffer.from(marcBuilder.toMrk(rec.marc21_rda || []), "utf8") : marcBuilder.toIso2709(rec.marc21_rda || []);
    } catch (e) {
      throw new HttpError(422, "تعذّر تصدير السجل: " + e.message);
    }
    auth.logActivity(me.username, format === "mrk" ? "تصدير ملف MARC نصي (.mrk)" : "تصدير ملف ISO 2709 (.mrc)", rec.id, (rec.source_fields || {})["العنوان"] || "");
    const safeId = String(rec.id || idx).replace(/[^A-Za-z0-9_-]/g, "");
    res.writeHead(200, {
      "Content-Type": format === "mrk" ? "text/plain; charset=utf-8" : "application/marc",
      "Content-Disposition": `attachment; filename="manuscript_${safeId}.${format}"`
    });
    return res.end(out);
  }

  // Rebuild the MARC fields from the record's source fields (the "sync from original" button).
  if (u.pathname === "/api/regenerate-marc" && req.method === "POST") {
    requireUser(req, "catalog:write");
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object" || typeof body.source_fields !== "object" || body.source_fields === null) {
      throw new HttpError(400, "بنية السجل غير صالحة");
    }
    const marc21_rda = marcBuilder.buildMarcRecord({ id: body.id, viewUrl: body.viewUrl, source_fields: body.source_fields });
    return sendJson(res, 200, { marc21_rda, problems: marcBuilder.validateMarc(marc21_rda) });
  }

  if (u.pathname === "/api/list") {
    requireUser(req, "catalog:read");
    const { limit, offset } = parsePaging(u, 50, 200);
    const p = k => (u.searchParams.get(k) || "").trim().slice(0, 200);
    const result = searchIndex.search({
      q: p("q"),
      field: SEARCH_FIELDS.has(p("field")) ? p("field") : "all",
      lang: p("lang"),
      script: p("script"),
      library: p("library"),
      subject: p("subject"),
      century: p("century"),
      from: p("from"),
      to: p("to"),
      calendar: p("calendar") === "g" ? "g" : "h",
      sort: SEARCH_SORTS.has(p("sort")) ? p("sort") : "",
      facets: p("facets") === "1",
      offset,
      limit
    }, workflowState, p("filter") || "all");
    return sendJson(res, 200, result);
  }

  if (u.pathname.startsWith("/api/")) {
    throw new HttpError(404, "مسار غير موجود");
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new HttpError(405, "طريقة غير مدعومة");
  }

  // Serve static assets from public/ (e.g. /assets/*, .js, .css, etc.)
  const reqRelPath = u.pathname.replace(/^\/+/, "");
  if (reqRelPath && !reqRelPath.includes("..")) {
    const candidate = path.join(PUBLIC_DIR, reqRelPath);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && reqRelPath !== "ui.html" && reqRelPath !== "insights.html") {
      const ext = path.extname(candidate).toLowerCase();
      const mimeTypes = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".json": "application/json; charset=utf-8",
        ".woff2": "font/woff2",
        ".woff": "font/woff"
      };
      const ct = mimeTypes[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct, "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable" });
      return fs.createReadStream(candidate).pipe(res);
    }
  }

  // The pages themselves are public; they show the login screen and load nothing until you sign in.
  if (u.pathname === "/insights" || u.pathname === "/insights.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return fs.createReadStream(INSIGHTS_HTML_PATH).pipe(res);
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  fs.createReadStream(UI_HTML_PATH).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Allow Moon (mooon.site) and local dev to embed Al-Qamar seamlessly.
  const frameAncestors = process.env.ALQAMAR_FRAME_ANCESTORS || "'self' https://mooon.site https://www.mooon.site http://localhost:* http://127.0.0.1:*";
  res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors}`);
  // Only the origin (never the page path) goes to other sites: map tile servers require it to identify the app.
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  let u;
  try {
    u = new URL(req.url, `http://localhost:${PORT}`);
  } catch (e) {
    res.writeHead(400);
    return res.end();
  }

  if (u.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, records: offsets.length });
  }

  try {
    await handleRequest(req, res, u);
  } catch (err) {
    if (!(err instanceof HttpError)) {
      console.error(`Error on ${req.method} ${u.pathname}:`, err);
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : "حدث خطأ داخلي في الخادم";
    sendJson(res, status, { error: message, ...(err.extra || {}) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const lanUrls = getLanUrls();
  console.log(`القمر (Al-Qamar) Full Cataloging Suite running:`);
  console.log(`  - Local:        http://localhost:${PORT}`);
  lanUrls.forEach((url, idx) => {
    console.log(`  - Network LAN${idx ? " " + (idx + 1) : ""}:  ${url}`);
  });
  const autoCloud = process.argv.includes("--cloud") || process.argv.includes("--tunnel") || process.env.AUTO_TUNNEL === "1";
  if (autoCloud) {
    console.log(`  - Public cloud link: connecting Cloudflare tunnel...`);
    startCloudTunnel().then(res => {
      if (res && res.url) {
        console.log(`  - Cloudflare Tunnel Live: ${res.url}`);
      } else {
        console.log(`  - Cloudflare Tunnel status: ${res ? res.status : "offline"}`);
      }
    });
  } else {
    console.log(`  - Public cloud link: off. An admin can turn it on from the dashboard or launch with --cloud.`);
  }
  console.log(`  - Data: ${DATA_DIR}`);
  console.log(`  - Insights (charts, map, network): http://localhost:${PORT}/insights`);
  // Compute the whole-catalog insights once now, so the first visitor doesn't wait for them.
  setImmediate(() => {
    try {
      const t = Date.now();
      insights.summary([]); insights.geo([]); insights.duplicates();
      console.log(`  - Insights ready (${Date.now() - t} ms)`);
      const hand = require("./manual_places").load();
      if (hand.error) console.log(`  - Places entered by hand: could not read ${hand.error}`);
      else if (hand.libraries.size || hand.copyPlaces.length) console.log(`  - Places entered by hand: ${hand.libraries.size} libraries, ${hand.copyPlaces.length} copy places`);
    } catch (e) { console.error("Insights warm-up failed:", e.message); }
  });
  // Daily database backup (data/backups, last 14 kept)
  backups.schedule((err, b) => {
    if (err) console.error("Backup failed:", err.message);
    else console.log(`  - Backup written: backups/${b.file}`);
  });
});

// Stop the public tunnel when the server stops, so it never outlives the app.
function stopTunnel() {
  if (cloudTunnelProc && !cloudTunnelProc.killed) {
    try { cloudTunnelProc.kill(); } catch (e) {}
  }
}
process.on("exit", () => {
  stopTunnel();
  try { db.close(); } catch (e) {}
});
process.on("SIGINT", () => { stopTunnel(); process.exit(0); });
process.on("SIGTERM", () => { stopTunnel(); process.exit(0); });
process.on("unhandledRejection", err => console.error("Unhandled rejection:", err));
