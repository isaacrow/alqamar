"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mb = require("../server/marc_builder");
const { startServer } = require("./helpers");

test("server: security, MARC export, search, history and backups", async (t) => {
  let s = await startServer();
  t.after(() => s.stop());
  let admin, cataloger;

  await t.test("nothing works without logging in", async () => {
    for (const p of ["/api/users", "/api/list", "/api/record?idx=0", "/api/dashboard/stats", "/api/download-mrc?idx=0", "/api/record/history?idx=0", "/api/admin/backups"]) {
      assert.equal((await s.api(p)).status, 401, p);
    }
    assert.equal((await s.api("/api/users", { method: "POST", body: { username: "x", password: "longpassword", fullName: "x", role: "admin" } })).status, 401);
    const page = await s.api("/");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("access-control-allow-origin"), null, "no open CORS");
  });

  await t.test("shipped passwords must be changed before anything else", async () => {
    const r = await s.api("/api/auth/login", { method: "POST", body: { username: "admin", password: "admin123" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.mustChangePassword, true);
    assert.match(r.headers.get("set-cookie"), /HttpOnly/);
    assert.equal((await s.api("/api/list", { cookie: r.token })).status, 403);
    assert.equal((await s.api("/api/auth/change-password", { method: "POST", cookie: r.token, body: { currentPassword: "admin123", newPassword: "cat123" } })).status, 400, "can't pick another shipped password");
    admin = await s.loginFresh("admin", "admin123", "AdminTest#2026");
    assert.equal((await s.api("/api/list", { cookie: admin })).status, 200);
  });

  await t.test("bad input never crashes the server", async () => {
    for (const p of ["/api/record?idx=abc", "/api/record?idx=-1", "/api/record?idx=999999", "/api/record"]) {
      assert.equal((await s.api(p, { cookie: admin })).status, 400, p);
    }
    assert.equal((await s.api("/api/save?idx=0", { method: "POST", cookie: admin, body: "{not json" })).status, 400);
    assert.equal((await s.api("/api/record?idx=0", { cookie: admin })).status, 200, "still alive");
  });

  await t.test("roles: catalogers can't approve, manage users or open the tunnel", async () => {
    cataloger = await s.loginFresh("cataloger", "cat123", "CatTest#2026");
    assert.equal((await s.api("/api/users", { cookie: cataloger })).status, 403);
    assert.equal((await s.api("/api/tunnel/start", { method: "POST", cookie: cataloger })).status, 403);
    assert.equal((await s.api("/api/workflow?idx=1", { method: "POST", cookie: cataloger, body: { status: "approved" } })).status, 403);
    assert.equal((await s.api("/api/workflow?idx=1", { method: "POST", cookie: cataloger, body: { status: "review" } })).status, 200);
  });

  await t.test("only a super admin can create admin accounts; a super admin can't be deleted", async () => {
    let r = await s.api("/api/users", { method: "POST", cookie: admin, body: { username: "admin2", password: "LongEnough#1", fullName: "مدير ثان", role: "admin" } });
    assert.equal(r.status, 400, "a regular admin can't create another admin");
    r = await s.api("/api/users", { method: "POST", cookie: admin, body: { username: "boss", password: "LongEnough#1", fullName: "x", role: "superadmin" } });
    assert.equal(r.status, 400, "nor a super admin");
    r = await s.api("/api/users", { method: "POST", cookie: admin, body: { username: "cat3", password: "LongEnough#1", fullName: "مفهرس", role: "cataloger" } });
    assert.equal(r.status, 200, "but can create a cataloger");
  });

  await t.test("dashboard analytics: totals add up, filters narrow, activity is counted", async () => {
    assert.equal((await s.api("/api/dashboard/analytics")).status, 401);
    const all = (await s.api("/api/dashboard/analytics", { cookie: admin })).json;
    assert.equal(all.total, 40, "the 40 fixture records");
    assert.equal(all.dated + all.undated, all.total);
    assert.equal(all.centuries.reduce((n, c) => n + c.count, 0), all.dated, "every dated record is in one century");
    assert.equal(all.countries.reduce((n, c) => n + c.count, 0), all.total, "every record has one country (or 'none')");
    assert.ok(all.completeness.every(c => c.count >= 0 && c.count <= all.total));
    assert.ok(all.options.languages.length && all.options.libraries.length, "filter options are included");
    assert.equal(all.activity.series.length, 30);
    const per = (await s.api("/api/dashboard/analytics?lang=per", { cookie: admin })).json;
    assert.equal(per.total, all.languages.find(l => l.value === "per").count, "the language filter matches its count");
    const lib = all.libraries[0];
    const byLib = (await s.api("/api/dashboard/analytics?library=" + lib.value, { cookie: admin })).json;
    assert.equal(byLib.total, lib.count);
  });

  await t.test("insights page and API: login required, drill-down matches the chart", async () => {
    assert.equal((await s.api("/api/insights/summary")).status, 401);
    const page = await s.api("/insights");
    assert.equal(page.status, 200);
    assert.match(page.buf.toString("utf8"), /تحليلات القمر/);
    const sum = (await s.api("/api/insights/summary", { cookie: admin })).json;
    assert.equal(sum.total, 40);
    const subj = sum.charts.subject[0];
    const recs = (await s.api(`/api/insights/records?f=${encodeURIComponent("subject:" + subj.value)}&limit=5`, { cookie: admin })).json;
    assert.equal(recs.total, subj.count);
    assert.ok(recs.items.length <= 5 && recs.items.every(i => Number.isInteger(i.idx)));
    const geo = (await s.api("/api/insights/geo", { cookie: admin })).json;
    assert.ok(Array.isArray(geo.places) && Array.isArray(geo.flows));
    const net = (await s.api("/api/insights/network?types=subject,lang&per=5&min=1", { cookie: admin })).json;
    assert.deepEqual(net.types, ["subject", "lang"]);
  });

  await t.test("insights extras: local libraries, referrer policy, quality checks and CSV export", async () => {
    // map tile servers need the origin as Referer; nothing more leaves the site
    const page = await s.api("/insights");
    assert.equal(page.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    // Moon shows these pages inside its own through a same-origin proxy; no other site may frame them
    assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'self'");
    assert.match((await s.api("/api/integration")).json.moonUrl, /^https?:\/\/.+\/moon\/$/);
    // addresses are relative, so the pages also work under Moon's /alqamar/
    for (const p of ["/", "/insights"]) {
      const html = (await s.api(p)).buf.toString("utf8");
      assert.ok(!/["'`(]\/(api|vendor|insights|logo\.png)/.test(html), `${p} has no root-relative addresses`);
    }
    // chart and map libraries are served locally (no internet needed); nothing else under node_modules is
    for (const p of ["/vendor/maplibre/maplibre-gl.js", "/vendor/maplibre/maplibre-gl.css", "/vendor/3d-force-graph.js", "/vendor/d3.min.js"]) {
      const r = await s.api(p);
      assert.equal(r.status, 200, p);
      assert.ok(r.buf.length > 1000, p);
    }
    // unknown paths get the app page, never a file from disk
    for (const p of ["/vendor/../package.json", "/vendor/better-sqlite3/package.json", "/vendor/maplibre/package.json", "/vendor/%2e%2e/package.json"]) {
      assert.ok(!/"dependencies"/.test((await s.api(p)).buf.toString("utf8")), p);
    }
    // quality checks are part of the summary, and each issue's list matches its count
    const sum = (await s.api("/api/insights/summary", { cookie: admin })).json;
    assert.ok(Array.isArray(sum.charts.issue));
    assert.equal(sum.heatmaps.length, 4);
    const issue = sum.charts.issue[0];
    const recs = (await s.api(`/api/insights/records?f=${encodeURIComponent("issue:" + issue.value)}`, { cookie: admin })).json;
    assert.equal(recs.total, issue.count);
    // CSV: login and the export permission required; BOM, header row and one row per record
    assert.equal((await s.api("/api/insights/export.csv")).status, 401);
    const csv = await s.api(`/api/insights/export.csv?f=${encodeURIComponent("issue:" + issue.value)}`, { cookie: admin });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.match(csv.headers.get("content-disposition"), /attachment; filename="alqamar-manuscripts-/);
    const text = csv.buf.toString("utf8");
    assert.equal(text.charCodeAt(0), 0xFEFF);
    assert.equal(text.trim().split("\r\n").length, issue.count + 1);
    const reviewer = await s.loginFresh("reviewer", "rev123", "RevTest#2026");
    assert.equal((await s.api("/api/insights/export.csv", { cookie: reviewer })).status, 403, "reviewers can't export");
    assert.equal((await s.api("/api/insights/summary", { cookie: reviewer })).status, 200, "but can see the page");
  });

  await t.test("bulk fixes: preview, permissions, apply as versions, undo the batch", async () => {
    // two records with the script written in the description: one the rule can fix, one it must leave alone
    const prep = async (idx, desc) => {
      const rec = (await s.api(`/api/record?idx=${idx}`, { cookie: admin })).json.record;
      const sf = { ...rec.source_fields, "نوع الخط": "", "وصف النسخة": desc };
      const body = { ...rec, source_fields: sf, marc21_rda: mb.buildMarcRecord({ ...rec, source_fields: sf }) };
      assert.equal((await s.api(`/api/save?idx=${idx}`, { method: "POST", cookie: admin, body })).status, 200);
    };
    await prep(3, "نسخ، ق13، مشكّلة");
    await prep(4, "نسخ متعددة");
    const f = "f=" + encodeURIComponent("library:" + "x"); // an unknown value matches nothing
    assert.equal((await s.api("/api/insights/fix/preview?fix=scriptInDesc")).status, 401);
    assert.equal((await s.api("/api/insights/fix/preview?fix=nope", { cookie: admin })).status, 400);
    const pv = (await s.api("/api/insights/fix/preview?fix=scriptInDesc", { cookie: cataloger })).json;
    assert.equal(pv.fixable, 1);
    assert.equal(pv.skippedTotal, 1, "«نسخ متعددة» means several copies, not a script");
    assert.deepEqual(pv.samples[0].changes.map(c => [c.field, c.after]), [["نوع الخط", "نسخ"], ["وصف النسخة", "ق13، مشكّلة"]]);
    assert.equal((await s.api(`/api/insights/fix/preview?fix=scriptInDesc&${f}`, { cookie: admin })).json.fixable, 0, "the page filter limits the fix");

    const apply = (cookie, expect) => s.api("/api/insights/fix/apply?fix=scriptInDesc", { method: "POST", cookie, body: { expect } });
    assert.equal((await apply(cataloger, 1)).status, 403, "catalogers can preview but not apply a bulk fix");
    assert.equal((await apply(admin, 5)).status, 409, "the preview count must still be right");
    const done = (await apply(admin, 1)).json;
    assert.equal(done.applied, 1);
    assert.match(done.batch, /^[a-f0-9]{10}$/);
    const fixed = (await s.api("/api/record?idx=3", { cookie: admin })).json.record;
    assert.equal(fixed.source_fields["نوع الخط"], "نسخ");
    assert.equal(fixed.source_fields["وصف النسخة"], "ق13، مشكّلة");
    const marcText = JSON.stringify(fixed.marc21_rda);
    assert.ok(marcText.includes("خط نسخ."), "MARC 546 $b gets the script");
    assert.ok(!marcText.includes("نسخ، ق13"), "the old 500 note is replaced");
    assert.equal(mb.validateMarc(fixed.marc21_rda).length, 0);
    const hist = (await s.api("/api/record/history?idx=3", { cookie: admin })).json;
    assert.match(hist.versions[0].note, new RegExp(`#${done.batch}$`));
    const sum = (await s.api("/api/insights/summary", { cookie: admin })).json;
    assert.equal((sum.charts.issue.find(x => x.value === "scriptInDesc") || {}).count, 1, "only the skipped record is left");
    const list = (await s.api("/api/insights/fixes", { cookie: admin })).json;
    assert.equal(list.batches[0].id, done.batch);
    assert.equal(list.batches[0].count, 1);

    assert.equal((await s.api(`/api/insights/fix/undo?batch=${done.batch}`, { method: "POST", cookie: cataloger })).status, 403);
    assert.equal((await s.api("/api/insights/fix/undo?batch=../x", { method: "POST", cookie: admin })).status, 400);
    const undo = (await s.api(`/api/insights/fix/undo?batch=${done.batch}`, { method: "POST", cookie: admin })).json;
    assert.deepEqual([undo.undone, undo.kept], [1, 0]);
    const back = (await s.api("/api/record?idx=3", { cookie: admin })).json.record;
    assert.equal(back.source_fields["وصف النسخة"], "نسخ، ق13، مشكّلة", "back to how it was before the fix");
    assert.equal((await s.api("/api/insights/fixes", { cookie: admin })).json.batches[0].undone, 1);
  });

  await t.test(".mrc and .mrk exports are valid", async () => {
    const r = await s.api("/api/download-mrc?idx=0", { cookie: admin });
    assert.equal(r.status, 200);
    const parsed = mb.parseIso2709(r.buf);
    assert.equal(parsed.leader[9], "a");
    const mrk = await s.api("/api/download-mrc?idx=0&format=mrk", { cookie: admin });
    assert.match(mrk.buf.toString("utf8"), /^=LDR {2}/);
  });

  await t.test("Arabic search ignores hamza / ya differences", async () => {
    const a = await s.api("/api/list?q=" + encodeURIComponent("أصول"), { cookie: admin });
    const b = await s.api("/api/list?q=" + encodeURIComponent("اصول"), { cookie: admin });
    assert.equal(a.json.total, b.json.total);
    assert.ok(a.json.total >= 3);
  });

  await t.test("every save is kept; older versions can be restored, and the restore undone", async () => {
    const orig = (await s.api("/api/record?idx=2", { cookie: admin })).json.record;
    const edit = JSON.parse(JSON.stringify(orig));
    edit.source_fields["العنوان"] = "عنوان معدل للاختبار";
    let r = await s.api("/api/save?idx=2", { method: "POST", cookie: cataloger, body: edit });
    assert.equal(r.status, 200);
    assert.equal(r.json.version, 1);
    const edit2 = JSON.parse(JSON.stringify(edit));
    edit2.source_fields["العنوان"] = "عنوان معدل مرة ثانية";
    r = await s.api("/api/save?idx=2", { method: "POST", cookie: admin, body: edit2 });
    assert.equal(r.json.version, 2);

    let h = (await s.api("/api/record/history?idx=2", { cookie: admin })).json;
    assert.equal(h.current, 2);
    assert.deepEqual(h.versions.map(v => v.version), [2, 1, 0]);
    assert.equal(h.versions[1].username, "cataloger", "who saved it is kept");

    // restore version 1 -> saved as version 3
    r = await s.api("/api/record/restore?idx=2&version=1", { method: "POST", cookie: admin });
    assert.equal(r.json.version, 3);
    assert.equal(r.json.record.source_fields["العنوان"], "عنوان معدل للاختبار");
    // the search index follows the restore
    const found = await s.api("/api/list?q=" + encodeURIComponent("معدل للاختبار"), { cookie: admin });
    assert.ok(found.json.items.some(i => i.idx === 2));

    // back to the catalog original (version 0)
    r = await s.api("/api/record/restore?idx=2&version=0", { method: "POST", cookie: admin });
    assert.equal(r.json.record.source_fields["العنوان"], orig.source_fields["العنوان"]);
    const listed = await s.api("/api/list?filter=edited", { cookie: admin });
    assert.ok(!listed.json.items.some(i => i.idx === 2), "no longer counted as edited");

    // the original-version view and a missing version
    assert.equal((await s.api("/api/record/version?idx=2&version=0", { cookie: admin })).json.record.id, orig.id);
    assert.equal((await s.api("/api/record/version?idx=2&version=99", { cookie: admin })).status, 404);
    h = (await s.api("/api/record/history?idx=2", { cookie: admin })).json;
    assert.equal(h.versions.length, 5, "4 saves + the original");
  });

  await t.test("admins can make a backup, which is a working database copy", async () => {
    const r = await s.api("/api/admin/backup", { method: "POST", cookie: admin });
    assert.equal(r.status, 200);
    const file = path.join(s.dataDir, "backups", r.json.backup.file);
    assert.ok(fs.existsSync(file));
    const Database = require("better-sqlite3");
    const copy = new Database(file, { readonly: true });
    assert.ok(copy.prepare("SELECT COUNT(*) c FROM record_versions").get().c >= 4, "the backup contains the edits");
    copy.close();
    const list = (await s.api("/api/admin/backups", { cookie: admin })).json.backups;
    assert.ok(list.length >= 2, "the daily backup made at startup plus this one");
    assert.equal((await s.api("/api/admin/backup", { method: "POST", cookie: cataloger })).status, 403);
  });

  await t.test("edits, history, workflow and logins survive a restart", async () => {
    const edit = (await s.api("/api/record?idx=5", { cookie: admin })).json.record;
    edit.source_fields["العنوان"] = "باق بعد إعادة التشغيل";
    await s.api("/api/save?idx=5", { method: "POST", cookie: admin, body: edit });

    const dir = s.dataDir;
    await s.stop({ keepData: true });
    s = await startServer({}, dir);

    const r = await s.api("/api/record?idx=5", { cookie: admin });
    assert.equal(r.status, 200, "the session is still valid after the restart");
    assert.equal(r.json.record.source_fields["العنوان"], "باق بعد إعادة التشغيل");
    assert.equal((await s.api("/api/record?idx=1", { cookie: admin })).json.workflow.status, "review");
    assert.equal((await s.api("/api/record/history?idx=2", { cookie: admin })).json.versions.length, 5);
    const found = await s.api("/api/list?q=" + encodeURIComponent("بعد إعادة التشغيل"), { cookie: admin });
    assert.ok(found.json.items.some(i => i.idx === 5 && i.edited), "the search index is rebuilt with the edit");
    // the new password is still required; the shipped one is gone
    assert.equal((await s.api("/api/auth/login", { method: "POST", body: { username: "admin", password: "admin123" } })).status, 401);
  });
});

test("command-line super admin: full access, can manage admins, can't be deleted", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const { execFileSync } = require("child_process");
  // the running test server and this command share the same database (SQLite WAL allows it)
  execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "create_user.js"), "owner", "superadmin", "المالك"], {
    env: { ...process.env, ALQAMAR_DATA_DIR: s.dataDir, ALQAMAR_NEW_PASSWORD: "OwnerPass#2026" }
  });
  const r = await s.api("/api/auth/login", { method: "POST", body: { username: "owner", password: "OwnerPass#2026" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, "superadmin");
  assert.equal(r.json.user.mustChangePassword, false, "the owner chose this password");
  const owner = r.token;
  assert.equal((await s.api("/api/users", { cookie: owner })).status, 200);
  const made = await s.api("/api/users", { method: "POST", cookie: owner, body: { username: "admin2", password: "LongEnough#1", fullName: "مدير ثان", role: "admin" } });
  assert.equal(made.status, 200, "a super admin can create an admin");
  assert.equal((await s.api("/api/users?username=admin2", { method: "DELETE", cookie: owner })).status, 200, "and delete one");
  const admin = await s.loginFresh("admin", "admin123", "AdminTest#2026");
  assert.equal((await s.api("/api/users?username=owner", { method: "DELETE", cookie: admin })).status, 400, "nobody can delete the super admin");
});

test("server: old JSON files are imported into the database on first start", async (t) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("OldAdminPass#1", salt, 64).toString("hex");
  const oldRecord = JSON.parse(fs.readFileSync(require("./helpers").FIXTURE, "utf8").split("\n")[0]);
  oldRecord.source_fields["العنوان"] = "تعديل من الملف القديم";
  const s = await startServer({
    "users.json": { admin: { username: "admin", fullName: "مدير", role: "admin", roleTitle: "مدير المنظومة", hash, salt, permissions: ["catalog:read", "catalog:write", "catalog:approve", "catalog:export", "users:manage", "dashboard:view"] } },
    "edited_records.json": { 0: oldRecord },
    "workflow_state.json": { 3: { status: "approved", bookmarked: true } },
    "audit_log.json": [{ username: "admin", action: "عملية قديمة", timestamp: "2026-10-18T07:00:00.000Z" }]
  });
  t.after(() => s.stop());

  const r = await s.api("/api/auth/login", { method: "POST", body: { username: "admin", password: "OldAdminPass#1" } });
  assert.equal(r.status, 200, "the old password still works");
  assert.equal(r.json.user.mustChangePassword, false, "a non-shipped password is not forced to change");
  const rec = (await s.api("/api/record?idx=0", { cookie: r.token })).json;
  assert.equal(rec.record.source_fields["العنوان"], "تعديل من الملف القديم", "old edit imported");
  const wf = (await s.api("/api/record?idx=3", { cookie: r.token })).json.workflow;
  assert.deepEqual(wf, { status: "approved", bookmarked: true });
  const stats = (await s.api("/api/dashboard/stats", { cookie: r.token })).json;
  assert.ok(stats.recentActivity.some(a => a.action === "عملية قديمة"), "old audit log imported");
  assert.ok(fs.existsSync(path.join(s.dataDir, "users.imported.json")), "original file kept, renamed");
  assert.ok(!fs.existsSync(path.join(s.dataDir, "users.json")));
});
