"use strict";
/* Accountability App — front end.
   Talks to the backend via fetch() to the /api/* endpoints below.
   If no backend answers /api/health, it switches to DEMO MODE:
   data lives in localStorage on this device only and is NOT shared. */

/* ================= CONFIG ================= */
const CONFIG = {
  API_BASE: "",            // "" = same origin. Set to your backend URL if hosted separately, e.g. "https://api.example.com"
  HEALTH_PATH: "/api/health",
  DEMO_KEY: "accountability_demo_v1",
  TOKEN_KEY: "accountability_token_v1",
};
const OWNER_ADMIN_EMAIL = "nakeymasi@gmail.com"; // display only — the server enforces this

/* ================= SMALL HELPERS ================= */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtWhen = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.remove("hidden"); setTimeout(() => t.classList.add("hidden"), 4200); }
function showError(id, msg) { const e = $(id); if (!e) return; e.textContent = msg || ""; e.classList.toggle("hidden", !msg); }
function friendly(err) { return (err && err.message) ? err.message : "Something didn't go through. Please check your connection and try again."; }

/* ================= STATE ================= */
let state = { user: null, demo: false, currentRequestId: null, requests: [], content: [] };

/* ================= API LAYER ================= */
function token() { return localStorage.getItem(CONFIG.TOKEN_KEY) || ""; }
async function api(path, options = {}) {
  const res = await fetch(CONFIG.API_BASE + path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", ...(token() ? { Authorization: "Bearer " + token() } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* keep friendly default */ }
  if (!res.ok) throw new Error(data.error || "Something didn't go through. Please try again.");
  return data;
}

/* ---- Demo store (localStorage). Seeded EMPTY except default content text. ---- */
function demoSeed() {
  return {
    profiles: [], credentials: [], sessions: [], user_roles: [], invites: [],
    accountability_requests: [], matches: [], calendar_events: [], messages: [],
    content_items: [
      { id: "c-privacy", slug: "privacy-policy", kind: "privacy", title: "Privacy Policy", body: "We store your name, email, accountability requests, replies, and calendar commitments so the app can match you with a partner. We never sell your data. Your account data is kept until you delete your account, or the owner removes it after 24 months inactive. You can export or delete your data any time from the Account tab.", is_published: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: "c-welcome", slug: "welcome", kind: "announcement", title: "Welcome", body: "Welcome to our private accountability community. Post what you're showing up for — somebody here will show up with you.", is_published: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ],
    integration_connections: [
      { id: "i-zoom", provider: "zoom", status: "not_connected", external_account_label: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: "i-gcal", provider: "google_calendar", status: "not_connected", external_account_label: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: "i-email", provider: "email", status: "not_connected", external_account_label: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ],
    audit_log: [], data_requests: [], rate_limits: [],
  };
}
function demoLoad() { try { return JSON.parse(localStorage.getItem(CONFIG.DEMO_KEY)) || demoSeed(); } catch (_) { return demoSeed(); } }
function demoSave(db) { localStorage.setItem(CONFIG.DEMO_KEY, JSON.stringify(db)); }
const uid = () => "id-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const nowISO = () => new Date().toISOString();
// Demo passwords: simple non-secure hash — DEMO ONLY, the real backend uses scrypt.
const demoHash = (pw) => { let h = 0; for (let i = 0; i < pw.length; i++) h = (h * 31 + pw.charCodeAt(i)) | 0; return "demo$" + h; };

function demoUser(db, id) { const p = db.profiles.find((x) => x.id === id); if (!p) return null; const roles = db.user_roles.filter((r) => r.user_id === id).map((r) => r.role); return { ...p, roles }; }
function demoRequireUser(db) { const t = token(); const s = db.sessions.find((x) => x.id === t); if (!s) throw new Error("Please sign in to continue."); return demoUser(db, s.user_id); }

/* Demo implementation of the exact same /api/* contract. */
async function demoApi(path, options = {}) {
  const db = demoLoad(); const method = options.method || "GET"; const body = options.body || {};
  const seg = path.split("/").filter(Boolean); // ["api", ...]
  const done = (out) => { demoSave(db); return out; };
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };

  if (path === "/api/auth/signup") {
    need(!body.website, "That signup couldn't be accepted."); // honeypot
    need(body.consent, "Please agree to the Privacy Policy so we can store your requests and match you.");
    need(body.name && body.email && body.password && body.password.length >= 8, "Please fill in your name, a valid email, and a password of at least 8 characters.");
    const email = String(body.email).trim().toLowerCase();
    need(!db.profiles.some((p) => p.email === email), "An account with that email already exists. Try signing in instead.");
    const isOwner = email === OWNER_ADMIN_EMAIL;
    if (!isOwner) {
      const inv = db.invites.find((i) => i.code === String(body.inviteCode || "").trim().toUpperCase() && i.is_active && (!i.expires_at || new Date(i.expires_at) > new Date()) && i.use_count < i.max_uses);
      need(inv, "That invite code didn't work. This community is invite-only — check the code or ask the owner for a fresh one.");
      inv.use_count += 1; inv.used_by = inv.used_by || null; inv.updated_at = nowISO();
      if (inv.use_count >= inv.max_uses) inv.is_active = false;
      var usedInvite = inv;
    }
    const user = { id: uid(), email, display_name: String(body.name).trim(), consent_accepted_at: nowISO(), marketing_email_opt_in: !!body.marketingOptIn, created_at: nowISO(), updated_at: nowISO() };
    db.profiles.push(user);
    if (typeof usedInvite !== "undefined" && usedInvite) usedInvite.used_by = user.id;
    db.credentials.push({ id: uid(), user_id: user.id, password_hash: demoHash(body.password), password_salt: "", password_reset_code_hash: "", password_reset_expires_at: null, created_at: nowISO(), updated_at: nowISO() });
    db.user_roles.push({ id: uid(), user_id: user.id, role: "member", created_at: nowISO(), updated_at: nowISO() });
    if (isOwner) db.user_roles.push({ id: uid(), user_id: user.id, role: "admin", created_at: nowISO(), updated_at: nowISO() });
    const sess = { id: uid(), user_id: user.id, token_hash: "", expires_at: null, created_at: nowISO(), updated_at: nowISO() };
    db.sessions.push(sess); localStorage.setItem(CONFIG.TOKEN_KEY, sess.id);
    return done({ user: demoUser(db, user.id) });
  }
  if (path === "/api/auth/signin") {
    const email = String(body.email || "").trim().toLowerCase();
    const p = db.profiles.find((x) => x.email === email);
    const c = p && db.credentials.find((x) => x.user_id === p.id);
    need(p && c && c.password_hash === demoHash(String(body.password || "")), "That email and password don't match. Check them and try again.");
    const sess = { id: uid(), user_id: p.id, token_hash: "", expires_at: null, created_at: nowISO(), updated_at: nowISO() };
    db.sessions.push(sess); localStorage.setItem(CONFIG.TOKEN_KEY, sess.id);
    return done({ user: demoUser(db, p.id) });
  }
  if (path === "/api/auth/signout") { const t = token(); db.sessions = db.sessions.filter((s) => s.id !== t); localStorage.removeItem(CONFIG.TOKEN_KEY); return done({ ok: true }); }
  if (path === "/api/auth/password-reset") { return { ok: true, message: "If an account exists for that email, a reset is on its way. Codes are never shown in the app." }; }
  if (path === "/api/me" && method === "GET") return { user: demoRequireUser(db) };
  if (path === "/api/me" && method === "PATCH") { const u = demoRequireUser(db); const p = db.profiles.find((x) => x.id === u.id); if (typeof body.marketingOptIn === "boolean") { p.marketing_email_opt_in = body.marketingOptIn; p.updated_at = nowISO(); } return done({ user: demoUser(db, p.id) }); }
  if (path === "/api/requests" && method === "GET") {
    demoRequireUser(db);
    return { requests: db.accountability_requests.slice().sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for)).map((r) => ({ ...r, requester_name: (db.profiles.find((p) => p.id === r.requester_id) || {}).display_name || "Member", message_count: db.messages.filter((m) => m.request_id === r.id).length })) };
  }
  if (path === "/api/requests" && method === "POST") {
    const u = demoRequireUser(db); need(!body.website, "That post couldn't be accepted.");
    need(body.title && body.what_needed && body.partner_duties && body.scheduled_for, "Please fill in the title, what you need accountability for, what your partner should do, and the date and time.");
    const dup = db.accountability_requests.find((r) => r.requester_id === u.id && r.title === body.title && r.scheduled_for === body.scheduled_for && r.status !== "cancelled");
    need(!dup, "You already posted this exact request for that time — it's in the feed already.");
    const r = { id: uid(), requester_id: u.id, title: String(body.title).trim(), what_needed: String(body.what_needed).trim(), partner_duties: String(body.partner_duties).trim(), scheduled_for: body.scheduled_for, duration_minutes: Math.max(5, Math.min(480, Number(body.duration_minutes) || 30)), location_or_link: String(body.location_or_link || "").trim(), status: "open", created_at: nowISO(), updated_at: nowISO() };
    db.accountability_requests.push(r); return done({ request: r });
  }
  if (seg[1] === "requests" && seg[3] === "claim") {
    const u = demoRequireUser(db); const r = db.accountability_requests.find((x) => x.id === seg[2]);
    need(r, "That request isn't here anymore."); need(r.requester_id !== u.id, "You can't claim your own request — a partner has to claim it."); need(r.status === "open", "This request was already claimed.");
    const start = new Date(r.scheduled_for); const end = new Date(start.getTime() + r.duration_minutes * 60000);
    const m = { id: uid(), request_id: r.id, requester_id: r.requester_id, partner_id: u.id, status: "active", completed_at: null, notes: "", created_at: nowISO(), updated_at: nowISO() };
    db.matches.push(m); r.status = "matched"; r.updated_at = nowISO();
    db.calendar_events.push({ id: uid(), request_id: r.id, match_id: m.id, title: r.title, starts_at: start.toISOString(), ends_at: end.toISOString(), requester_id: r.requester_id, partner_id: u.id, status: "scheduled", created_at: nowISO(), updated_at: nowISO() });
    return done({ match: m });
  }
  if (seg[1] === "requests" && seg[3] === "messages" && method === "GET") { demoRequireUser(db); return { messages: db.messages.filter((m) => m.request_id === seg[2]).map((m) => ({ ...m, sender_name: (db.profiles.find((p) => p.id === m.sender_id) || {}).display_name || "Member" })) }; }
  if (seg[1] === "requests" && seg[3] === "messages" && method === "POST") {
    const u = demoRequireUser(db); need(body.body && String(body.body).trim(), "Write a reply first.");
    const m = { id: uid(), request_id: seg[2], sender_id: u.id, body: String(body.body).trim(), created_at: nowISO(), updated_at: nowISO() };
    db.messages.push(m); return done({ message: m });
  }
  if (seg[1] === "matches" && method === "PATCH") {
    const u = demoRequireUser(db); const m = db.matches.find((x) => x.id === seg[2]);
    need(m && (m.partner_id === u.id || m.requester_id === u.id), "That commitment isn't yours to change.");
    need(["completed", "released", "no_show"].includes(body.status), "Pick completed, released, or no-show.");
    m.status = body.status; m.completed_at = body.status === "completed" ? nowISO() : null; m.updated_at = nowISO();
    const r = db.accountability_requests.find((x) => x.id === m.request_id); if (r && body.status === "released") { r.status = "open"; r.updated_at = nowISO(); }
    const ev = db.calendar_events.find((x) => x.match_id === m.id); if (ev) { ev.status = body.status === "released" ? "cancelled" : body.status; ev.updated_at = nowISO(); }
    return done({ match: m });
  }
  if (path === "/api/calendar") { demoRequireUser(db); return { events: db.calendar_events.filter((e) => e.status === "scheduled").sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map((e) => ({ ...e, requester_name: (db.profiles.find((p) => p.id === e.requester_id) || {}).display_name || "Member", partner_name: (db.profiles.find((p) => p.id === e.partner_id) || {}).display_name || "Member" })) }; }
  if (path === "/api/commitments") { const u = demoRequireUser(db); return { matches: db.matches.filter((m) => m.requester_id === u.id || m.partner_id === u.id).map((m) => ({ ...m, request_title: (db.accountability_requests.find((r) => r.id === m.request_id) || {}).title || "Request", scheduled_for: (db.accountability_requests.find((r) => r.id === m.request_id) || {}).scheduled_for || "", requester_name: (db.profiles.find((p) => p.id === m.requester_id) || {}).display_name || "Member", partner_name: (db.profiles.find((p) => p.id === m.partner_id) || {}).display_name || "Member" })) }; }
  if (path === "/api/content") return { content: db.content_items.filter((c) => c.is_published) };
  if (path === "/api/account/export") { const u = demoRequireUser(db); db.data_requests.push({ id: uid(), user_id: u.id, kind: "export", status: "completed", completed_at: nowISO(), created_at: nowISO(), updated_at: nowISO() }); return done({ export: { profile: u, requests: db.accountability_requests.filter((r) => r.requester_id === u.id), matches: db.matches.filter((m) => m.requester_id === u.id || m.partner_id === u.id), messages: db.messages.filter((m) => m.sender_id === u.id) } }); }
  if (path === "/api/account" && method === "DELETE") {
    const u = demoRequireUser(db);
    db.messages = db.messages.filter((m) => m.sender_id !== u.id);
    db.calendar_events = db.calendar_events.filter((e) => e.requester_id !== u.id && e.partner_id !== u.id);
    db.matches = db.matches.filter((m) => m.requester_id !== u.id && m.partner_id !== u.id);
    db.accountability_requests = db.accountability_requests.filter((r) => r.requester_id !== u.id);
    db.sessions = db.sessions.filter((s) => s.user_id !== u.id); db.credentials = db.credentials.filter((c) => c.user_id !== u.id);
    db.user_roles = db.user_roles.filter((r) => r.user_id !== u.id); db.profiles = db.profiles.filter((p) => p.id !== u.id);
    localStorage.removeItem(CONFIG.TOKEN_KEY); return done({ ok: true });
  }
  if (seg[1] === "admin") {
    const u = demoRequireUser(db); need(u.email === OWNER_ADMIN_EMAIL && u.roles.includes("admin"), "Admin is locked to the owner account only.");
    if (path === "/api/admin/overview") return { overview: { memberCount: db.profiles.length, openRequests: db.accountability_requests.filter((r) => r.status === "open").length, activeMatches: db.matches.filter((m) => m.status === "active").length, adminCount: 1 } };
    if (path === "/api/admin/members") return { members: db.profiles.map((p) => demoUser(db, p.id)) };
    if (path === "/api/admin/invites" && method === "GET") return { invites: db.invites };
    if (path === "/api/admin/invites" && method === "POST") { const inv = { id: uid(), code: Math.random().toString(36).slice(2, 8).toUpperCase(), created_by: u.id, used_by: null, max_uses: 1, use_count: 0, expires_at: null, is_active: true, created_at: nowISO(), updated_at: nowISO() }; db.invites.push(inv); db.audit_log.push({ id: uid(), actor_id: u.id, action: "invite_created", target_type: "invite", target_id: inv.id, details: inv.code, created_at: nowISO(), updated_at: nowISO() }); return done({ invite: inv }); }
    if (path === "/api/admin/content" && method === "GET") return { content: db.content_items };
    if (seg[2] === "content" && method === "PUT") { const c = db.content_items.find((x) => x.id === seg[3]); need(c, "That content isn't here."); c.title = String(body.title || c.title); c.body = String(body.body || c.body); c.is_published = body.is_published !== false; c.updated_at = nowISO(); db.audit_log.push({ id: uid(), actor_id: u.id, action: "content_updated", target_type: "content_item", target_id: c.id, details: c.slug, created_at: nowISO(), updated_at: nowISO() }); return done({ content: c }); }
    if (path === "/api/admin/integrations") return { integrations: db.integration_connections };
    if (path === "/api/admin/audit") return { audit: db.audit_log.slice().reverse() };
  }
  throw new Error("That action isn't available right now.");
}
async function call(path, options) { return state.demo ? demoApi(path, options) : api(path, options); }

/* ================= SCREENS ================= */
const SCREENS = ["auth", "feed", "new-request", "request-detail", "calendar", "commitments", "account", "admin"];
function show(name) {
  SCREENS.forEach((s) => $("screen-" + s).classList.toggle("hidden", s !== name));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  window.scrollTo({ top: 0 });
}
function setSignedInUI() {
  const signed = !!state.user;
  $("main-nav").classList.toggle("hidden", !signed);
  $("btn-signout").classList.toggle("hidden", !signed);
  $("nav-admin").classList.toggle("hidden", !(signed && state.user.roles.includes("admin")));
  if (!signed) show("auth");
}

/* ================= RENDER ================= */
function requestCard(r, mine) {
  const el = document.createElement("article"); el.className = "card3d request-card";
  el.innerHTML = `<h3>${esc(r.title)}</h3>
    <p class="meta">by ${esc(r.requester_name || "Member")} · ${esc(fmtWhen(r.scheduled_for))} · ${esc(r.duration_minutes)} min</p>
    <p>${esc(r.what_needed)}</p>
    <p><strong>Partner:</strong> ${esc(r.partner_duties)}</p>
    <p><span class="badge ${esc(r.status)}">${esc(r.status)}</span> <span class="badge">💬 ${esc(r.message_count ?? 0)} replies</span></p>`;
  const row = document.createElement("div"); row.className = "row";
  const open = document.createElement("button"); open.className = "pill-btn"; open.textContent = "Open & reply"; open.onclick = () => openRequest(r.id); row.appendChild(open);
  if (!mine && r.status === "open") { const c = document.createElement("button"); c.className = "pill-btn primary"; c.textContent = "I'm available — Claim"; c.onclick = () => claimRequest(r.id); row.appendChild(c); }
  el.appendChild(row); return el;
}
async function loadFeed() {
  const data = await call("/api/requests"); state.requests = data.requests;
  const list = $("feed-list"); list.innerHTML = "";
  state.requests.forEach((r) => list.appendChild(requestCard(r, state.user && r.requester_id === state.user.id)));
  $("feed-empty").classList.toggle("hidden", state.requests.length > 0);
  show("feed");
}
async function openRequest(id) {
  state.currentRequestId = id;
  const r = state.requests.find((x) => x.id === id) || (await call("/api/requests")).requests.find((x) => x.id === id);
  if (!r) { toast("That request isn't here anymore."); return loadFeed(); }
  $("detail-card").innerHTML = `<h3>${esc(r.title)}</h3><p class="meta">${esc(fmtWhen(r.scheduled_for))} · ${esc(r.duration_minutes)} min${r.location_or_link ? " · " + esc(r.location_or_link) : ""}</p>
    <p><strong>Needs accountability for:</strong> ${esc(r.what_needed)}</p><p><strong>Partner should:</strong> ${esc(r.partner_duties)}</p>
    <p><span class="badge ${esc(r.status)}">${esc(r.status)}</span></p>`;
  if (r.status === "open" && r.requester_id !== state.user.id) {
    const b = document.createElement("button"); b.className = "pill-btn primary big"; b.textContent = "I'm available — Claim this request";
    b.onclick = () => claimRequest(id); $("detail-card").appendChild(b);
  }
  await loadMessages(); show("request-detail");
}
async function loadMessages() {
  const data = await call(`/api/requests/${state.currentRequestId}/messages`);
  const list = $("message-list"); list.innerHTML = "";
  data.messages.forEach((m) => { const d = document.createElement("div"); d.className = "card3d"; d.style.margin = "0"; d.innerHTML = `<p><strong>${esc(m.sender_name || "Member")}</strong> <span class="muted small">${esc(fmtWhen(m.created_at))}</span></p><p>${esc(m.body)}</p>`; list.appendChild(d); });
  $("messages-empty").classList.toggle("hidden", data.messages.length > 0);
}
async function claimRequest(id) {
  try { await call(`/api/requests/${id}/claim`, { method: "POST", body: {} }); toast("You're matched! It's on the shared calendar now."); await loadFeed(); }
  catch (e) { toast(friendly(e)); }
}
async function loadCalendar() {
  const data = await call("/api/calendar"); const list = $("calendar-list"); list.innerHTML = "";
  data.events.forEach((e) => { const d = document.createElement("div"); d.className = "card3d"; d.innerHTML = `<h3>${esc(e.title)}</h3><p class="meta">${esc(fmtWhen(e.starts_at))} – ${esc(fmtWhen(e.ends_at))}</p><p>${esc(e.requester_name)} + accountability partner ${esc(e.partner_name)}</p>`; list.appendChild(d); });
  $("calendar-empty").classList.toggle("hidden", data.events.length > 0); show("calendar");
}
async function loadCommitments() {
  const data = await call("/api/commitments"); const list = $("commitments-list"); list.innerHTML = "";
  data.matches.forEach((m) => {
    const d = document.createElement("div"); d.className = "card3d";
    d.innerHTML = `<h3>${esc(m.request_title)}</h3><p class="meta">${esc(fmtWhen(m.scheduled_for))}</p><p>${esc(m.requester_name)} + ${esc(m.partner_name)} · <span class="badge">${esc(m.status)}</span></p>`;
    if (m.status === "active") { const row = document.createElement("div"); row.className = "row";
      [["completed", "Mark completed"], ["released", "Release"], ["no_show", "No-show"]].forEach(([st, label]) => { const b = document.createElement("button"); b.className = "pill-btn"; b.textContent = label; b.onclick = async () => { try { await call(`/api/matches/${m.id}`, { method: "PATCH", body: { status: st } }); toast("Updated."); loadCommitments(); } catch (e) { toast(friendly(e)); } }; row.appendChild(b); });
      d.appendChild(row); }
    list.appendChild(d);
  });
  $("commitments-empty").classList.toggle("hidden", data.matches.length > 0); show("commitments");
}
async function loadAccount() {
  const u = state.user;
  $("account-name").textContent = u.display_name; $("account-email").textContent = u.email;
  $("account-role").textContent = u.roles.includes("admin") ? "Owner · Admin" : "Member";
  $("account-marketing").checked = !!u.marketing_email_opt_in;
  const privacy = state.content.find((c) => c.slug === "privacy-policy");
  $("privacy-body").innerHTML = privacy ? `<p>${esc(privacy.body)}</p>` : "<p>Privacy Policy coming soon.</p>";
  show("account");
}
async function loadAdmin() {
  const [ov, mem, inv, con, integ, aud] = await Promise.all([
    call("/api/admin/overview"), call("/api/admin/members"), call("/api/admin/invites"),
    call("/api/admin/content"), call("/api/admin/integrations"), call("/api/admin/audit"),
  ]);
  const o = ov.overview;
  $("admin-overview").innerHTML = `<h3>Overview</h3><p>Members: <strong>${esc(o.memberCount)}</strong> · Open requests: <strong>${esc(o.openRequests)}</strong> · Active matches: <strong>${esc(o.activeMatches)}</strong> · Admins: <strong>${esc(o.adminCount)} (owner only)</strong></p><p class="muted small">Admin is locked to ${esc(OWNER_ADMIN_EMAIL)}. No other account can be promoted.</p>`;
  $("admin-members").innerHTML = mem.members.map((m) => `<p><strong>${esc(m.display_name)}</strong> — ${esc(m.email)} <span class="badge">${esc(m.roles.join(", "))}</span></p>`).join("") || "<p class='muted'>No members yet.</p>";
  $("admin-invites").innerHTML = inv.invites.map((i) => `<p><strong>${esc(i.code)}</strong> · used ${esc(i.use_count)}/${esc(i.max_uses)} · ${i.is_active ? "active" : "used up"}</p>`).join("") || "<p class='muted'>No invite codes yet.</p>";
  $("admin-content").innerHTML = "";
  con.content.forEach((c) => {
    const wrap = document.createElement("form"); wrap.className = "form";
    wrap.innerHTML = `<label>Title <input value="${esc(c.title)}"></label><label>Body <textarea rows="3">${esc(c.body)}</textarea></label>`;
    const b = document.createElement("button"); b.className = "pill-btn"; b.type = "submit"; b.textContent = "Save " + c.slug;
    wrap.appendChild(b);
    wrap.onsubmit = async (ev) => { ev.preventDefault(); try { await call(`/api/admin/content/${c.id}`, { method: "PUT", body: { title: wrap.querySelector("input").value, body: wrap.querySelector("textarea").value, is_published: true } }); toast("Saved."); refreshContent(); } catch (e) { toast(friendly(e)); } };
    $("admin-content").appendChild(wrap);
  });
  $("admin-integrations").innerHTML = integ.integrations.map((i) => `<p><strong>${esc(i.provider)}</strong> — ${esc(i.status)}${i.external_account_label ? " · " + esc(i.external_account_label) : ""}</p>`).join("");
  $("admin-audit").innerHTML = aud.audit.map((a) => `<p class="small">${esc(fmtWhen(a.created_at))} · ${esc(a.action)} · ${esc(a.target_type)} · ${esc(a.details || "")}</p>`).join("") || "<p class='muted'>No admin actions yet.</p>";
  show("admin");
}
async function refreshContent() { try { const d = await call("/api/content"); state.content = d.content; } catch (_) { /* keep prior */ } }

/* ================= EVENTS ================= */
function wire() {
  $("tab-signin").onclick = () => { $("signin-form").classList.remove("hidden"); $("signup-form").classList.add("hidden"); $("reset-form").classList.add("hidden"); $("tab-signin").classList.add("active"); $("tab-signup").classList.remove("active"); };
  $("tab-signup").onclick = () => { $("signup-form").classList.remove("hidden"); $("signin-form").classList.add("hidden"); $("reset-form").classList.add("hidden"); $("tab-signup").classList.add("active"); $("tab-signin").classList.remove("active"); };
  $("btn-forgot").onclick = () => { $("signin-form").classList.add("hidden"); $("reset-form").classList.remove("hidden"); };
  $("btn-back-signin").onclick = () => $("tab-signin").click();
  $("link-privacy").onclick = (e) => { e.preventDefault(); const p = state.content.find((c) => c.slug === "privacy-policy"); toast(p ? p.body.slice(0, 180) + "…" : "See the Privacy Policy in the Account tab after sign-up."); };

  $("signin-form").onsubmit = async (e) => { e.preventDefault(); showError("signin-error", "");
    try { const d = await call("/api/auth/signin", { method: "POST", body: { email: $("signin-email").value, password: $("signin-password").value } }); if (d.token) localStorage.setItem(CONFIG.TOKEN_KEY, d.token); state.user = d.user; setSignedInUI(); await refreshContent(); loadFeed(); }
    catch (err) { showError("signin-error", friendly(err)); } };
  $("signup-form").onsubmit = async (e) => { e.preventDefault(); showError("signup-error", "");
    try { const d = await call("/api/auth/signup", { method: "POST", body: { name: $("signup-name").value, email: $("signup-email").value, password: $("signup-password").value, inviteCode: $("signup-invite").value, consent: $("signup-consent").checked, marketingOptIn: $("signup-marketing").checked, website: $("signup-website").value } }); if (d.token) localStorage.setItem(CONFIG.TOKEN_KEY, d.token); state.user = d.user; setSignedInUI(); await refreshContent(); loadFeed(); }
    catch (err) { showError("signup-error", friendly(err)); } };
  $("reset-form").onsubmit = async (e) => { e.preventDefault();
    try { const d = await call("/api/auth/password-reset", { method: "POST", body: { email: $("reset-email").value } }); const m = $("reset-message"); m.textContent = d.message; m.classList.remove("hidden"); }
    catch (err) { toast(friendly(err)); } };
  $("btn-signout").onclick = async () => { try { await call("/api/auth/signout", { method: "POST", body: {} }); } catch (_) {} localStorage.removeItem(CONFIG.TOKEN_KEY); state.user = null; setSignedInUI(); };

  document.querySelectorAll(".nav-btn").forEach((b) => { b.onclick = () => { const n = b.dataset.nav; if (n === "feed") loadFeed(); else if (n === "calendar") loadCalendar(); else if (n === "commitments") loadCommitments(); else if (n === "account") loadAccount(); else if (n === "admin") loadAdmin().catch((e) => toast(friendly(e))); }; });
  $("btn-new-request").onclick = () => show("new-request");
  $("btn-cancel-request").onclick = () => loadFeed();
  $("btn-back-feed").onclick = () => loadFeed();
  $("request-form").onsubmit = async (e) => { e.preventDefault(); showError("request-error", "");
    try { await call("/api/requests", { method: "POST", body: { title: $("req-title").value, what_needed: $("req-what").value, partner_duties: $("req-duties").value, scheduled_for: new Date($("req-when").value).toISOString(), duration_minutes: Number($("req-duration").value), location_or_link: $("req-where").value, website: $("req-website").value } }); e.target.reset(); toast("Posted to the community feed."); loadFeed(); }
    catch (err) { showError("request-error", friendly(err)); } };
  $("message-form").onsubmit = async (e) => { e.preventDefault(); showError("message-error", "");
    try { await call(`/api/requests/${state.currentRequestId}/messages`, { method: "POST", body: { body: $("message-body").value } }); $("message-body").value = ""; await loadMessages(); const d = await call("/api/requests"); state.requests = d.requests; }
    catch (err) { showError("message-error", friendly(err)); } };

  $("account-marketing").onchange = async (e) => { try { const d = await call("/api/me", { method: "PATCH", body: { marketingOptIn: e.target.checked } }); state.user = d.user; toast(e.target.checked ? "You're subscribed to community news." : "You've unsubscribed from community news emails."); } catch (err) { toast(friendly(err)); } };
  $("btn-export").onclick = async () => { try { const d = await call("/api/account/export", { method: "POST", body: {} }); const out = $("export-output"); out.textContent = JSON.stringify(d.export, null, 2); out.classList.remove("hidden"); toast("Your data export is below — copy and save it."); } catch (err) { toast(friendly(err)); } };
  $("btn-delete-data").onclick = async () => { if (!confirm("Delete your account and all your data? This can't be undone.")) return; try { await call("/api/account", { method: "DELETE" }); localStorage.removeItem(CONFIG.TOKEN_KEY); state.user = null; setSignedInUI(); toast("Your account and data were deleted."); } catch (err) { toast(friendly(err)); } };
  $("invite-form").onsubmit = async (e) => { e.preventDefault(); try { await call("/api/admin/invites", { method: "POST", body: {} }); toast("Invite code created."); loadAdmin(); } catch (err) { toast(friendly(err)); } };
}

/* ================= BOOT ================= */
(async function init() {
  wire();
  // Decide live vs demo: probe the backend health endpoint briefly.
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(CONFIG.API_BASE + CONFIG.HEALTH_PATH, { signal: ctrl.signal }); clearTimeout(t);
    if (!res.ok) throw new Error("no backend");
    state.demo = false;
  } catch (_) { state.demo = true; }
  $("demo-banner").classList.toggle("hidden", !state.demo);
  await refreshContent();
  if (token()) {
    try { const d = await call("/api/me"); state.user = d.user; setSignedInUI(); loadFeed(); return; }
    catch (_) { localStorage.removeItem(CONFIG.TOKEN_KEY); }
  }
  setSignedInUI();
})();
