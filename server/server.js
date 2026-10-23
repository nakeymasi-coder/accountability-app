"use strict";
/*
 * Accountability App — backend.
 * Node built-in http only. Zero npm dependencies.
 * Run:  node server/server.js        (PORT env var, default 8787)
 *
 * Data: JSON file store in server/data/, one file per table.
 * Secrets: environment variables ONLY (see README). Nothing secret is
 * stored in code or in the data files. Passwords are hashed with
 * Node crypto scrypt. Password-reset codes are stored server-side
 * ONLY as hashes and are never returned to the client.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, "data");
const OWNER_ADMIN_EMAIL = "nakeymasi@gmail.com"; // the ONLY account that can ever be admin
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const RESET_TTL_MS = 1000 * 60 * 30; // 30 minutes
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 }; // per IP+route on public forms

/* Tables — match supabase/schema.sql 1:1. Every row carries created_at + updated_at. */
const TABLES = [
  "profiles", "credentials", "sessions", "user_roles", "invites",
  "accountability_requests", "matches", "calendar_events", "messages",
  "content_items", "integration_connections", "audit_log", "data_requests", "rate_limits",
];

/* ---------------- JSON file store ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const store = {};
for (const t of TABLES) {
  const file = path.join(DATA_DIR, t + ".json");
  if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");
  try { store[t] = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { store[t] = []; }
}
function save(table) { fs.writeFileSync(path.join(DATA_DIR, table + ".json"), JSON.stringify(store[table], null, 2)); }
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function insert(table, row) { const r = { id: uid(), ...row, created_at: now(), updated_at: now() }; store[table].push(r); save(table); return r; }
function update(table, row) { row.updated_at = now(); save(table); return row; }

/* Seed default content + integration status rows (no member data). */
if (store.content_items.length === 0) {
  insert("content_items", { slug: "privacy-policy", kind: "privacy", title: "Privacy Policy", body: "We store your name, email, accountability requests, replies, and calendar commitments so the app can match you with a partner. We never sell your data. Your account data is kept until you delete your account, or the owner removes it after 24 months inactive. You can export or delete your data any time from the Account tab.", is_published: true, updated_by: null });
  insert("content_items", { slug: "welcome", kind: "announcement", title: "Welcome", body: "Welcome to our private accountability community. Post what you're showing up for — somebody here will show up with you.", is_published: true, updated_by: null });
  insert("content_items", { slug: "how-it-works", kind: "guide", title: "How it works", body: "1) Post a request with what you need accountability for and what your partner should do. 2) A member claims it. 3) It lands on the shared calendar. 4) Show up, then mark it completed.", is_published: true, updated_by: null });
}
if (store.integration_connections.length === 0) {
  for (const provider of ["zoom", "google_calendar", "email"]) {
    insert("integration_connections", { provider, status: "not_connected", external_account_label: "", last_checked_at: null });
  }
}

/* ---------------- Password hashing (scrypt) ---------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  const hash = crypto.scryptSync(password, salt, 64);
  const exp = Buffer.from(expected, "hex");
  return hash.length === exp.length && crypto.timingSafeEqual(hash, exp);
}
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
const hashCode = (c) => crypto.createHash("sha256").update(c).digest("hex");

/* ---------------- Helpers ---------------- */
const FRIENDLY = {
  auth: "Please sign in to continue.",
  forbidden: "That area is for the owner only.",
  notFound: "That isn't here anymore.",
  server: "Something went wrong on our side. Please try again in a moment.",
};
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
const fail = (res, status, message) => send(res, status, { error: message });
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function validHttpUrl(v) {
  if (!v) return true; // empty is fine — the field is optional
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:"; } catch (_) { return false; }
}
const LINK_ERROR = "That link doesn't look right — links start with https://";
function audit(actorId, action, targetType, targetId, details) {
  insert("audit_log", { actor_id: actorId, action, target_type: targetType, target_id: targetId || null, details: details || "" });
}
function publicUser(profile) {
  const roles = store.user_roles.filter((r) => r.user_id === profile.id).map((r) => r.role);
  return { id: profile.id, email: profile.email, display_name: profile.display_name, consent_accepted_at: profile.consent_accepted_at, marketing_email_opt_in: profile.marketing_email_opt_in, created_at: profile.created_at, updated_at: profile.updated_at, roles };
}
function isOwnerAdmin(profile) {
  return profile && profile.email === OWNER_ADMIN_EMAIL && store.user_roles.some((r) => r.user_id === profile.id && r.role === "admin");
}
/* Make sure the owner account — and only the owner — holds admin.
   Runs on sign-in: strips admin from anyone else, grants it to the owner. */
function enforceOwnerAdmin(profile) {
  let changed = false;
  for (const r of store.user_roles) {
    if (r.role === "admin" && r.user_id !== profile.id) { /* handled globally below */ }
  }
  // Remove admin from every non-owner profile.
  const ownerIds = new Set(store.profiles.filter((p) => p.email === OWNER_ADMIN_EMAIL).map((p) => p.id));
  const before = store.user_roles.length;
  store.user_roles = store.user_roles.filter((r) => r.role !== "admin" || ownerIds.has(r.user_id));
  if (store.user_roles.length !== before) changed = true;
  if (profile.email === OWNER_ADMIN_EMAIL && !store.user_roles.some((r) => r.user_id === profile.id && r.role === "admin")) {
    insert("user_roles", { user_id: profile.id, role: "admin" }); changed = true;
  }
  if (changed) save("user_roles");
}
function rateLimited(req, route) {
  const key = (req.socket.remoteAddress || "unknown") + ":" + route;
  const windowStart = new Date(Date.now() - RATE_LIMIT.windowMs).toISOString();
  let row = store.rate_limits.find((r) => r.key === key && r.window_start > windowStart);
  if (!row) { row = insert("rate_limits", { key, window_start: now(), count: 0 }); }
  row.count += 1; update("rate_limits", row);
  return row.count > RATE_LIMIT.max;
}
function requireAuth(req, res) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) { fail(res, 401, FRIENDLY.auth); return null; }
  const session = store.sessions.find((s) => s.token_hash === hashToken(token) && new Date(s.expires_at) > new Date());
  if (!session) { fail(res, 401, FRIENDLY.auth); return null; }
  const profile = store.profiles.find((p) => p.id === session.user_id);
  if (!profile) { fail(res, 401, FRIENDLY.auth); return null; }
  return profile;
}
function requireAdmin(req, res) {
  const profile = requireAuth(req, res);
  if (!profile) return null;
  enforceOwnerAdmin(profile);
  if (!isOwnerAdmin(profile)) { fail(res, 403, "Admin is locked to the owner account only (" + OWNER_ADMIN_EMAIL + ")."); return null; }
  return profile;
}

/* ---------------- Static front end (same folder as repo root) ---------------- */
const ROOT = path.join(__dirname, "..");
const STATIC = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css", "/manifest.webmanifest": "manifest.webmanifest", "/icon.svg": "icon.svg" };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };
function serveStatic(req, res, pathname) {
  const file = STATIC[pathname];
  if (!file) return false;
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return false;
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "text/plain" });
  res.end(fs.readFileSync(full));
  return true;
}

/* ---------------- Router ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname; const method = req.method;
    if (!p.startsWith("/api/")) { if (serveStatic(req, res, p)) return; return fail(res, 404, FRIENDLY.notFound); }
    const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? await readBody(req) : {};
    const seg = p.split("/").filter(Boolean); // ["api", ...]

    if (p === "/api/health") return send(res, 200, { ok: true });

    /* ----- Auth ----- */
    if (p === "/api/auth/signup" && method === "POST") {
      if (rateLimited(req, "signup")) return fail(res, 429, "Too many sign-ups from here just now. Please wait a bit and try again.");
      if (body.website) return fail(res, 400, "That signup couldn't be accepted."); // honeypot
      const name = clean(body.name, 80), email = clean(body.email, 160).toLowerCase(), password = String(body.password || "");
      if (!name || !validEmail(email)) return fail(res, 400, "Please add your name and a valid email address.");
      if (password.length < 8) return fail(res, 400, "Please choose a password of at least 8 characters.");
      if (body.consent !== true) return fail(res, 400, "Please agree to the Privacy Policy so we can store your requests and match you with a partner.");
      if (store.profiles.some((x) => x.email === email)) return fail(res, 409, "An account with that email already exists. Try signing in instead.");
      const isOwner = email === OWNER_ADMIN_EMAIL;
      let invite = null;
      if (!isOwner) { // owner bypasses the invite requirement so she can always claim admin
        const code = clean(body.inviteCode, 40).toUpperCase();
        invite = store.invites.find((i) => i.code === code && i.is_active && i.use_count < i.max_uses && (!i.expires_at || new Date(i.expires_at) > new Date()));
        if (!invite) return fail(res, 403, "That invite code didn't work. This community is invite-only — check the code or ask the owner for a fresh one.");
      }
      const profile = insert("profiles", { email, display_name: name, consent_accepted_at: now(), marketing_email_opt_in: body.marketingOptIn === true });
      const { salt, hash } = hashPassword(password);
      insert("credentials", { user_id: profile.id, password_hash: hash, password_salt: salt, password_reset_code_hash: "", password_reset_expires_at: null });
      insert("user_roles", { user_id: profile.id, role: "member" });
      if (isOwner) { insert("user_roles", { user_id: profile.id, role: "admin" }); }
      if (invite) { invite.use_count += 1; invite.used_by = profile.id; if (invite.use_count >= invite.max_uses) invite.is_active = false; update("invites", invite); }
      const token = crypto.randomBytes(32).toString("hex");
      insert("sessions", { user_id: profile.id, token_hash: hashToken(token), expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
      return send(res, 201, { user: publicUser(profile), token });
    }
    if (p === "/api/auth/signin" && method === "POST") {
      if (rateLimited(req, "signin")) return fail(res, 429, "Too many sign-in tries just now. Please wait a bit and try again.");
      const email = clean(body.email, 160).toLowerCase(), password = String(body.password || "");
      const profile = store.profiles.find((x) => x.email === email);
      const cred = profile && store.credentials.find((c) => c.user_id === profile.id);
      if (!profile || !cred || !verifyPassword(password, cred.password_salt, cred.password_hash)) return fail(res, 401, "That email and password don't match. Check them and try again.");
      enforceOwnerAdmin(profile);
      const token = crypto.randomBytes(32).toString("hex");
      insert("sessions", { user_id: profile.id, token_hash: hashToken(token), expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
      return send(res, 200, { user: publicUser(profile), token });
    }
    if (p === "/api/auth/signout" && method === "POST") {
      const profile = requireAuth(req, res); if (!profile) return;
      const token = (req.headers.authorization || "").slice(7);
      store.sessions = store.sessions.filter((s) => !(s.user_id === profile.id && s.token_hash === hashToken(token))); save("sessions");
      return send(res, 200, { ok: true });
    }
    if (p === "/api/auth/password-reset" && method === "POST") {
      if (rateLimited(req, "password-reset")) return fail(res, 429, "Too many reset requests just now. Please wait a bit and try again.");
      const email = clean(body.email, 160).toLowerCase();
      const profile = store.profiles.find((x) => x.email === email);
      if (profile) {
        const cred = store.credentials.find((c) => c.user_id === profile.id);
        const code = String(crypto.randomInt(100000, 999999));
        // SECURITY: only the HASH lives server-side. The plain code is never
        // stored, logged, or returned — it is delivered by email once the
        // email integration is connected; until then the owner helps in person.
        cred.password_reset_code_hash = hashCode(code); cred.password_reset_expires_at = new Date(Date.now() + RESET_TTL_MS).toISOString(); update("credentials", cred);
      }
      // Same friendly answer whether or not the account exists.
      return send(res, 200, { ok: true, message: "If an account exists for that email, a reset is on its way. For your safety, reset codes are never shown inside the app — use the code sent to your own email, or ask the owner for help until email sending is connected.", resetToken: null });
    }

    /* ----- Me ----- */
    if (p === "/api/me" && method === "GET") { const me = requireAuth(req, res); if (!me) return; return send(res, 200, { user: publicUser(me) }); }
    if (p === "/api/me" && method === "PATCH") {
      const me = requireAuth(req, res); if (!me) return;
      if (typeof body.marketingOptIn === "boolean") { me.marketing_email_opt_in = body.marketingOptIn; update("profiles", me); }
      if (typeof body.display_name === "string" && body.display_name.trim()) { me.display_name = clean(body.display_name, 80); update("profiles", me); }
      return send(res, 200, { user: publicUser(me) });
    }

    /* ----- Requests ----- */
    if (p === "/api/requests" && method === "GET") {
      const me = requireAuth(req, res); if (!me) return;
      const requests = store.accountability_requests.slice().sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for)).map((r) => ({
        ...r,
        requester_name: (store.profiles.find((x) => x.id === r.requester_id) || {}).display_name || "Member",
        message_count: store.messages.filter((m) => m.request_id === r.id).length,
      }));
      return send(res, 200, { requests });
    }
    if (p === "/api/requests" && method === "POST") {
      const me = requireAuth(req, res); if (!me) return;
      if (rateLimited(req, "new-request")) return fail(res, 429, "You're posting a lot just now. Please wait a bit and try again.");
      if (body.website) return fail(res, 400, "That post couldn't be accepted."); // honeypot
      const title = clean(body.title, 120), what = clean(body.what_needed, 1000), duties = clean(body.partner_duties, 1000);
      const when = new Date(body.scheduled_for);
      if (!title || !what || !duties || isNaN(when)) return fail(res, 400, "Please fill in the title, what you need accountability for, what your partner should do, and a valid date and time.");
      const duration = Math.max(5, Math.min(480, Number(body.duration_minutes) || 30));
      const dup = store.accountability_requests.find((r) => r.requester_id === me.id && r.title === title && r.scheduled_for === when.toISOString() && r.status !== "cancelled");
      if (dup) return fail(res, 409, "You already posted this exact request for that time — it's in the feed already.");
      const linkUrl = clean(body.link_url, 2000);
      if (!validHttpUrl(linkUrl)) return fail(res, 400, LINK_ERROR);
      const r = insert("accountability_requests", { requester_id: me.id, title, what_needed: what, partner_duties: duties, scheduled_for: when.toISOString(), duration_minutes: duration, location_or_link: clean(body.location_or_link, 300), link_url: linkUrl, status: "open" });
      return send(res, 201, { request: r });
    }
    if (seg[1] === "requests" && seg[3] === "claim" && method === "POST") {
      const me = requireAuth(req, res); if (!me) return;
      const r = store.accountability_requests.find((x) => x.id === seg[2]);
      if (!r) return fail(res, 404, FRIENDLY.notFound);
      if (r.requester_id === me.id) return fail(res, 400, "You can't claim your own request — a partner has to claim it.");
      if (r.status !== "open") return fail(res, 409, "This request was already claimed by someone else.");
      const match = insert("matches", { request_id: r.id, requester_id: r.requester_id, partner_id: me.id, status: "active", completed_at: null, notes: "" });
      r.status = "matched"; update("accountability_requests", r);
      const start = new Date(r.scheduled_for);
      insert("calendar_events", { request_id: r.id, match_id: match.id, title: r.title, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + r.duration_minutes * 60000).toISOString(), requester_id: r.requester_id, partner_id: me.id, status: "scheduled" });
      return send(res, 201, { match });
    }
    if (seg[1] === "requests" && seg[3] === "messages") {
      const me = requireAuth(req, res); if (!me) return;
      const r = store.accountability_requests.find((x) => x.id === seg[2]);
      if (!r) return fail(res, 404, FRIENDLY.notFound);
      if (method === "GET") {
        const messages = store.messages.filter((m) => m.request_id === r.id).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((m) => ({ ...m, sender_name: (store.profiles.find((x) => x.id === m.sender_id) || {}).display_name || "Member" }));
        return send(res, 200, { messages });
      }
      if (method === "POST") {
        if (rateLimited(req, "message")) return fail(res, 429, "You're replying very fast. Please wait a moment and try again.");
        const text = clean(body.body, 1000);
        if (!text) return fail(res, 400, "Write a reply first.");
        const m = insert("messages", { request_id: r.id, sender_id: me.id, body: text });
        return send(res, 201, { message: m });
      }
    }
    if (seg[1] === "matches" && method === "PATCH") {
      const me = requireAuth(req, res); if (!me) return;
      const m = store.matches.find((x) => x.id === seg[2]);
      if (!m || (m.partner_id !== me.id && m.requester_id !== me.id)) return fail(res, 404, FRIENDLY.notFound);
      if (!["completed", "released", "no_show"].includes(body.status)) return fail(res, 400, "Pick completed, released, or no-show.");
      m.status = body.status; m.completed_at = body.status === "completed" ? now() : null; update("matches", m);
      const r = store.accountability_requests.find((x) => x.id === m.request_id);
      if (r && body.status === "released") { r.status = "open"; update("accountability_requests", r); }
      if (r && body.status === "completed") { r.status = "completed"; update("accountability_requests", r); }
      const ev = store.calendar_events.find((x) => x.match_id === m.id);
      if (ev) { ev.status = body.status === "released" ? "cancelled" : body.status; update("calendar_events", ev); }
      return send(res, 200, { match: m });
    }

    /* ----- Calendar & commitments ----- */
    if (p === "/api/calendar" && method === "GET") {
      const me = requireAuth(req, res); if (!me) return;
      const events = store.calendar_events.filter((e) => e.status === "scheduled").sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map((e) => ({ ...e, link_url: (store.accountability_requests.find((x) => x.id === e.request_id) || {}).link_url || "", requester_name: (store.profiles.find((x) => x.id === e.requester_id) || {}).display_name || "Member", partner_name: (store.profiles.find((x) => x.id === e.partner_id) || {}).display_name || "Member" }));
      return send(res, 200, { events });
    }
    if (p === "/api/commitments" && method === "GET") {
      const me = requireAuth(req, res); if (!me) return;
      const matches = store.matches.filter((m) => m.requester_id === me.id || m.partner_id === me.id).map((m) => { const r = store.accountability_requests.find((x) => x.id === m.request_id) || {}; return { ...m, request_title: r.title || "Request", scheduled_for: r.scheduled_for || "", link_url: r.link_url || "", requester_name: (store.profiles.find((x) => x.id === m.requester_id) || {}).display_name || "Member", partner_name: (store.profiles.find((x) => x.id === m.partner_id) || {}).display_name || "Member" }; });
      return send(res, 200, { matches });
    }

    /* ----- Content (public reads) ----- */
    if (p === "/api/content" && method === "GET") return send(res, 200, { content: store.content_items.filter((c) => c.is_published) });

    /* ----- Account data rights ----- */
    if (p === "/api/account/export" && method === "POST") {
      const me = requireAuth(req, res); if (!me) return;
      insert("data_requests", { user_id: me.id, kind: "export", status: "completed", completed_at: now() });
      return send(res, 200, { export: { profile: publicUser(me), requests: store.accountability_requests.filter((r) => r.requester_id === me.id), matches: store.matches.filter((m) => m.requester_id === me.id || m.partner_id === me.id), messages: store.messages.filter((m) => m.sender_id === me.id), calendar_events: store.calendar_events.filter((e) => e.requester_id === me.id || e.partner_id === me.id) } });
    }
    if (p === "/api/account" && method === "DELETE") {
      const me = requireAuth(req, res); if (!me) return;
      insert("data_requests", { user_id: me.id, kind: "delete", status: "completed", completed_at: now() });
      store.messages = store.messages.filter((m) => m.sender_id !== me.id); save("messages");
      store.calendar_events = store.calendar_events.filter((e) => e.requester_id !== me.id && e.partner_id !== me.id); save("calendar_events");
      store.matches = store.matches.filter((m) => m.requester_id !== me.id && m.partner_id !== me.id); save("matches");
      store.accountability_requests = store.accountability_requests.filter((r) => r.requester_id !== me.id); save("accountability_requests");
      store.sessions = store.sessions.filter((s) => s.user_id !== me.id); save("sessions");
      store.credentials = store.credentials.filter((c) => c.user_id !== me.id); save("credentials");
      store.user_roles = store.user_roles.filter((r) => r.user_id !== me.id); save("user_roles");
      store.profiles = store.profiles.filter((x) => x.id !== me.id); save("profiles");
      return send(res, 200, { ok: true });
    }

    /* ----- Admin (owner only, server-checked) ----- */
    if (seg[1] === "admin") {
      const admin = requireAdmin(req, res); if (!admin) return;
      if (p === "/api/admin/overview") return send(res, 200, { overview: { memberCount: store.profiles.length, openRequests: store.accountability_requests.filter((r) => r.status === "open").length, activeMatches: store.matches.filter((m) => m.status === "active").length, adminCount: store.user_roles.filter((r) => r.role === "admin").length } });
      if (p === "/api/admin/members" && method === "GET") return send(res, 200, { members: store.profiles.map(publicUser) });
      if (p === "/api/admin/members/role" && method === "POST") {
        // Role changes can never create another admin or remove the owner's.
        return fail(res, 403, "Admin is locked to the owner account only (" + OWNER_ADMIN_EMAIL + "). Member roles can't be promoted.");
      }
      if (p === "/api/admin/invites" && method === "GET") return send(res, 200, { invites: store.invites });
      if (p === "/api/admin/invites" && method === "POST") {
        const code = crypto.randomBytes(4).toString("hex").toUpperCase();
        const inv = insert("invites", { code, created_by: admin.id, used_by: null, max_uses: 1, use_count: 0, expires_at: null, is_active: true });
        audit(admin.id, "invite_created", "invite", inv.id, code);
        return send(res, 201, { invite: inv });
      }
      if (p === "/api/admin/content" && method === "GET") return send(res, 200, { content: store.content_items });
      if (seg[2] === "content" && method === "PUT") {
        const c = store.content_items.find((x) => x.id === seg[3]);
        if (!c) return fail(res, 404, FRIENDLY.notFound);
        c.title = clean(body.title, 160) || c.title; c.body = clean(body.body, 8000) || c.body; c.is_published = body.is_published !== false; c.updated_by = admin.id; update("content_items", c);
        audit(admin.id, "content_updated", "content_item", c.id, c.slug);
        return send(res, 200, { content: c });
      }
      if (p === "/api/admin/integrations" && method === "GET") {
        // Status only. Whether a provider counts as connected is read from
        // environment variables — secrets themselves are never returned.
        const envMap = { zoom: "ZOOM_ACCOUNT_ID", google_calendar: "GOOGLE_CALENDAR_ID", email: "EMAIL_FROM" };
        const integrations = store.integration_connections.map((i) => ({ ...i, status: process.env[envMap[i.provider]] ? "connected" : i.status, last_checked_at: now() }));
        return send(res, 200, { integrations });
      }
      if (p === "/api/admin/audit" && method === "GET") return send(res, 200, { audit: store.audit_log.slice().reverse().slice(0, 200) });
      return fail(res, 404, FRIENDLY.notFound);
    }

    return fail(res, 404, FRIENDLY.notFound);
  } catch (err) {
    console.error(err); // server log only — clients always get the friendly line
    return fail(res, 500, FRIENDLY.server);
  }
});

server.listen(PORT, () => { console.log("Accountability App backend listening on http://localhost:" + PORT); });
