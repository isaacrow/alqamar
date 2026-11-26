// Sign-in from Moon: Al-Qamar asks Moon's server (here a stand-in) who a Moon session belongs to, never the browser,
// and picks the Al-Qamar account and role from that.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startServer } = require("./helpers");

const MOON_USERS = {
  "tok-owner-0123456789abcdef": { username: "owner2", role: "admin", status: "approved" },
  "tok-fatima-0123456789abcde": { username: "fatima", role: "cataloger", status: "approved" },
  "tok-fatima-up-0123456789ab": { username: "fatima", role: "admin", status: "approved" },
  "tok-owner-cat-0123456789ab": { username: "owner2", role: "cataloger", status: "approved" },
  "tok-tester-0123456789abcde": { username: "newbie", role: "tester", status: "approved" },
  "tok-starter-0123456789abcd": { username: "admin", role: "reviewer", status: "approved" },
  "tok-pending-0123456789abcd": { username: "waiting", role: "cataloger", status: "pending" }
};

test("sign-in from Moon", async (t) => {
  const seen = [];
  const moon = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, session: req.headers["x-moon-session"] });
    const user = req.url === "/api/accounts/me" && MOON_USERS[req.headers["x-moon-session"]];
    res.writeHead(user ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(user ? { success: true, user } : { success: false }));
  });
  await new Promise(r => moon.listen(0, "127.0.0.1", r));
  process.env.ALQAMAR_MOON_API = `http://127.0.0.1:${moon.address().port}`;
  process.env.ALQAMAR_MOON_ANON_KEY = "public-site-key";
  const s = await startServer();
  t.after(async () => { await s.stop(); moon.close(); delete process.env.ALQAMAR_MOON_API; delete process.env.ALQAMAR_MOON_ANON_KEY; });
  const sso = session => s.api("/api/auth/moon", { method: "POST", body: { session } });

  await t.test("Moon's Super Admin becomes Al-Qamar's super admin, with a working session", async () => {
    const r = await sso("tok-owner-0123456789abcdef");
    assert.equal(r.status, 200);
    assert.equal(r.json.user.role, "superadmin");
    assert.equal(r.json.user.mustChangePassword, false);
    assert.equal((await s.api("/api/auth/me", { cookie: r.token })).json.user.username, "owner2");
    assert.equal((await s.api("/api/list", { cookie: r.token })).status, 200);
    assert.deepEqual(seen.at(-1), { url: "/api/accounts/me", auth: "Bearer public-site-key", session: "tok-owner-0123456789abcdef" }, "Moon's server is asked");
  });

  await t.test("a Moon cataloger gets a cataloger account; an existing account keeps its own role", async () => {
    const r = await sso("tok-fatima-0123456789abcde");
    assert.equal(r.json.user.role, "cataloger");
    const again = await sso("tok-fatima-up-0123456789ab");
    assert.equal(again.status, 200);
    assert.equal(again.json.user.role, "cataloger", "a higher Moon role does not raise an existing Al-Qamar account");
  });

  await t.test("refused: unknown or pending sessions, testers, starter names, accounts with more rights", async () => {
    assert.equal((await sso("tok-nobody-0123456789abcde")).status, 401);
    assert.equal((await sso("tok-pending-0123456789abcd")).status, 401, "a pending Moon account is not signed in");
    assert.equal((await sso("tok-tester-0123456789abcde")).status, 403);
    assert.equal((await sso("tok-starter-0123456789abcd")).status, 403, "never the shipped admin / cataloger / reviewer accounts");
    const up = await sso("tok-owner-cat-0123456789ab");
    assert.equal(up.status, 403, "a Moon cataloger cannot enter an Al-Qamar super admin account of the same name");
    assert.equal(up.token, undefined);
    assert.equal((await sso("short")).status, 400);
    assert.equal((await s.api("/api/auth/moon", { method: "POST", body: { session: "x\"; drop" } })).status, 400);
  });

  await t.test("accounts made from Moon cannot be entered with a password", async () => {
    for (const password of ["", "owner2", "password", "12345678"]) {
      assert.equal((await s.api("/api/auth/login", { method: "POST", body: { username: "owner2", password } })).status, 401);
    }
  });
});
