// Create an account from the server's own computer (the only way to make the first super admin).
//   set ALQAMAR_NEW_PASSWORD=...   (PowerShell: $env:ALQAMAR_NEW_PASSWORD = "...")
//   node scripts/create_user.js <username> <role> "<full name>"
// role: superadmin | admin | reviewer | cataloger
// The password is read from the environment so it doesn't end up in the shell history as an argument.
"use strict";
const path = require("path");
const store = require("../server/db");
const auth = require("../server/auth");

const [username, role, ...nameParts] = process.argv.slice(2);
const fullName = nameParts.join(" ") || username;
const password = process.env.ALQAMAR_NEW_PASSWORD || "";
if (!username || !role || !password) {
  console.error('usage: ALQAMAR_NEW_PASSWORD=... node scripts/create_user.js <username> <superadmin|admin|reviewer|cataloger> "<full name>"');
  process.exit(1);
}
if (!["superadmin", "admin", "reviewer", "cataloger"].includes(role)) {
  console.error(`unknown role: ${role}`);
  process.exit(1);
}

const dataDir = process.env.ALQAMAR_DATA_DIR ? path.resolve(process.env.ALQAMAR_DATA_DIR) : path.join(__dirname, "..", "data");
const db = store.openDatabase(dataDir);
auth.init(db);
try {
  const u = auth.createUser({ username, password, fullName, role }, null);
  console.log(`created ${u.username} (${u.roleTitle})`);
} catch (e) {
  console.error("could not create the account: " + e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
