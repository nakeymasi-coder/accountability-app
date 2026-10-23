/*
 * Accountability App — Netlify Functions backend.
 * One function implements the whole /api/* contract the front end calls
 * (netlify.toml rewrites /api/* → /.netlify/functions/api/:splat).
 *
 * Storage: Netlify Blobs, store "accountability".
 * IMPORTANT (learned on the Inner Circle app): Blobs reads lag writes by
 * ~10–60s and read-modify-write on a shared blob loses updates. So every
 * record is its OWN blob — key `rec:<table>:<id>` — writes touch only that
 * record's blob, and reads list + aggregate. There is no whole-table blob.
 *
 * Secrets: environment variables ONLY. Passwords are scrypt-hashed
 * (node:crypto); session tokens and password-reset codes are stored only
 * as hashes. Reset codes are never returned to the client.
 */
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { emailConfigured, sendAccountabilityEmail } from "../../server/lib/email.mjs";
import { createReminders } from "../../server/lib/reminders.mjs";

const OWNER_ADMIN_EMAIL = "nakeymasi@gmail.com"; // the ONLY account that can ever be admin
const STORE_NAME = "accountability";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const RESET_TTL_MS = 1000 * 60 * 30; // 30 minutes
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 }; // per IP+route on public forms

const TABLES = [
  "profiles", "credentials", "sessions", "user_roles", "invites",
  "accountability_requests", "matches", "calendar_events", "messages",
  "content_items", "integration_connections", "audit_log", "data_requests", "rate_limits", "notifications", "password_resets",
];

/* ---------------- Record store (one blob per record) ---------------- */
const keyFor = (table, id) => `rec:${table}:${id}`;

class Db {
  constructor(store) {
    this.store = store;
    this.cache = new Map(); // table -> array of records (loaded lazily, per invocation)
  }
  async all(table) {
    if (this.cache.has(table)) return this.cache.get(table);
    const rows = [];
    // Read every page and fail closed on storage errors; never treat an outage as an empty database.
    for await (const page of this.store.list({ prefix: `rec:${table}:`, paginate: true })) {
      const fetched = await Promise.all(page.blobs.map(b => this.store.get(b.key, { type: "json", consistency: "strong" })));
      rows.push(...fetched.filter(Boolean));
    }
    this.cache.set(table, rows);
    return rows;
  }
  async get(table, id) {
    return this.getDirect(table, id);
  }
  /* Direct strong-consistency read of one known key — bypasses list(), whose
     lag is what made brand-new sessions invisible to requireAuth. */
  async getDirect(table, id) {
    try {
      const row = await this.store.get(keyFor(table, id), { type: "json", consistency: "strong" });
      return row || null;
    } catch (error) { throw error; }
  }
  async compareUpdate(table, id, change) {
    const key = keyFor(table, id);
    const current = await this.store.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!current) failWith(404, FRIENDLY.notFound);
    const row = change(current.data);
    row.updated_at = now();
    const result = await this.store.setJSON(key, row, { onlyIfMatch: current.etag });
    if (!result.modified) failWith(409, "Someone just updated this request. Refresh and try again.");
    this.cache.delete(table);
    return row;
  }
  async put(table, row) {
    await this.store.setJSON(keyFor(table, row.id), row);
    const rows = await this.all(table);
    const i = rows.findIndex((r) => r.id === row.id);
    if (i >= 0) rows[i] = row; else rows.push(row);
    return row;
  }
  async insert(table, fields) {
    const row = { id: crypto.randomUUID(), ...fields, created_at: now(), updated_at: now() };
    await this.put(table, row);
    return row;
  }
  /* Insert a row whose id is chosen by the caller (sessions use their token
     hash as id, so auth can fetch them by direct key instead of list()). */
  async insertWithId(table, fieldsWithId) {
    const row = { ...fieldsWithId, created_at: now(), updated_at: now() };
    if (!row.id) throw new Error("insertWithId requires an id");
    await this.put(table, row);
    return row;
  }
  async update(table, row) {
    row.updated_at = now();
    await this.put(table, row);
    return row;
  }
  async remove(table, id) {
    await this.store.delete(keyFor(table, id));
    const rows = await this.all(table);
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) rows.splice(i, 1);
  }
  async removeWhere(table, pred) {
    const rows = await this.all(table);
    for (const r of rows.filter(pred)) await this.remove(table, r.id);
  }
}

const now = () => new Date().toISOString();

/* Seed default content + integration status rows (deterministic ids, no member data). */
async function ensureSeeded(db) {
  const content = await db.all("content_items");
  const seeds = [
    { id: "content-privacy-policy", slug: "privacy-policy", kind: "privacy", title: "Privacy Policy", body: "We store your name, email, accountability requests, replies, and calendar commitments so the app can match you with a partner. We never sell your data. Your account data is kept until you delete your account, or the owner removes it after 24 months inactive. You can export or delete your data any time from the Account tab.", is_published: true, updated_by: null },
    { id: "content-welcome", slug: "welcome", kind: "announcement", title: "Welcome", body: "Welcome to our private accountability community. Post what you're showing up for — somebody here will show up with you.", is_published: true, updated_by: null },
    { id: "content-how-it-works", slug: "how-it-works", kind: "guide", title: "How it works", body: "1) Post a request with what you need accountability for and what your partner should do. 2) A member claims it. 3) It lands on the shared calendar. 4) Show up, then mark it completed.", is_published: true, updated_by: null },
  ];
  for (const s of seeds) {
    if (!content.some((c) => c.id === s.id)) {
      const row = { ...s, created_at: now(), updated_at: now() };
      await db.put("content_items", row);
    }
  }
  const integrations = await db.all("integration_connections");
  for (const provider of ["zoom", "google_calendar", "email"]) {
    const id = "integration-" + provider;
    if (!integrations.some((i) => i.id === id)) {
      await db.put("integration_connections", { id, provider, status: "not_connected", external_account_label: "", last_checked_at: null, created_at: now(), updated_at: now() });
    }
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
  notFound: "That isn't here anymore.",
  server: "Something went wrong on our side. Please try again in a moment.",
};
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const failWith = (status, message) => { throw new HttpError(status, message); };

async function audit(db, actorId, action, targetType, targetId, details) {
  await db.insert("audit_log", { actor_id: actorId, action, target_type: targetType, target_id: targetId || null, details: details || "" });
}
async function publicUser(db, profile) {
  const roles = (await db.all("user_roles")).filter((r) => r.user_id === profile.id).map((r) => r.role);
  return { id: profile.id, email: profile.email, display_name: profile.display_name, consent_accepted_at: profile.consent_accepted_at, marketing_email_opt_in: profile.marketing_email_opt_in, reminder_email_opt_in: profile.reminder_email_opt_in === true, created_at: profile.created_at, updated_at: profile.updated_at, roles };
}
async function isOwnerAdmin(db, profile) {
  return !!profile && profile.email === OWNER_ADMIN_EMAIL &&
    (await db.all("user_roles")).some((r) => r.user_id === profile.id && r.role === "admin");
}
/* Make sure the owner account — and only the owner — holds admin.
   Runs on sign-in: strips admin from anyone else, grants it to the owner. */
async function enforceOwnerAdmin(db, profile) {
  const roles = await db.all("user_roles");
  const profiles = await db.all("profiles");
  const ownerIds = new Set(profiles.filter((p) => p.email === OWNER_ADMIN_EMAIL).map((p) => p.id));
  for (const r of roles.filter((r) => r.role === "admin" && !ownerIds.has(r.user_id))) {
    await db.remove("user_roles", r.id);
  }
  if (profile.email === OWNER_ADMIN_EMAIL && !(await db.all("user_roles")).some((r) => r.user_id === profile.id && r.role === "admin")) {
    await db.insert("user_roles", { user_id: profile.id, role: "admin" });
  }
}
async function rateLimited(db, ip, route) {
  const bucket = Math.floor(Date.now() / RATE_LIMIT.windowMs);
  const id = hashToken(`${ip}:${route}:${bucket}`);
  let row = await db.get("rate_limits", id);
  if (!row) {
    row = { id, key: `${ip}:${route}`, window_start: new Date(bucket * RATE_LIMIT.windowMs).toISOString(), count: 0, created_at: now(), updated_at: now() };
  }
  row.count += 1;
  await db.update("rate_limits", row);
  return row.count > RATE_LIMIT.max;
}
async function requireAuth(db, headers) {
  const token = (headers.authorization || "").startsWith("Bearer ") ? headers.authorization.slice(7) : "";
  if (!token) failWith(401, FRIENDLY.auth);
  const tokenHash = hashToken(token);
  // New sessions store their token hash as the row id, so try a direct
  // strong-consistency key read first (immune to list() lag). Fall back to
  // the list search for legacy sessions created before that change.
  let session = await db.getDirect("sessions", tokenHash);
  if (session && session.token_hash !== tokenHash) session = null;
  if (!session) {
    session = (await db.all("sessions")).find((s) => s.token_hash === tokenHash) || null;
  }
  if (!session || new Date(session.expires_at) <= new Date()) failWith(401, FRIENDLY.auth);
  const profile = await db.get("profiles", session.user_id);
  if (!profile) failWith(401, FRIENDLY.auth);
  return { profile, token };
}
async function requireAdmin(db, headers) {
  const { profile } = await requireAuth(db, headers);
  await enforceOwnerAdmin(db, profile);
  if (!(await isOwnerAdmin(db, profile))) {
    failWith(403, "Admin is locked to the owner account only (" + OWNER_ADMIN_EMAIL + ").");
  }
  return profile;
}

/* ---------------- Validation helpers ---------------- */
function validHttpUrl(v) {
  if (!v) return true; // empty is fine — the field is optional
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (_) { return false; }
}
/* Forgiving link handling: a member typing "zoom.us" gets "https://zoom.us",
   not a rejected post. Only genuinely unparseable links fail validHttpUrl. */
function normalizeLinkUrl(v) {
  if (!v) return v;
  return /^https?:\/\//i.test(v) ? v : "https://" + v;
}
const LINK_ERROR = "That link doesn't look right — links start with https://";

/* ---------------- Core handler ----------------
   method/path/headers/body/ip in, { status, obj } out.
   Adapters for Netlify Functions v2 (fetch) and v1 (handler) are below. */
async function handle(db, method, rawPath, headers, body, ip) {
  const p = rawPath;
  const seg = p.split("/").filter(Boolean); // ["api", ...]
  await ensureSeeded(db);

  if (p === "/api/health") return { status: 200, obj: { ok: true } };

  /* ----- Auth ----- */
  if (p === "/api/auth/signup" && method === "POST") {
    if (await rateLimited(db, ip, "signup")) failWith(429, "Too many sign-ups from here just now. Please wait a bit and try again.");
    if (body.website) failWith(400, "That signup couldn't be accepted."); // honeypot
    const name = clean(body.name, 80), email = clean(body.email, 160).toLowerCase(), password = String(body.password || "");
    if (!name || !validEmail(email)) failWith(400, "Please add your name and a valid email address.");
    if (password.length < 8) failWith(400, "Please choose a password of at least 8 characters.");
    if (body.consent !== true) failWith(400, "Please agree to the Privacy Policy so we can store your requests and match you with a partner.");
    if ((await db.all("profiles")).some((x) => x.email === email)) failWith(409, "An account with that email already exists. Try signing in instead.");
    const isOwner = email === OWNER_ADMIN_EMAIL;
    let invite = null;
    if (!isOwner) { // owner bypasses the invite requirement so she can always claim admin
      const code = clean(body.inviteCode, 40).toUpperCase();
      invite = (await db.all("invites")).find((i) => i.code === code && i.is_active && i.use_count < i.max_uses && (!i.expires_at || new Date(i.expires_at) > new Date()));
      if (!invite) failWith(403, "That invite code didn't work. This community is invite-only — check the code or ask the owner for a fresh one.");
    }
    const profile = await db.insert("profiles", { email, display_name: name, consent_accepted_at: now(), marketing_email_opt_in: body.marketingOptIn === true });
    const { salt, hash } = hashPassword(password);
    await db.insert("credentials", { user_id: profile.id, password_hash: hash, password_salt: salt, password_reset_code_hash: "", password_reset_expires_at: null });
    await db.insert("user_roles", { user_id: profile.id, role: "member" });
    if (isOwner) await db.insert("user_roles", { user_id: profile.id, role: "admin" });
    if (invite) {
      invite.use_count += 1; invite.used_by = profile.id;
      if (invite.use_count >= invite.max_uses) invite.is_active = false;
      await db.update("invites", invite);
    }
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    await db.insertWithId("sessions", { id: tokenHash, user_id: profile.id, token_hash: tokenHash, expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
    return { status: 201, obj: { user: await publicUser(db, profile), token } };
  }
  if (p === "/api/auth/signin" && method === "POST") {
    if (await rateLimited(db, ip, "signin")) failWith(429, "Too many sign-in tries just now. Please wait a bit and try again.");
    const email = clean(body.email, 160).toLowerCase(), password = String(body.password || "");
    const profile = (await db.all("profiles")).find((x) => x.email === email);
    const cred = profile && (await db.all("credentials")).find((c) => c.user_id === profile.id);
    if (!profile || !cred || !verifyPassword(password, cred.password_salt, cred.password_hash)) {
      failWith(401, "That email and password don't match. Check them and try again.");
    }
    await enforceOwnerAdmin(db, profile);
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    await db.insertWithId("sessions", { id: tokenHash, user_id: profile.id, token_hash: tokenHash, expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
    return { status: 200, obj: { user: await publicUser(db, profile), token } };
  }
  if (p === "/api/auth/signout" && method === "POST") {
    const { profile, token } = await requireAuth(db, headers);
    await db.removeWhere("sessions", (s) => s.user_id === profile.id && s.token_hash === hashToken(token));
    return { status: 200, obj: { ok: true } };
  }
  if (p === "/api/auth/password-reset" && method === "POST") {
    if (await rateLimited(db, ip, "password-reset")) failWith(429, "Too many reset requests. Please wait and try again.");
    const email = clean(body.email, 160).toLowerCase();
    if (!validEmail(email)) failWith(400, "Enter a valid email address.");
    if (!emailConfigured()) failWith(503, "Password-reset emails need the community owner's email connection. No email has been sent yet.");
    const profile = (await db.all("profiles")).find(x => x.email === email);
    if (profile) {
      const cred = (await db.all("credentials")).find(c => c.user_id === profile.id);
      if (cred) {
        const code = crypto.randomBytes(32).toString("hex");
        const reset = await db.insertWithId("password_resets", { id: hashCode(code), user_id: profile.id, credential_id: cred.id, expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(), used_at: null });
        const site = process.env.URL || "https://accountability-app-glam.netlify.app";
        const link = `${site}/#reset=${code}`;
        try { await sendAccountabilityEmail({ to: email, subject: "Reset your Accountability password", text: `You requested a password reset. Open this private link to choose a new password:\n${link}\n\nThis link expires in 30 minutes and can be used once. If you didn't request this, ignore this email.`, idempotencyKey: `password-reset/${reset.id}` }); }
        catch (_) { await db.remove("password_resets", reset.id); failWith(503, "The email service could not send your reset link. Please try again later."); }
      }
    }
    return { status: 200, obj: { ok: true, message: "If that email has an account, a reset link has been sent. Check your inbox and spam folder." } };
  }
  if (p === "/api/auth/password-reset/confirm" && method === "POST") {
    if (await rateLimited(db, ip, "reset-confirm")) failWith(429, "Too many attempts. Please wait and try again.");
    const code = String(body.resetToken || "");
    const password = String(body.password || "");
    if (!/^[a-f0-9]{64}$/.test(code)) failWith(400, "This reset link is invalid. Request a new one.");
    if (password.length < 8 || password.length > 256) failWith(400, "Choose a password between 8 and 256 characters.");
    const id = hashCode(code);
    const reset = await db.getDirect("password_resets", id);
    if (!reset || reset.used_at || new Date(reset.expires_at) <= new Date()) failWith(400, "This reset link expired or was used. Request a new one.");
    const cred = await db.getDirect("credentials", reset.credential_id);
    if (!cred) failWith(400, "This reset link is no longer valid.");
    await db.compareUpdate("password_resets", id, current => {
      if (current.used_at || new Date(current.expires_at) <= new Date()) failWith(400, "This reset link expired or was used. Request a new one.");
      return { ...current, used_at: now() };
    });
    const hashed = hashPassword(password);
    cred.password_salt = hashed.salt; cred.password_hash = hashed.hash;
    cred.password_reset_code_hash = ""; cred.password_reset_expires_at = null;
    await db.update("credentials", cred);
    await db.removeWhere("sessions", session => session.user_id === reset.user_id);
    await db.removeWhere("password_resets", row => row.user_id === reset.user_id && row.id !== id);
    return { status: 200, obj: { ok: true, message: "Password updated. Sign in with your new password." } };
  }
  if (p === "/api/notifications" && method === "GET") {
    const { profile } = await requireAuth(db, headers);
    await createReminders(db, { userId: profile.id });
    const requests = await db.all("accountability_requests");
    const matches = await db.all("matches");
    const notifications = (await db.all("notifications")).filter(n => {
      const request = requests.find(r => r.id === n.request_id);
      return n.user_id === profile.id && request && ["open", "matched"].includes(request.status) && new Date(n.starts_at) > new Date() && (request.requester_id === profile.id || matches.some(m => m.request_id === request.id && m.partner_id === profile.id && m.status === "active"));
    }).sort((a,b) => a.starts_at.localeCompare(b.starts_at));
    return { status: 200, obj: { notifications } };
  }
  if (p === "/api/notifications/read" && method === "POST") {
    const { profile } = await requireAuth(db, headers);
    for (const note of (await db.all("notifications")).filter(n => n.user_id === profile.id && !n.read_at)) { note.read_at = now(); await db.update("notifications", note); }
    return { status: 200, obj: { ok: true } };
  }

  /* ----- Me ----- */
  if (p === "/api/me" && method === "GET") {
    const { profile } = await requireAuth(db, headers);
    return { status: 200, obj: { user: await publicUser(db, profile) } };
  }
  if (p === "/api/me" && method === "PATCH") {
    const { profile } = await requireAuth(db, headers);
    if (typeof body.marketingOptIn === "boolean") { profile.marketing_email_opt_in = body.marketingOptIn; await db.update("profiles", profile); }
    if (typeof body.reminderOptIn === "boolean") { profile.reminder_email_opt_in = body.reminderOptIn; await db.update("profiles", profile); }
    if (typeof body.display_name === "string" && body.display_name.trim()) { profile.display_name = clean(body.display_name, 80); await db.update("profiles", profile); }
    return { status: 200, obj: { user: await publicUser(db, profile) } };
  }

  /* ----- Requests ----- */
  const withRequester = async (r) => {
    const profiles = await db.all("profiles");
    const messages = await db.all("messages");
    const supporters = (await db.all("matches")).filter(m => m.request_id === r.id && m.status === "active").map(m => ({ id: m.partner_id, name: (profiles.find(p => p.id === m.partner_id) || {}).display_name || "Member" }));
    return {
      supporters,
      ...r,
      status: ["open", "matched"].includes(r.status) ? (supporters.length ? "matched" : "open") : r.status,
      requester_name: (profiles.find((x) => x.id === r.requester_id) || {}).display_name || "Member",
      message_count: messages.filter((m) => m.request_id === r.id).length,
    };
  };
  if (p === "/api/requests" && method === "GET") {
    await requireAuth(db, headers);
    const requests = (await db.all("accountability_requests")).slice()
      .sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
    const out = [];
    for (const r of requests) out.push(await withRequester(r));
    return { status: 200, obj: { requests: out } };
  }
  if (p === "/api/requests" && method === "POST") {
    const { profile: me } = await requireAuth(db, headers);
    if (await rateLimited(db, ip, "new-request")) failWith(429, "You're posting a lot just now. Please wait a bit and try again.");
    if (body.website) failWith(400, "That post couldn't be accepted."); // honeypot
    const title = clean(body.title, 120), what = clean(body.what_needed, 1000), duties = clean(body.partner_duties, 1000);
    const when = new Date(body.scheduled_for || "");
    if (!title || !what || !duties || isNaN(when)) failWith(400, "Please fill in the title, what you need accountability for, what your partner should do, and a valid date and time.");
    const linkUrl = normalizeLinkUrl(clean(body.link_url, 2000));
    if (!validHttpUrl(linkUrl)) failWith(400, LINK_ERROR);
    if (when <= new Date()) failWith(400, "Choose a future date and time.");
    const duration = Number(body.duration_minutes);
    if (!Number.isInteger(duration) || duration < 5 || duration > 480) failWith(400, "Choose a whole number of minutes between 5 and 480.");
    const dup = (await db.all("accountability_requests")).find((r) => r.requester_id === me.id && r.title === title && r.scheduled_for === when.toISOString() && r.status !== "cancelled");
    if (dup) failWith(409, "You already posted this exact request for that time — it's in the feed already.");
    const r = await db.insert("accountability_requests", { requester_id: me.id, title, what_needed: what, partner_duties: duties, scheduled_for: when.toISOString(), duration_minutes: duration, location_or_link: clean(body.location_or_link, 300), link_url: linkUrl, status: "open" });
    return { status: 201, obj: { request: r } };
  }
  if (seg[1] === "requests" && seg.length === 3 && method === "GET") {
    await requireAuth(db, headers);
    const r = await db.get("accountability_requests", seg[2]);
    if (!r) failWith(404, FRIENDLY.notFound);
    return { status: 200, obj: { request: await withRequester(r) } };
  }
  if (seg[1] === "requests" && seg.length === 3 && method === "PATCH") {
    const { profile: me } = await requireAuth(db, headers);
    const r = await db.get("accountability_requests", seg[2]);
    if (!r || r.requester_id !== me.id) failWith(404, FRIENDLY.notFound);
    if (body.status !== "cancelled" || !["open", "matched"].includes(r.status)) failWith(400, "Only an open or matched request can be cancelled.");
    r.status = "cancelled"; await db.update("accountability_requests", r);
    for (const m of (await db.all("matches")).filter(m => m.request_id === r.id && m.status === "active")) { m.status = "released"; await db.update("matches", m); }
    for (const e of (await db.all("calendar_events")).filter(e => e.request_id === r.id && e.status === "scheduled")) { e.status = "cancelled"; await db.update("calendar_events", e); }
    return { status: 200, obj: { request: r } };
  }
  if (seg[1] === "requests" && seg[3] === "claim" && method === "POST") {
    const { profile: me } = await requireAuth(db, headers);
    const r = await db.get("accountability_requests", seg[2]);
    if (!r) failWith(404, FRIENDLY.notFound);
    if (r.requester_id === me.id) failWith(400, "You can't claim your own request — another member can support you.");
    if (!["open", "matched"].includes(r.status)) failWith(409, "This request is no longer accepting supporters.");
    if (new Date(r.scheduled_for) <= new Date()) failWith(400, "This request is in the past. Ask the requester to post a new time.");
    // Each supporter owns a separate record; two different people can join simultaneously.
    const existing = (await db.all("matches")).find(m => m.request_id === r.id && m.partner_id === me.id && m.status === "active");
    const id = existing?.id || hashToken(`support:${r.id}:${me.id}`);
    let match = existing || await db.get("matches", id);
    if (!match) {
      match = { id, request_id: r.id, requester_id: r.requester_id, partner_id: me.id, status: "active", completed_at: null, notes: "", created_at: now(), updated_at: now() };
      const result = await db.store.setJSON(keyFor("matches", id), match, { onlyIfNew: true });
      if (!result.modified) match = await db.getDirect("matches", id);
      db.cache.delete("matches");
    } else if (match.status !== "active") {
      match = await db.compareUpdate("matches", id, current => ({ ...current, status: "active", completed_at: null }));
    }
    const start = new Date(r.scheduled_for);
    const event = { id, request_id: r.id, match_id: id, title: r.title, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + r.duration_minutes * 60000).toISOString(), requester_id: r.requester_id, partner_id: me.id, status: "scheduled", created_at: now(), updated_at: now() };
    const previousEvent = (await db.all("calendar_events")).find(e => e.match_id === id);
    if (!previousEvent) await db.store.setJSON(keyFor("calendar_events", id), event, { onlyIfNew: true });
    else if (previousEvent.status !== "scheduled") { previousEvent.status = "scheduled"; await db.update("calendar_events", previousEvent); }
    db.cache.delete("calendar_events");
    return { status: 201, obj: { match } };
  }
  if (seg[1] === "requests" && seg[3] === "messages") {
    const { profile: me } = await requireAuth(db, headers);
    const r = await db.get("accountability_requests", seg[2]);
    if (!r) failWith(404, FRIENDLY.notFound);
    if (method === "GET") {
      const profiles = await db.all("profiles");
      const messages = (await db.all("messages")).filter((m) => m.request_id === r.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((m) => ({ ...m, sender_name: (profiles.find((x) => x.id === m.sender_id) || {}).display_name || "Member" }));
      return { status: 200, obj: { messages } };
    }
    if (method === "POST") {
      if (await rateLimited(db, ip, "message")) failWith(429, "You're replying very fast. Please wait a moment and try again.");
      const text = clean(body.body, 1000);
      if (!text) failWith(400, "Write a reply first.");
      const m = await db.insert("messages", { request_id: r.id, sender_id: me.id, body: text });
      return { status: 201, obj: { message: m } };
    }
  }
  if (seg[1] === "matches" && method === "PATCH") {
    const { profile: me } = await requireAuth(db, headers);
    const m = await db.get("matches", seg[2]);
    if (!m || (m.partner_id !== me.id && m.requester_id !== me.id)) failWith(404, FRIENDLY.notFound);
    if (!["completed", "released", "no_show"].includes(body.status)) failWith(400, "Pick completed, released, or no-show.");
    if (m.status !== "active") failWith(409, "This commitment has already been updated. Refresh Mine to see its status.");
    m.status = body.status; m.completed_at = body.status === "completed" ? now() : null;
    await db.update("matches", m);
    const r = await db.get("accountability_requests", m.request_id);
    if (r && r.status !== "cancelled") {
      const siblings = (await db.all("matches")).filter(x => x.request_id === r.id);
      const active = siblings.some(x => x.status === "active");
      r.status = active ? "matched" : siblings.some(x => x.status === "completed") ? "completed" : body.status === "no_show" ? "no_show" : "open";
      await db.update("accountability_requests", r);
    }
    const ev = (await db.all("calendar_events")).find((x) => x.match_id === m.id);
    if (ev) { ev.status = body.status === "released" ? "cancelled" : body.status; await db.update("calendar_events", ev); }
    return { status: 200, obj: { match: m } };
  }

  /* ----- Calendar & commitments ----- */
  if (p === "/api/calendar" && method === "GET") {
    await requireAuth(db, headers);
    const profiles = await db.all("profiles");
    const requests = await db.all("accountability_requests");
    const events = (await db.all("calendar_events")).filter((e) => e.status === "scheduled")
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      .map((e) => ({
        ...e,
        link_url: (requests.find((x) => x.id === e.request_id) || {}).link_url || "",
        requester_name: (profiles.find((x) => x.id === e.requester_id) || {}).display_name || "Member",
        partner_name: (profiles.find((x) => x.id === e.partner_id) || {}).display_name || "Member",
      }));
    const grouped = new Map();
    for (const e of events) {
      if (!grouped.has(e.request_id)) grouped.set(e.request_id, { ...e, supporters: [] });
      const group = grouped.get(e.request_id);
      if (!group.supporters.some(p => p.id === e.partner_id)) group.supporters.push({ id: e.partner_id, name: e.partner_name });
    }
    return { status: 200, obj: { events: [...grouped.values()].map(e => ({ ...e, partner_name: e.supporters.map(p => p.name).join(", ") })) } };
  }
  if (p === "/api/commitments" && method === "GET") {
    const { profile: me } = await requireAuth(db, headers);
    const profiles = await db.all("profiles");
    const requests = await db.all("accountability_requests");
    const matches = (await db.all("matches")).filter((m) => m.requester_id === me.id || m.partner_id === me.id)
      .map((m) => {
        const r = requests.find((x) => x.id === m.request_id) || {};
        return {
          ...m,
          request_title: r.title || "Request",
          scheduled_for: r.scheduled_for || "",
          link_url: r.link_url || "",
          requester_name: (profiles.find((x) => x.id === m.requester_id) || {}).display_name || "Member",
          partner_name: (profiles.find((x) => x.id === m.partner_id) || {}).display_name || "Member",
        };
      });
    return { status: 200, obj: { matches } };
  }

  /* ----- Content (public reads) ----- */
  if (p === "/api/content" && method === "GET") {
    return { status: 200, obj: { content: (await db.all("content_items")).filter((c) => c.is_published) } };
  }

  /* ----- Account data rights ----- */
  if (p === "/api/account/export" && method === "POST") {
    const { profile: me } = await requireAuth(db, headers);
    await db.insert("data_requests", { user_id: me.id, kind: "export", status: "completed", completed_at: now() });
    return {
      status: 200,
      obj: {
        export: {
          profile: await publicUser(db, me),
          requests: (await db.all("accountability_requests")).filter((r) => r.requester_id === me.id),
          matches: (await db.all("matches")).filter((m) => m.requester_id === me.id || m.partner_id === me.id),
          messages: (await db.all("messages")).filter((m) => m.sender_id === me.id),
          calendar_events: (await db.all("calendar_events")).filter((e) => e.requester_id === me.id || e.partner_id === me.id),
        },
      },
    };
  }
  if (p === "/api/account" && method === "DELETE") {
    const { profile: me } = await requireAuth(db, headers);
    await db.insert("data_requests", { user_id: me.id, kind: "delete", status: "completed", completed_at: now() });
    const owned = new Set((await db.all("accountability_requests")).filter(r => r.requester_id === me.id).map(r => r.id));
    // Reopen the other member's request when their partner leaves.
    for (const match of (await db.all("matches")).filter(m => m.partner_id === me.id && m.status === "active")) {
      const request = await db.get("accountability_requests", match.request_id);
      if (request && request.status === "matched") { request.status = "open"; await db.update("accountability_requests", request); }
    }
    await db.removeWhere("messages", (m) => m.sender_id === me.id || owned.has(m.request_id));
    await db.removeWhere("calendar_events", (e) => e.requester_id === me.id || e.partner_id === me.id);
    await db.removeWhere("matches", (m) => m.requester_id === me.id || m.partner_id === me.id);
    await db.removeWhere("accountability_requests", (r) => r.requester_id === me.id);
    await db.removeWhere("sessions", (s) => s.user_id === me.id);
    await db.removeWhere("notifications", n => n.user_id === me.id || owned.has(n.request_id));
    await db.removeWhere("password_resets", r => r.user_id === me.id);
    await db.removeWhere("credentials", (c) => c.user_id === me.id);
    await db.removeWhere("user_roles", (r) => r.user_id === me.id);
    await db.removeWhere("profiles", (x) => x.id === me.id);
    return { status: 200, obj: { ok: true } };
  }

  /* ----- Admin (owner only, server-checked) ----- */
  if (seg[1] === "admin") {
    const admin = await requireAdmin(db, headers);
    if (p === "/api/admin/overview") {
      return { status: 200, obj: { overview: {
        memberCount: (await db.all("profiles")).length,
        openRequests: (await db.all("accountability_requests")).filter((r) => r.status === "open").length,
        activeMatches: (await db.all("matches")).filter((m) => m.status === "active").length,
        adminCount: (await db.all("user_roles")).filter((r) => r.role === "admin").length,
      } } };
    }
    if (p === "/api/admin/members" && method === "GET") {
      const members = [];
      for (const pr of await db.all("profiles")) members.push(await publicUser(db, pr));
      return { status: 200, obj: { members } };
    }
    if (p === "/api/admin/members/role" && method === "POST") {
      // Role changes can never create another admin or remove the owner's.
      failWith(403, "Admin is locked to the owner account only (" + OWNER_ADMIN_EMAIL + "). Member roles can't be promoted.");
    }
    if (p === "/api/admin/invites" && method === "GET") return { status: 200, obj: { invites: await db.all("invites") } };
    if (p === "/api/admin/invites" && method === "POST") {
      const code = crypto.randomBytes(4).toString("hex").toUpperCase();
      const inv = await db.insert("invites", { code, created_by: admin.id, used_by: null, max_uses: 1, use_count: 0, expires_at: null, is_active: true });
      await audit(db, admin.id, "invite_created", "invite", inv.id, code);
      return { status: 201, obj: { invite: inv } };
    }
    if (p === "/api/admin/content" && method === "GET") return { status: 200, obj: { content: await db.all("content_items") } };
    if (seg[2] === "content" && method === "PUT") {
      const c = await db.get("content_items", seg[3]);
      if (!c) failWith(404, FRIENDLY.notFound);
      c.title = clean(body.title, 160) || c.title;
      c.body = clean(body.body, 8000) || c.body;
      c.is_published = body.is_published !== false;
      c.updated_by = admin.id;
      await db.update("content_items", c);
      await audit(db, admin.id, "content_updated", "content_item", c.id, c.slug);
      return { status: 200, obj: { content: c } };
    }
    if (p === "/api/admin/integrations" && method === "GET") {
      // Status only. Whether a provider counts as connected is read from
      // environment variables — secrets themselves are never returned.
      const envMap = { zoom: "ZOOM_ACCOUNT_ID", google_calendar: "GOOGLE_CALENDAR_ID", email: "EMAIL_FROM" };
      const integrations = (await db.all("integration_connections")).map((i) => ({
        ...i,
        status: i.provider === "email" ? (emailConfigured() ? "configured" : "not_connected") : process.env[envMap[i.provider]] ? "configured_not_connected" : "not_connected",
        last_checked_at: now(),
      }));
      return { status: 200, obj: { integrations } };
    }
    if (p === "/api/admin/audit" && method === "GET") {
      return { status: 200, obj: { audit: (await db.all("audit_log")).slice().reverse().slice(0, 200) } };
    }
    failWith(404, FRIENDLY.notFound);
  }

  failWith(404, FRIENDLY.notFound);
}

/* ---------------- Adapters ---------------- */
function normalizePath(pathname) {
  // After the netlify.toml rewrite the function sees
  // /.netlify/functions/api/<rest> — map that back to /api/<rest>.
  const marker = "/.netlify/functions/api";
  if (pathname.startsWith(marker)) return "/api" + pathname.slice(marker.length);
  return pathname;
}
async function run(method, pathname, headers, body, ip) {
  const db = new Db(getStore({ name: STORE_NAME, consistency: "strong" }));
  try {
    return await handle(db, method, normalizePath(pathname), headers, body || {}, ip || "unknown");
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, obj: { error: err.message } };
    console.error(err); // server log only — clients always get the friendly line
    return { status: 500, obj: { error: FRIENDLY.server } };
  }
}

/* Netlify Functions v2 (fetch-style). */
export default async function handlerV2(req) {
  const url = new URL(req.url);
  let body = {};
  if (!["GET", "HEAD"].includes(req.method)) {
    try { body = await req.json(); } catch (_) { body = {}; }
  }
  const headers = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const ip = headers["x-nf-client-connection-ip"] || (headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const { status, obj } = await run(req.method, url.pathname, headers, body, ip);
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

/* Netlify Functions v1 (Lambda-style) — same core. */
export async function handler(event) {
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) { body = {}; }
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;
  const ip = headers["x-nf-client-connection-ip"] || (headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const { status, obj } = await run(event.httpMethod || "GET", event.path || "/", headers, body, ip);
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: JSON.stringify(obj) };
}

export { Db };
