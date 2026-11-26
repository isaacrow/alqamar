// Users, sessions, passwords and the audit log, stored in the SQLite database (see db.js).
"use strict";

const crypto = require("crypto");

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_PASSWORD_LENGTH = 8;

// The passwords the system shipped with. Anyone still using one must change it before doing anything else.
const SHIPPED_PASSWORDS = { admin: "admin123", cataloger: "cat123", reviewer: "rev123" };
const DEFAULT_PASSWORDS = new Set(Object.values(SHIPPED_PASSWORDS));

const ROLE_TITLES = {
  superadmin: "المدير العام",
  admin: "مدير المنظومة",
  cataloger: "مفهرس مخطوطات",
  reviewer: "مدقق الجودة"
};

// superadmin: everything an admin can do, plus managing admin accounts; can't be deleted.
const ROLE_PERMISSIONS = {
  superadmin: ["catalog:read", "catalog:write", "catalog:approve", "catalog:export", "users:manage", "users:admins", "dashboard:view"],
  admin: ["catalog:read", "catalog:write", "catalog:approve", "catalog:export", "users:manage", "dashboard:view"],
  cataloger: ["catalog:read", "catalog:write", "catalog:export", "dashboard:view"],
  reviewer: ["catalog:read", "catalog:write", "catalog:approve", "dashboard:view"]
};

let db = null;
let q = null; // prepared statements

function hashPassword(password, salt = null) {
  if (!salt) salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (typeof password !== "string" || !hash || !salt) return false;
  const testHash = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (stored.length !== testHash.length) return false;
  return crypto.timingSafeEqual(stored, testHash);
}

function validateNewPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل`);
  }
  if (DEFAULT_PASSWORDS.has(password)) {
    throw new Error("لا يمكن استخدام كلمة مرور افتراضية، اختر كلمة مرور جديدة");
  }
}

function rowToUser(r) {
  return {
    username: r.username,
    fullName: r.full_name,
    role: r.role,
    roleTitle: r.role_title,
    permissions: JSON.parse(r.permissions || "[]"),
    mustChangePassword: r.must_change_password === 1
  };
}

// ----------------------------------------------------
// Setup
// ----------------------------------------------------
function init(database) {
  db = database;
  q = {
    user: db.prepare("SELECT * FROM users WHERE username = ?"),
    users: db.prepare("SELECT * FROM users ORDER BY created_at"),
    countUsers: db.prepare("SELECT COUNT(*) c FROM users"),
    insertUser: db.prepare(`INSERT INTO users (username, full_name, role, role_title, permissions, hash, salt, must_change_password, created_at)
                            VALUES (@username, @full_name, @role, @role_title, @permissions, @hash, @salt, 1, @created_at)`),
    setPassword: db.prepare("UPDATE users SET hash = ?, salt = ?, must_change_password = 0, password_changed_at = ? WHERE username = ?"),
    setMustChange: db.prepare("UPDATE users SET must_change_password = ? WHERE username = ?"),
    deleteUser: db.prepare("DELETE FROM users WHERE username = ?"),
    session: db.prepare("SELECT * FROM sessions WHERE token = ?"),
    insertSession: db.prepare("INSERT INTO sessions(token, username, expires_at, created_at) VALUES (?, ?, ?, ?)"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
    deleteOtherSessions: db.prepare("DELETE FROM sessions WHERE username = ? AND token <> ?"),
    deleteExpired: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
    log: db.prepare("INSERT INTO audit_log(username, action, record_id, details, ts) VALUES (?, ?, ?, ?, ?)"),
    recentLog: db.prepare("SELECT id, username, action, record_id, details, ts FROM audit_log ORDER BY id DESC LIMIT ?")
  };

  // First run: create the three starter accounts. They must change their password at first login.
  if (q.countUsers.get().c === 0) {
    const now = new Date().toISOString();
    const starters = [
      ["admin", "مدير المنظومة المعيارية", "admin"],
      ["cataloger", "مفهرس معتمد MARC 21", "cataloger"],
      ["reviewer", "مدقق جودة وفهرس RDA", "reviewer"]
    ];
    db.transaction(() => {
      for (const [username, fullName, role] of starters) {
        const { hash, salt } = hashPassword(SHIPPED_PASSWORDS[username]);
        q.insertUser.run({ username, full_name: fullName, role, role_title: ROLE_TITLES[role], permissions: JSON.stringify(ROLE_PERMISSIONS[role]), hash, salt, created_at: now });
      }
    })();
  }

  // Accounts imported from the old users.json without a flag (-1): flag them if still on a shipped password.
  for (const r of db.prepare("SELECT * FROM users WHERE must_change_password = -1").all()) {
    const pw = SHIPPED_PASSWORDS[r.username];
    q.setMustChange.run(pw && verifyPassword(pw, r.hash, r.salt) ? 1 : 0, r.username);
  }

  q.deleteExpired.run(Date.now());
  setInterval(() => q.deleteExpired.run(Date.now()), 60 * 60 * 1000).unref();
}

// ----------------------------------------------------
// Audit log
// ----------------------------------------------------
function logActivity(username, action, recordId = null, details = "") {
  try {
    q.log.run(username || null, action, recordId == null ? null : String(recordId), details || "", new Date().toISOString());
  } catch (e) {
    console.error("Audit log error:", e);
  }
}

function loadAuditLog(limit = 20) {
  return q.recentLog.all(limit).reverse().map(r => ({
    id: r.id, username: r.username, action: r.action, recordId: r.record_id, details: r.details, timestamp: r.ts
  }));
}

// ----------------------------------------------------
// Login and sessions
// ----------------------------------------------------
function authenticateUser(username, password) {
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) return null;
  const r = q.user.get(username.trim().toLowerCase());
  if (!r) {
    // Spend the same time as a real check so response timing does not reveal which usernames exist.
    hashPassword(password);
    return null;
  }
  if (!verifyPassword(password, r.hash, r.salt)) return null;
  if (DEFAULT_PASSWORDS.has(password) && r.must_change_password !== 1) q.setMustChange.run(1, r.username);
  return { ...rowToUser(r), mustChangePassword: r.must_change_password === 1 || DEFAULT_PASSWORDS.has(password) };
}

function createSession(user, how = "تسجيل دخول إلى النظام") {
  const token = crypto.randomBytes(32).toString("hex");
  q.insertSession.run(token, user.username, Date.now() + SESSION_MAX_AGE_MS, new Date().toISOString());
  logActivity(user.username, how);
  return token;
}

// The live account behind a session, so a deleted user, a role change or a pending password change applies at once.
function getUserByToken(token) {
  if (!token || typeof token !== "string") return null;
  const s = q.session.get(token);
  if (!s) return null;
  if (Date.now() > s.expires_at) {
    q.deleteSession.run(token);
    return null;
  }
  const r = q.user.get(s.username);
  return r ? rowToUser(r) : null;
}

function removeSession(token) {
  if (!token) return;
  const s = q.session.get(token);
  if (s) {
    q.deleteSession.run(token);
    logActivity(s.username, "تسجيل خروج من النظام");
  }
}

function changePassword(username, currentPassword, newPassword, keepToken) {
  const clean = (username || "").trim().toLowerCase();
  const r = q.user.get(clean);
  if (!r || !verifyPassword(currentPassword, r.hash, r.salt)) {
    throw new Error("كلمة المرور الحالية غير صحيحة");
  }
  validateNewPassword(newPassword);
  if (newPassword === currentPassword) {
    throw new Error("كلمة المرور الجديدة يجب أن تختلف عن الحالية");
  }
  const { hash, salt } = hashPassword(newPassword);
  db.transaction(() => {
    q.setPassword.run(hash, salt, new Date().toISOString(), clean);
    // Sign out this user everywhere else; keep only the session that made the change.
    q.deleteOtherSessions.run(clean, keepToken || "");
  })();
  logActivity(clean, "تغيير كلمة المرور");
  return true;
}

// ----------------------------------------------------
// User management
// ----------------------------------------------------
function listUsers() {
  return q.users.all().map(r => ({ ...rowToUser(r), createdAt: r.created_at }));
}

function createUser({ username, password, fullName, role } = {}, actor = "admin") {
  if (typeof username !== "string" || typeof password !== "string" || typeof fullName !== "string" ||
      !username.trim() || !fullName.trim()) {
    throw new Error("جميع الحقول مطلوبة");
  }
  const cleanUsername = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
    throw new Error("اسم المستخدم: 3 إلى 32 حرفاً لاتينياً أو أرقاماً أو . _ -");
  }
  if (fullName.trim().length > 100) throw new Error("الاسم الكامل طويل جداً");
  validateNewPassword(password);
  if (q.user.get(cleanUsername)) throw new Error("اسم المستخدم موجود مسبقاً");

  const cleanRole = ROLE_PERMISSIONS[role] ? role : "cataloger";
  // Admin-level accounts can only be created by a super admin (or from the server's command line: actor null).
  if ((cleanRole === "admin" || cleanRole === "superadmin") && actor !== null) {
    const a = q.user.get(actor);
    if (!a || a.role !== "superadmin") throw new Error("إنشاء حسابات المديرين من صلاحية المدير العام فقط");
  }
  const { hash, salt } = hashPassword(password);
  // The admin chose this password, so the new user must pick their own on first login (insertUser sets the flag).
  // From the command line (actor null) the owner set their own password, so no forced change.
  q.insertUser.run({
    username: cleanUsername, full_name: fullName.trim(), role: cleanRole, role_title: ROLE_TITLES[cleanRole],
    permissions: JSON.stringify(ROLE_PERMISSIONS[cleanRole]), hash, salt, created_at: new Date().toISOString()
  });
  if (actor === null) q.setMustChange.run(0, cleanUsername);
  logActivity(actor || "سطر الأوامر", `إنشاء حساب مستخدم جديد: ${cleanUsername}`, null, `الدور: ${ROLE_TITLES[cleanRole]}`);
  return rowToUser(q.user.get(cleanUsername));
}

// ----------------------------------------------------
// Sign-in from Moon (the BIBFRAME system Al-Qamar runs inside). The server has already checked the Moon session
// with Moon's own server; this picks the Al-Qamar account for that Moon user.
// ----------------------------------------------------
// Moon's single Super Admin ("admin" in Moon) is Al-Qamar's super admin; testers get no access.
const MOON_ROLE_MAP = { admin: "superadmin", cataloger: "cataloger", reviewer: "reviewer" };
const ROLE_RANK = { reviewer: 1, cataloger: 1, admin: 2, superadmin: 3 };
const STARTER_USERNAMES = new Set(Object.keys(SHIPPED_PASSWORDS));

// Returns { user } or { error }. An Al-Qamar account with the same name is used as it is (its own role), unless
// it has more rights than the Moon role allows; otherwise an account is made with the role the Moon role maps to.
// Accounts made this way get an unknown random password: they are entered through Moon.
function moonAccount(moonUser) {
  const role = MOON_ROLE_MAP[moonUser && moonUser.role];
  if (!role) return { error: "حسابك في Moon لا يتيح الوصول إلى فهرس المخطوطات (دور المختبِر)" };
  const username = String(moonUser.username || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return { error: "اسم المستخدم في Moon لا يصلح اسماً في القمر؛ سجّل الدخول بحساب القمر" };
  if (STARTER_USERNAMES.has(username)) return { error: "هذا اسم حساب افتتاحي في القمر؛ سجّل الدخول بكلمة مروره" };
  const existing = q.user.get(username);
  if (existing) {
    if ((ROLE_RANK[existing.role] || 0) > ROLE_RANK[role]) {
      return { error: "لحساب القمر بهذا الاسم صلاحيات أعلى من دورك في Moon؛ سجّل الدخول بكلمة مروره" };
    }
    if (existing.must_change_password === 1) return { error: "على هذا الحساب تغيير كلمة مروره في القمر أولاً" };
    return { user: rowToUser(existing) };
  }
  const { hash, salt } = hashPassword(crypto.randomBytes(32).toString("hex"));
  const fullName = String(moonUser.fullName || moonUser.username).trim().slice(0, 100) || username;
  q.insertUser.run({
    username, full_name: fullName, role, role_title: ROLE_TITLES[role],
    permissions: JSON.stringify(ROLE_PERMISSIONS[role]), hash, salt, created_at: new Date().toISOString()
  });
  q.setMustChange.run(0, username);
  logActivity("Moon", `إنشاء حساب من Moon: ${username}`, null, `الدور: ${ROLE_TITLES[role]}`);
  return { user: rowToUser(q.user.get(username)) };
}

function deleteUser(username, actor = "admin") {
  const clean = (typeof username === "string" ? username : "").trim().toLowerCase();
  if (clean === "admin") throw new Error("لا يمكن حذف حساب المدير الافتراضي");
  if (clean === actor) throw new Error("لا يمكنك حذف حسابك أنت");
  const target = q.user.get(clean);
  if (!target) throw new Error("المستخدم غير موجود");
  if (target.role === "superadmin") throw new Error("لا يمكن حذف حساب المدير العام");
  if (target.role === "admin") {
    const a = q.user.get(actor);
    if (!a || a.role !== "superadmin") throw new Error("حذف حسابات المديرين من صلاحية المدير العام فقط");
  }
  q.deleteUser.run(clean); // sessions go with it (ON DELETE CASCADE)
  logActivity(actor, `حذف حساب المستخدم: ${clean}`);
  return true;
}

module.exports = {
  init,
  authenticateUser,
  createSession,
  getUserByToken,
  removeSession,
  changePassword,
  listUsers,
  createUser,
  deleteUser,
  moonAccount,
  logActivity,
  loadAuditLog
};
