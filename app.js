"use strict";
/* Accountability App — front end.
   Talks to the backend via fetch() to the /api/* endpoints below.
   The backend is required: if /api/health does not answer, the app
   shows a "can't reach the server" banner and saves nothing. */

/* ================= CONFIG ================= */
const CONFIG = {
  API_BASE: "",            // "" = same origin. Set to your backend URL if hosted separately, e.g. "https://api.example.com"
  HEALTH_PATH: "/api/health",
  TOKEN_KEY: "accountability_token_v1",
};
const OWNER_ADMIN_EMAIL = "nakeymasi@gmail.com"; // display only — the server enforces this

/* ================= SMALL HELPERS ================= */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function linkify(text) {
  // Escape FIRST (no raw HTML can slip through), then wrap bare http/https
  // URLs in tappable links. Quotes are already escaped by esc(), so a URL
  // can never break out of the href.
  return esc(text).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
function linkPill(url) {
  if (!url) return null;
  try { if (!["http:", "https:"].includes(new URL(url).protocol)) return null; } catch (_) { return null; }
  const a = document.createElement("a");
  a.className = "pill-btn link-pill"; a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
  a.textContent = "🔗 Open link";
  return a;
}
const fmtWhen = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }); };
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.remove("hidden"); setTimeout(() => t.classList.add("hidden"), 4200); }
function showError(id, msg) { const e = $(id); if (!e) return; e.textContent = msg || ""; e.classList.toggle("hidden", !msg); }
function friendly(err) { if (err && ["TimeoutError", "AbortError"].includes(err.name)) return "The server took too long. Please try again."; return (err && err.message) ? err.message : "Something didn't go through. Please check your connection and try again."; }

/* ================= STATE ================= */
let resetToken = "";
let reminderBusy = false;
let reminders = [];
let navigationVersion = 0;
let state = { user: null, currentRequestId: null, requests: [], content: [] };

/* ================= API LAYER ================= */
function token() { return localStorage.getItem(CONFIG.TOKEN_KEY) || ""; }
async function api(path, options = {}) {
  const res = await fetch(CONFIG.API_BASE + path, {
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", ...(token() ? { Authorization: "Bearer " + token() } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* keep friendly default */ }
  if (res.status === 401 && state.user) { localStorage.removeItem(CONFIG.TOKEN_KEY); state.user = null; navigationVersion++; setSignedInUI(); }
  if (!res.ok) { const error = new Error(data.error || "Something didn't go through. Please try again."); error.status = res.status; throw error; }
  return data;
}

async function call(path, options) { return api(path, options); }

/* ================= SCREENS ================= */
const SCREENS = ["auth", "reset-confirm", "reminders", "feed", "new-request", "request-detail", "calendar", "commitments", "account", "admin"];
function show(name) {
  navigationVersion++;
  showError("global-error", "");
  SCREENS.forEach((s) => $("screen-" + s).classList.toggle("hidden", s !== name));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  window.scrollTo({ top: 0 });
}
function setSignedInUI() {
  const signed = !!state.user;
  $("main-nav").classList.toggle("hidden", !signed);
  $("btn-signout").classList.toggle("hidden", !signed);
  $("btn-reminders").classList.toggle("hidden", !signed);
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
  const names = document.createElement("p"); names.textContent = "Supporters: " + ((r.supporters || []).map(p => p.name).join(", ") || "Be the first to join"); el.appendChild(names);
  const row = document.createElement("div"); row.className = "row";
  const open = document.createElement("button"); open.className = "pill-btn"; open.textContent = "Open & reply"; open.onclick = () => openRequest(r.id).catch(e => toast(friendly(e))); row.appendChild(open);
  if (!mine && ["open", "matched"].includes(r.status) && !(r.supporters || []).some(p => p.id === state.user.id) && new Date(r.scheduled_for) > new Date()) { const c = document.createElement("button"); c.className = "pill-btn primary"; c.textContent = "I'm available — Support"; c.onclick = () => claimRequest(r.id); row.appendChild(c); }
  const lp = linkPill(r.link_url); if (lp) row.appendChild(lp);
  el.appendChild(row); return el;
}
async function loadFeed() {
  const version = ++navigationVersion;
  const data = await call("/api/requests"); if (version !== navigationVersion) return; state.requests = data.requests;
  const list = $("feed-list"); list.innerHTML = "";
  state.requests.forEach((r) => list.appendChild(requestCard(r, state.user && r.requester_id === state.user.id)));
  $("feed-empty").classList.toggle("hidden", state.requests.length > 0);
  show("feed");
}
async function openRequest(id) {
  const version = ++navigationVersion;
  state.currentRequestId = id;
  const r = (await call(`/api/requests/${id}`)).request;
  if (version !== navigationVersion) return;
  if (!r) { toast("That request isn't here anymore."); return loadFeed(); }
  $("detail-card").innerHTML = `<h3>${esc(r.title)}</h3><p class="meta">${esc(fmtWhen(r.scheduled_for))} · ${esc(r.duration_minutes)} min${r.location_or_link ? " · " + esc(r.location_or_link) : ""}</p>
    <p><strong>Needs accountability for:</strong> ${esc(r.what_needed)}</p><p><strong>Partner should:</strong> ${esc(r.partner_duties)}</p>
    <p><span class="badge ${esc(r.status)}">${esc(r.status)}</span></p>`;
  const supporters = document.createElement("p"); supporters.textContent = "Supporters: " + ((r.supporters || []).map(p => p.name).join(", ") || "No supporters yet"); $("detail-card").appendChild(supporters);
  if (["open", "matched"].includes(r.status) && r.requester_id !== state.user.id && !(r.supporters || []).some(p => p.id === state.user.id) && new Date(r.scheduled_for) > new Date()) {
    const b = document.createElement("button"); b.className = "pill-btn primary big"; b.textContent = "I'm available — Join supporters";
    b.onclick = () => claimRequest(id); $("detail-card").appendChild(b);
  }
  if (r.requester_id === state.user.id && ["open", "matched"].includes(r.status)) {
    const cancel = document.createElement("button"); cancel.className = "pill-btn"; cancel.textContent = "Cancel request";
    cancel.onclick = async () => { cancel.disabled = true; try { await call(`/api/requests/${id}`, { method: "PATCH", body: { status: "cancelled" } }); toast("Request cancelled."); await loadFeed(); } catch(e) { toast(friendly(e)); } finally { cancel.disabled = false; } };
    $("detail-card").appendChild(cancel);
  }
  const dlp = linkPill(r.link_url); if (dlp) { dlp.classList.add("big"); $("detail-card").appendChild(dlp); }
  await loadMessages(); if (version === navigationVersion) { $("message-body").value = ""; show("request-detail"); }
}
async function loadMessages() {
  const data = await call(`/api/requests/${state.currentRequestId}/messages`);
  const list = $("message-list"); list.innerHTML = "";
  data.messages.forEach((m) => { const d = document.createElement("div"); d.className = "card3d"; d.style.margin = "0"; d.innerHTML = `<p><strong>${esc(m.sender_name || "Member")}</strong> <span class="muted small">${esc(fmtWhen(m.created_at))}</span></p><p>${linkify(m.body)}</p>`; list.appendChild(d); });
  $("messages-empty").classList.toggle("hidden", data.messages.length > 0);
}
async function claimRequest(id) {
  try { await call(`/api/requests/${id}/claim`, { method: "POST", body: {} }); toast("You're supporting this request! It's on the shared calendar now."); await loadFeed(); }
  catch (e) { toast(friendly(e)); }
}
async function loadCalendar() {
  const version = ++navigationVersion;
  const data = await call("/api/calendar"); if (version !== navigationVersion) return; const list = $("calendar-list"); list.innerHTML = "";
  data.events.forEach((e) => { const d = document.createElement("div"); d.className = "card3d"; d.innerHTML = `<h3>${esc(e.title)}</h3><p class="meta">${esc(fmtWhen(e.starts_at))} – ${esc(fmtWhen(e.ends_at))}</p><p>${esc(e.requester_name)} + supporters: ${esc(e.partner_name)}</p>`; const lp = linkPill(e.link_url); if (lp) d.appendChild(lp); list.appendChild(d); });
  $("calendar-empty").classList.toggle("hidden", data.events.length > 0); show("calendar");
}
async function loadCommitments() {
  const version = ++navigationVersion;
  const data = await call("/api/commitments"); if (version !== navigationVersion) return; const list = $("commitments-list"); list.innerHTML = "";
  data.matches.forEach((m) => {
    const d = document.createElement("div"); d.className = "card3d";
    d.innerHTML = `<h3>${esc(m.request_title)}</h3><p class="meta">${esc(fmtWhen(m.scheduled_for))}</p><p>${esc(m.requester_name)} + ${esc(m.partner_name)} · <span class="badge">${esc(m.status)}</span></p>`;
    if (m.status === "active") { const row = document.createElement("div"); row.className = "row";
      [["completed", "Mark completed"], ["released", "Release"], ["no_show", "No-show"]].forEach(([st, label]) => { const b = document.createElement("button"); b.className = "pill-btn"; b.textContent = label; b.onclick = async () => { try { await call(`/api/matches/${m.id}`, { method: "PATCH", body: { status: st } }); toast("Updated."); loadCommitments(); } catch (e) { toast(friendly(e)); } }; row.appendChild(b); });
      d.appendChild(row); }
    const lp = linkPill(m.link_url); if (lp) d.appendChild(lp);
    list.appendChild(d);
  });
  $("commitments-empty").classList.toggle("hidden", data.matches.length > 0); show("commitments");
}
async function loadAccount() {
  const u = state.user;
  $("account-name").textContent = u.display_name; $("account-email").textContent = u.email;
  $("account-role").textContent = u.roles.includes("admin") ? "Owner · Admin" : "Member";
  $("account-marketing").checked = !!u.marketing_email_opt_in;
  $("account-reminders").checked = !!u.reminder_email_opt_in;
  const privacy = state.content.find((c) => c.slug === "privacy-policy");
  $("privacy-body").innerHTML = privacy ? `<p>${esc(privacy.body)}</p>` : "<p>Privacy Policy coming soon.</p>";
  const help = state.content.find((c) => c.slug === "how-it-works");
  $("help-body").textContent = "Post a request with a future time and explain what support you need. Several members can join the same request. Each supporter can track their own commitment in Mine; Calendar groups all supporters under one event. Use Open & reply to talk together, or Cancel request if your plans change.";
  show("account");
}
async function loadAdmin() {
  const version = ++navigationVersion;
  const [ov, mem, inv, con, integ, aud] = await Promise.all([
    call("/api/admin/overview"), call("/api/admin/members"), call("/api/admin/invites"),
    call("/api/admin/content"), call("/api/admin/integrations"), call("/api/admin/audit"),
  ]);
  if (version !== navigationVersion) return;
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
async function refreshReminders() {
  if (!state.user || reminderBusy) return;
  reminderBusy = true;
  try {
    const data = await call("/api/notifications");
    if (!state.user) return;
    reminders = data.notifications;
    const unread = reminders.filter(n => !n.read_at).length;
    $("btn-reminders").textContent = unread ? `Reminders (${unread})` : "Reminders";
  } finally { reminderBusy = false; }
}
async function loadReminders() {
  const version = ++navigationVersion;
  await refreshReminders();
  if (version !== navigationVersion || !state.user) return;
  const list = $("reminders-list"); list.innerHTML = "";
  reminders.forEach(n => {
    const card = document.createElement("article"); card.className = "card3d";
    card.innerHTML = `<h3>${esc(n.title)}</h3><p>${esc(fmtWhen(n.starts_at))}</p><p>${n.read_at ? "Read" : "New reminder"} · Starting within ${esc(n.stage_minutes)} minutes</p>`;
    const button = document.createElement("button"); button.className = "pill-btn"; button.textContent = "Open request";
    button.onclick = () => openRequest(n.request_id).catch(e => toast(friendly(e))); card.appendChild(button); list.appendChild(card);
  });
  $("reminders-empty").classList.toggle("hidden", reminders.length > 0);
  show("reminders");
}
async function refreshContent() { try { const d = await call("/api/content"); state.content = d.content; } catch (_) { /* keep prior */ } }

/* ================= EVENTS ================= */
function wire() {
  $("btn-reminders").onclick = () => loadReminders();
  $("btn-reminders-read").onclick = async () => { await call("/api/notifications/read", { method: "POST", body: {} }); await loadReminders(); };
  $("btn-reset-signin").onclick = () => { resetToken = ""; show("auth"); $("tab-signin").click(); };
  $("reset-confirm-form").onsubmit = async e => {
    e.preventDefault(); showError("reset-confirm-error", "");
    if (!e.target.reportValidity()) return;
    if ($("reset-new-password").value !== $("reset-repeat-password").value) { showError("reset-confirm-error", "The passwords don't match."); return; }
    try {
      await call("/api/auth/password-reset/confirm", { method: "POST", body: { resetToken, password: $("reset-new-password").value } });
      resetToken = ""; e.target.reset(); localStorage.removeItem(CONFIG.TOKEN_KEY); state.user = null; setSignedInUI(); $("tab-signin").click(); toast("Password updated. Sign in with your new password.");
    } catch(error) { showError("reset-confirm-error", friendly(error)); }
  };
  $("account-reminders").onchange = async e => {
    try { const d = await call("/api/me", { method: "PATCH", body: { reminderOptIn: e.target.checked } }); state.user = d.user; toast(e.target.checked ? "Email reminder preference saved. Emails require the community email connection." : "Reminder emails turned off."); }
    catch(error) { e.target.checked = !!state.user?.reminder_email_opt_in; toast(friendly(error)); }
  };
  $("close-privacy").onclick = () => $("privacy-dialog").close();
  $("timezone-note").textContent = "Dates and times use your device time zone: " + Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("tab-signin").onclick = () => { $("signin-form").classList.remove("hidden"); $("signup-form").classList.add("hidden"); $("reset-form").classList.add("hidden"); $("tab-signin").classList.add("active"); $("tab-signup").classList.remove("active"); };
  $("tab-signup").onclick = () => { $("signup-form").classList.remove("hidden"); $("signin-form").classList.add("hidden"); $("reset-form").classList.add("hidden"); $("tab-signup").classList.add("active"); $("tab-signin").classList.remove("active"); };
  $("btn-forgot").onclick = () => { $("signin-form").classList.add("hidden"); $("reset-form").classList.remove("hidden"); };
  $("btn-back-signin").onclick = () => $("tab-signin").click();
  $("link-privacy").onclick = (e) => { e.preventDefault(); const p = state.content.find((c) => c.slug === "privacy-policy"); $("privacy-dialog-body").textContent = p ? p.body : "Privacy policy could not load. Please refresh before signing up."; $("privacy-dialog").showModal(); };

  $("signin-form").onsubmit = async (e) => { e.preventDefault(); showError("signin-error", "");
    try { const d = await call("/api/auth/signin", { method: "POST", body: { email: $("signin-email").value, password: $("signin-password").value } }); if (d.token) localStorage.setItem(CONFIG.TOKEN_KEY, d.token); state.user = d.user; setSignedInUI(); await refreshContent(); loadFeed(); refreshReminders().catch(() => {}); }
    catch (err) { showError("signin-error", friendly(err)); } };
  $("signup-form").onsubmit = async (e) => { e.preventDefault(); showError("signup-error", "");
    try { const d = await call("/api/auth/signup", { method: "POST", body: { name: $("signup-name").value, email: $("signup-email").value, password: $("signup-password").value, inviteCode: $("signup-invite").value, consent: $("signup-consent").checked, marketingOptIn: $("signup-marketing").checked, website: $("signup-website").value } }); if (d.token) localStorage.setItem(CONFIG.TOKEN_KEY, d.token); state.user = d.user; setSignedInUI(); await refreshContent(); loadFeed(); refreshReminders().catch(() => {}); }
    catch (err) { showError("signup-error", friendly(err)); } };
  $("reset-form").onsubmit = async (e) => { e.preventDefault();
    if (!e.target.reportValidity()) return;
    $("reset-message").classList.add("hidden");
    try { const d = await call("/api/auth/password-reset", { method: "POST", body: { email: $("reset-email").value } }); const m = $("reset-message"); m.textContent = d.message; m.classList.remove("hidden"); }
    catch (err) { toast(friendly(err)); } };
  $("btn-signout").onclick = async () => { try { await call("/api/auth/signout", { method: "POST", body: {} }); } catch (_) {} localStorage.removeItem(CONFIG.TOKEN_KEY); state.user = null; navigationVersion++; $("export-output").textContent = ""; $("export-output").classList.add("hidden"); setSignedInUI(); };

  document.querySelectorAll(".nav-btn").forEach((b) => { b.onclick = () => { const n = b.dataset.nav; if (n === "feed") return loadFeed(); else if (n === "calendar") return loadCalendar(); else if (n === "commitments") return loadCommitments(); else if (n === "account") return loadAccount(); else if (n === "admin") return loadAdmin(); }; });
  $("btn-new-request").onclick = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); $("req-when").min = d.toISOString().slice(0,16); show("new-request"); };
  $("btn-cancel-request").onclick = () => loadFeed();
  $("btn-back-feed").onclick = () => loadFeed();
  $("request-form").onsubmit = async (e) => { e.preventDefault(); showError("request-error", "");
    if (!e.target.reportValidity()) return;
    const when = new Date($("req-when").value);
    if (isNaN(when) || when <= new Date()) { showError("request-error", "Choose a future date and time."); return; }
    try { await call("/api/requests", { method: "POST", body: { title: $("req-title").value, what_needed: $("req-what").value, partner_duties: $("req-duties").value, scheduled_for: new Date($("req-when").value).toISOString(), duration_minutes: Number($("req-duration").value), location_or_link: $("req-where").value, link_url: $("req-link").value, website: $("req-website").value } }); e.target.reset(); toast("Posted to the community feed."); loadFeed(); }
    catch (err) { showError("request-error", friendly(err)); } };
  $("message-form").onsubmit = async (e) => { e.preventDefault(); showError("message-error", "");
    try { await call(`/api/requests/${state.currentRequestId}/messages`, { method: "POST", body: { body: $("message-body").value } }); $("message-body").value = ""; await loadMessages(); const d = await call("/api/requests"); state.requests = d.requests; }
    catch (err) { showError("message-error", friendly(err)); } };

  $("account-marketing").onchange = async (e) => { try { const d = await call("/api/me", { method: "PATCH", body: { marketingOptIn: e.target.checked } }); state.user = d.user; toast(e.target.checked ? "You're subscribed to community news." : "You've unsubscribed from community news emails."); } catch (err) { e.target.checked = !!state.user.marketing_email_opt_in; toast(friendly(err)); } };
  $("btn-export").onclick = async () => { try { const d = await call("/api/account/export", { method: "POST", body: {} }); const out = $("export-output"); out.textContent = JSON.stringify(d.export, null, 2); out.classList.remove("hidden"); toast("Your data export is below — copy and save it."); } catch (err) { toast(friendly(err)); } };
  $("btn-delete-data").onclick = async () => { if (!confirm("Delete your account and all your data? This can't be undone.")) return; try { await call("/api/account", { method: "DELETE" }); localStorage.removeItem(CONFIG.TOKEN_KEY); state.user = null; setSignedInUI(); toast("Your account and data were deleted."); } catch (err) { toast(friendly(err)); } };
  $("invite-form").onsubmit = async (e) => { e.preventDefault(); try { await call("/api/admin/invites", { method: "POST", body: {} }); toast("Invite code created."); loadAdmin(); } catch (err) { toast(friendly(err)); } };
}

function guardHandlers() {
  document.querySelectorAll("button, form").forEach((el) => {
    const prop = el.tagName === "FORM" ? "onsubmit" : "onclick";
    const original = el[prop];
    if (!original) return;
    let busy = false;
    el[prop] = async function(event) {
      if (busy) { event.preventDefault(); return; }
      busy = true;
      const buttons = el.tagName === "FORM" ? [...el.querySelectorAll('[type="submit"]')] : [el];
      buttons.forEach(b => b.disabled = true);
      try { await original.call(this, event); }
      catch (error) { showError("global-error", friendly(error)); }
      finally { busy = false; buttons.forEach(b => b.disabled = false); }
    };
  });
}
window.addEventListener("unhandledrejection", e => { e.preventDefault(); showError("global-error", friendly(e.reason)); });
/* ================= BOOT ================= */
(async function init() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  resetToken = fragment.get("reset") || "";
  if (resetToken) history.replaceState(null, "", location.pathname + location.search);
  wire();
  guardHandlers();
  setInterval(() => { if (state.user && !document.hidden) refreshReminders().catch(() => {}); }, 60000);
  // The backend is required — probe its health endpoint briefly.
  // If it does not answer, show the server banner and save nothing.
  let serverUp = false;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(CONFIG.API_BASE + CONFIG.HEALTH_PATH, { signal: ctrl.signal }); clearTimeout(t);
    if (res.status === 401 && state.user) { localStorage.removeItem(CONFIG.TOKEN_KEY); state.user = null; navigationVersion++; setSignedInUI(); }
  if (!res.ok) throw new Error("no backend");
    serverUp = true;
  } catch (_) { serverUp = false; }
  $("server-banner").classList.toggle("hidden", serverUp);
  if (!serverUp) { setSignedInUI(); return; }
  await refreshContent();
  if (resetToken) { show("reset-confirm"); return; }
  if (token()) {
    try { const d = await call("/api/me"); state.user = d.user; setSignedInUI(); loadFeed(); refreshReminders().catch(() => {}); return; }
    catch (error) { if (error.status === 401) localStorage.removeItem(CONFIG.TOKEN_KEY); else showError("global-error", friendly(error)); }
  }
  setSignedInUI();
})();
