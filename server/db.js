// Al-Qamar database: one SQLite file (data/alqamar.db) for everything that changes while the app runs:
// users, sessions, record edits (every version kept), workflow states and the audit log.
// The 107k-record catalog itself stays a read-only JSON Lines file.
//
// SQLite in WAL mode commits each write atomically, so a crash or power cut can't leave a half-written save,
// and nothing is ever rewritten in place the way the old JSON files were.
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SCHEMA_VERSION = 1;
const BACKUP_KEEP = 14; // daily backups kept

function openDatabase(dataDir) {
  const file = path.join(dataDir, "alqamar.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL,
      role_title TEXT NOT NULL,
      permissions TEXT NOT NULL,            -- JSON array
      hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      password_changed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(username);

    -- Every save of a record is a new row; the newest row is the current edit.
    -- record IS NULL means "reverted to the original catalog record".
    CREATE TABLE IF NOT EXISTS record_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idx INTEGER NOT NULL,
      version INTEGER NOT NULL,
      record TEXT,
      username TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      UNIQUE (idx, version)
    );

    CREATE TABLE IF NOT EXISTS workflow (
      idx INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'none',
      bookmarked INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      action TEXT NOT NULL,
      record_id TEXT,
      details TEXT,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_ts ON audit_log(ts);
  `);
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING").run(String(SCHEMA_VERSION));

  migrateJsonFiles(db, dataDir);
  return db;
}

// ----------------------------------------------------
// One-time import of the JSON files the app used before (users, sessions, edits, workflow, audit log).
// Each imported file is renamed to *.imported.json and kept as a backup.
// ----------------------------------------------------
function migrateJsonFiles(db, dataDir) {
  const done = k => db.prepare("SELECT 1 FROM meta WHERE key = ?").get("imported:" + k);
  const mark = k => db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run("imported:" + k, new Date().toISOString());
  const readJson = f => {
    const p = path.join(dataDir, f);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };
  const retire = f => {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) fs.renameSync(p, p.replace(/\.json$/, ".imported.json"));
  };
  const now = new Date().toISOString();

  const steps = [
    ["users.json", data => {
      const ins = db.prepare(`INSERT OR IGNORE INTO users
        (username, full_name, role, role_title, permissions, hash, salt, must_change_password, created_at, password_changed_at)
        VALUES (@username, @full_name, @role, @role_title, @permissions, @hash, @salt, @must, @created_at, @changed)`);
      for (const u of Object.values(data || {})) {
        ins.run({
          username: u.username, full_name: u.fullName || u.username, role: u.role || "cataloger",
          role_title: u.roleTitle || "", permissions: JSON.stringify(u.permissions || []),
          hash: u.hash, salt: u.salt,
          // undefined = file from before forced password changes: auth.js checks the shipped passwords at startup
          must: u.mustChangePassword === undefined ? -1 : (u.mustChangePassword ? 1 : 0),
          created_at: u.createdAt || now, changed: u.passwordChangedAt || null
        });
      }
    }],
    ["sessions.json", data => {
      const ins = db.prepare("INSERT OR IGNORE INTO sessions(token, username, expires_at, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE username = ?)");
      for (const [token, s] of Object.entries(data || {})) {
        if (/^[a-f0-9]{64}$/.test(token) && s.expiresAt > Date.now()) ins.run(token, s.username, s.expiresAt, s.createdAt || now, s.username);
      }
    }],
    ["edited_records.json", data => {
      const ins = db.prepare("INSERT OR IGNORE INTO record_versions(idx, version, record, username, saved_at, note) VALUES (?, 1, ?, 'import', ?, 'استيراد من الملف القديم')");
      for (const [idx, rec] of Object.entries(data || {})) ins.run(+idx, JSON.stringify(rec), now);
    }],
    ["workflow_state.json", data => {
      const ins = db.prepare("INSERT OR REPLACE INTO workflow(idx, status, bookmarked, updated_by, updated_at) VALUES (?, ?, ?, 'import', ?)");
      for (const [idx, wf] of Object.entries(data || {})) ins.run(+idx, wf.status || "none", wf.bookmarked ? 1 : 0, now);
    }],
    ["audit_log.json", data => {
      const ins = db.prepare("INSERT INTO audit_log(username, action, record_id, details, ts) VALUES (?, ?, ?, ?, ?)");
      for (const e of data || []) ins.run(e.username || null, e.action || "", e.recordId == null ? null : String(e.recordId), e.details || "", e.timestamp || now);
    }]
  ];

  for (const [file, importer] of steps) {
    if (done(file)) continue;
    const data = readJson(file);
    if (data === null) { mark(file); continue; }
    db.transaction(() => { importer(data); mark(file); })();
    retire(file);
    console.log(`Imported ${file} into alqamar.db (original kept as ${file.replace(/\.json$/, ".imported.json")})`);
  }
}

// ----------------------------------------------------
// Record edits and history
// ----------------------------------------------------
function recordStore(db) {
  const latestAll = db.prepare(`
    SELECT rv.idx, rv.record FROM record_versions rv
    JOIN (SELECT idx, MAX(version) v FROM record_versions GROUP BY idx) m ON m.idx = rv.idx AND m.v = rv.version`);
  const maxVersion = db.prepare("SELECT COALESCE(MAX(version), 0) v FROM record_versions WHERE idx = ?");
  const insert = db.prepare("INSERT INTO record_versions(idx, version, record, username, saved_at, note) VALUES (?, ?, ?, ?, ?, ?)");
  const history = db.prepare("SELECT version, username, saved_at, note, record IS NULL AS reverted, LENGTH(record) AS size FROM record_versions WHERE idx = ? ORDER BY version DESC");
  const one = db.prepare("SELECT version, record, username, saved_at, note FROM record_versions WHERE idx = ? AND version = ?");

  return {
    // { idx: record } for every record whose newest version is an edit
    loadCurrentEdits() {
      const out = {};
      for (const row of latestAll.iterate()) if (row.record !== null) out[row.idx] = JSON.parse(row.record);
      return out;
    },
    // Append a version. record === null reverts to the original catalog record.
    save(idx, record, username, note = "") {
      return db.transaction(() => {
        const version = maxVersion.get(idx).v + 1;
        insert.run(idx, version, record === null ? null : JSON.stringify(record), username, new Date().toISOString(), note);
        return version;
      })();
    },
    history(idx) {
      return history.all(idx).map(r => ({ ...r, reverted: !!r.reverted }));
    },
    // Bulk fixes tag every version they write with "#<batch id>" at the end of the note.
    batchVersions(batchId) {
      return db.prepare("SELECT idx, version FROM record_versions WHERE note LIKE ? ESCAPE '\\'").all(`%#${batchId.replace(/[%_\\]/g, "\\$&")}`);
    },
    latestVersion(idx) {
      return maxVersion.get(idx).v;
    },
    batches(prefix, undoPrefix, limit = 20) {
      const rows = db.prepare(`SELECT note, username, MIN(saved_at) at, COUNT(*) n FROM record_versions
                               WHERE note LIKE ? GROUP BY note ORDER BY at DESC LIMIT ?`).all(prefix + "%", limit);
      const undone = db.prepare("SELECT COUNT(*) c FROM record_versions WHERE note = ?");
      return rows.map(r => {
        const id = (r.note.match(/#([a-z0-9]+)$/) || [])[1] || "";
        return { id, note: r.note, username: r.username, at: r.at, count: r.n, undone: undone.get(`${undoPrefix} #${id}`).c };
      });
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
    version(idx, version) {
      const row = one.get(idx, version);
      return row ? { ...row, record: row.record === null ? null : JSON.parse(row.record) } : null;
    },
    // Cataloging activity: saves per day for the last `days` days, and per person in that period.
    activity(days = 30) {
      const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      const perDay = db.prepare(`SELECT substr(saved_at, 1, 10) day, COUNT(*) n, COUNT(DISTINCT idx) records
                                 FROM record_versions WHERE saved_at >= ? AND username <> 'import' GROUP BY day`).all(since);
      const perUser = db.prepare(`SELECT username, COUNT(*) n, COUNT(DISTINCT idx) records
                                  FROM record_versions WHERE saved_at >= ? AND username <> 'import' GROUP BY username ORDER BY n DESC LIMIT 12`).all(since);
      const byDay = new Map(perDay.map(r => [r.day, r]));
      const series = [];
      for (let i = days - 1; i >= 0; i--) {
        const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const r = byDay.get(day);
        series.push({ day, saves: r ? r.n : 0, records: r ? r.records : 0 });
      }
      return { days, series, users: perUser.map(r => ({ username: r.username, saves: r.n, records: r.records })) };
    },
    editedCount() {
      return db.prepare("SELECT COUNT(*) c FROM (SELECT idx, MAX(version) v FROM record_versions GROUP BY idx) m JOIN record_versions rv ON rv.idx = m.idx AND rv.version = m.v WHERE rv.record IS NOT NULL").get().c;
    }
  };
}

function workflowStore(db) {
  const all = db.prepare("SELECT idx, status, bookmarked FROM workflow");
  const upsert = db.prepare(`INSERT INTO workflow(idx, status, bookmarked, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(idx) DO UPDATE SET status = excluded.status, bookmarked = excluded.bookmarked, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  return {
    loadAll() {
      const out = {};
      for (const r of all.iterate()) out[r.idx] = { status: r.status, bookmarked: !!r.bookmarked };
      return out;
    },
    set(idx, wf, username) {
      upsert.run(idx, wf.status, wf.bookmarked ? 1 : 0, username, new Date().toISOString());
    }
  };
}

// ----------------------------------------------------
// Backups: a consistent copy of the database made while it is in use (SQLite online backup).
// ----------------------------------------------------
function backupManager(db, dataDir) {
  const dir = path.join(dataDir, "backups");
  const list = () => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => /^alqamar-\d{4}-\d{2}-\d{2}(-\d{6})?\.db$/.test(f))
      .map(f => { const st = fs.statSync(path.join(dir, f)); return { file: f, bytes: st.size, at: st.mtime.toISOString() }; })
      .sort((a, b) => b.file.localeCompare(a.file));
  };
  const prune = () => {
    const daily = list().filter(b => /^alqamar-\d{4}-\d{2}-\d{2}\.db$/.test(b.file));
    for (const b of daily.slice(BACKUP_KEEP)) fs.unlinkSync(path.join(dir, b.file));
    const manual = list().filter(b => /-\d{6}\.db$/.test(b.file));
    for (const b of manual.slice(BACKUP_KEEP)) fs.unlinkSync(path.join(dir, b.file));
  };
  async function backup(kind = "daily") {
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const day = d.toISOString().slice(0, 10);
    const name = kind === "daily" ? `alqamar-${day}.db` : `alqamar-${day}-${d.toISOString().slice(11, 19).replace(/:/g, "")}.db`;
    const target = path.join(dir, name);
    const tmp = target + ".tmp";
    await db.backup(tmp);
    fs.renameSync(tmp, target);
    prune();
    return { file: name, bytes: fs.statSync(target).size, at: new Date().toISOString() };
  }
  // Make today's backup if it doesn't exist yet; check again every hour.
  function schedule(onDone) {
    const run = () => {
      const today = `alqamar-${new Date().toISOString().slice(0, 10)}.db`;
      if (list().some(b => b.file === today)) return;
      backup("daily").then(b => onDone && onDone(null, b)).catch(err => onDone && onDone(err));
    };
    run();
    setInterval(run, 60 * 60 * 1000).unref();
  }
  return { backup, list, schedule, dir };
}

module.exports = { openDatabase, recordStore, workflowStore, backupManager };
