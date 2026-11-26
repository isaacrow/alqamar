// Starts a real Al-Qamar server on a free port with a throwaway data folder holding the 40-record fixture.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "catalog.jsonl");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

// extraFiles: { "users.json": {...} } written into the data folder before start (to test the import)
// existingDir: start again on a data folder from an earlier server (to test restarts)
async function startServer(extraFiles = {}, existingDir = null) {
  const dataDir = existingDir || fs.mkdtempSync(path.join(os.tmpdir(), "alqamar-test-"));
  if (!existingDir) fs.copyFileSync(FIXTURE, path.join(dataDir, "dromh_marc21_rda_catalog_v2.jsonl"));
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dataDir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    env: { ...process.env, PORT: String(port), ALQAMAR_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start:\n" + log)), 20000);
    const check = () => { if (log.includes("Local:")) { clearTimeout(t); resolve(); } };
    child.stdout.on("data", check);
    child.on("exit", code => { clearTimeout(t); reject(new Error(`server exited (${code}):\n${log}`)); });
  });
  const base = `http://127.0.0.1:${port}`;

  const api = async (p, { method = "GET", body, cookie, raw } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = "alqami_token=" + cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString("utf8")); } catch (e) {}
    const token = ((res.headers.get("set-cookie") || "").match(/alqami_token=([a-f0-9]{64})/) || [])[1];
    return { status: res.status, json, buf, headers: res.headers, token };
  };

  // Log in as a starter account and replace its shipped password; returns the session cookie value.
  const loginFresh = async (username, shipped, newPassword) => {
    const r = await api("/api/auth/login", { method: "POST", body: { username, password: shipped } });
    if (r.status !== 200) throw new Error(`login ${username}: ${r.status}`);
    const c = await api("/api/auth/change-password", { method: "POST", cookie: r.token, body: { currentPassword: shipped, newPassword } });
    if (c.status !== 200) throw new Error(`change password ${username}: ${c.status} ${JSON.stringify(c.json)}`);
    return r.token;
  };

  let stopped = false;
  // keepData: leave the data folder so another server can start on it
  const stop = ({ keepData = false } = {}) => new Promise(resolve => {
    if (stopped) return resolve();
    stopped = true;
    child.once("exit", () => {
      if (!keepData) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} }
      resolve();
    });
    child.kill();
  });

  return { base, api, loginFresh, stop, dataDir, log: () => log };
}

module.exports = { startServer, FIXTURE };
