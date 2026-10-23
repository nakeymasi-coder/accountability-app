# Accountability App

Invite-only accountability app for a private community (creators, entrepreneurs, students). A member posts a **structured accountability request** — what they need accountability for, when, and exactly what their partner should do. The request posts to the community feed, another member claims it (**"I'm available"**), claiming creates a **match** and puts the commitment on the **shared Accountability Calendar**. Every request has its own reply thread, and matches can be **completed, released, or marked no-show**.

**One admin, ever:** the owner account **nakeymasi@gmail.com**. The server holds this as a constant (`OWNER_ADMIN_EMAIL`). Only that account can hold the `admin` role, no matter who signs up first, and nobody can be promoted — there is no code path that grants admin to any other account.

## What's in this repo

| File | What it is |
|---|---|
| `index.html` / `styles.css` / `app.js` | Mobile-first single-page front end (sapphire / chrome silver / pearl white, animated pill buttons, soft 3D cards). Add-to-home-screen ready via `manifest.webmanifest` + `icon.svg`. |
| `server/server.js` | Complete backend. Node **built-in http only — zero npm dependencies.** JSON file store, scrypt password hashing, sessions, rate limits, audit log. |
| `supabase/schema.sql` | Production database blueprint (Postgres/Supabase): every table, every field, foreign keys, `created_at`/`updated_at` on every table, and row-level security policies written out. Matches the Node backend's tables 1:1. |
| `server/data/` | Runtime JSON store (one file per table, created automatically). Git-ignored except `.gitkeep`. |

## Honest note about GitHub

GitHub **stores this code**, and GitHub Pages can serve the **front end** — in **Demo Mode**. Demo Mode is labeled in the app itself: with no backend connected, data is saved only in that browser (localStorage), seeded empty, and is **not shared** with the community. **Real member data only saves when the backend is hosted** (any Node host) — and for production, when the database from `supabase/schema.sql` is used. A static page alone cannot hold private community accounts.

## Run it locally

```bash
node server/server.js
# → http://localhost:8787   (serves the front end AND the /api/* backend)
```

No install step. Requires Node 18+. Open the URL, sign up — the owner email above needs no invite code; every other account needs an invite code the owner creates in **Admin → Invite codes**.

Front-end-only preview: open `index.html` from any static host (e.g. GitHub Pages). It probes `/api/health`; when nothing answers, it switches to labeled Demo Mode automatically.

## Deploy

1. **Front end:** GitHub Pages (Settings → Pages → deploy from `main`, root) — serves the app in Demo Mode, **or** skip Pages and let the Node server serve it (it already does).
2. **Backend:** run `server/server.js` on any Node host (a small VPS, Render, Railway, Fly.io, etc.). If the front end lives on a different origin, set `API_BASE` at the top of `app.js`.
3. **Production database:** run `supabase/schema.sql` in Supabase (SQL Editor) to create all tables + RLS, then point your production backend at it. The JSON store in `server/` is the simple self-hosted option and mirrors the same tables/fields.

## Data — every field that is stored

Nothing beyond this list is collected. Every table also has **`created_at`** and **`updated_at`** timestamps (listed once here, present on all rows).

### `profiles` — who a member is
`id`, `email` (unique), `display_name`, `consent_accepted_at`, `marketing_email_opt_in`
*(No role on the profile — ever. No password here.)*

### `credentials` — sign-in secrets, server-side only
`id`, `user_id` → profiles, `password_hash` (scrypt), `password_salt`, `password_reset_code_hash`, `password_reset_expires_at`
*(Plain passwords and plain reset codes are never stored. Reset codes are hashed server-side and never returned to the app.)*

### `sessions`
`id`, `user_id` → profiles, `token_hash`, `expires_at`

### `user_roles` — roles in their OWN table, checked on the server
`id`, `user_id` → profiles, `role` (`member` | `admin`)

### `invites`
`id`, `code`, `created_by` → profiles, `used_by` → profiles (nullable), `max_uses`, `use_count`, `expires_at` (nullable), `is_active`

### `accountability_requests`
`id`, `requester_id` → profiles, `title`, `what_needed` (what they need accountability for), `partner_duties` (what the partner should do), `scheduled_for`, `duration_minutes`, `location_or_link`, `status` (`open` | `matched` | `completed` | `cancelled`)

### `matches`
`id`, `request_id` → accountability_requests, `requester_id` → profiles, `partner_id` → profiles, `status` (`active` | `completed` | `released` | `no_show`), `completed_at` (nullable), `notes`

### `calendar_events`
`id`, `request_id` → accountability_requests, `match_id` → matches, `title`, `starts_at`, `ends_at`, `requester_id` → profiles, `partner_id` → profiles, `status` (`scheduled` | `completed` | `cancelled` | `no_show`)

### `messages`
`id`, `request_id` → accountability_requests, `sender_id` → profiles, `body`

### `content_items` — announcements / guides / Privacy Policy (owner-edited)
`id`, `slug`, `kind` (`announcement` | `guide` | `privacy`), `title`, `body`, `is_published`, `updated_by` → profiles

### `integration_connections` — STATUS ONLY
`id`, `provider` (`zoom` | `google_calendar` | `email`), `status` (`not_connected` | `connected`), `external_account_label`, `last_checked_at`
*(API keys and secrets are never stored here, in code, or in the front end — they live only in server environment variables.)*

### `audit_log` — every admin action
`id`, `actor_id` → profiles, `action`, `target_type`, `target_id`, `details`

### `data_requests` — export / delete / unsubscribe handling
`id`, `user_id` → profiles, `kind` (`export` | `delete` | `unsubscribe`), `status` (`pending` | `completed`), `completed_at`

### `rate_limits` — public-form protection
`id`, `key` (IP + route), `window_start`, `count`

## Who can do what (permissions summary)

| Record | Read | Create | Edit | Delete |
|---|---|---|---|---|
| Profile | Self; owner-admin reads all members | Sign-up (invite code required; owner bypasses) | Self only | Self (account deletion); owner can remove a member's account data |
| Credentials / sessions | Nobody reads another member's — server only | Server at sign-up / sign-in | Server only (password reset) | Server (sign-out, account deletion) |
| Roles | Self; owner-admin | Server only — `member` at sign-up; `admin` only for the owner email constant | **Nobody via the app** — admin is locked to the owner; no promotion path | Server only |
| Invites | Owner-admin | Owner-admin | Owner-admin | Owner-admin |
| Requests | All signed-in members (community feed) | Any signed-in member | Requester only (+ owner) | Requester only (+ owner) |
| Matches | The two people in the match (+ owner) | The claiming partner | Requester or partner (complete / release / no-show) | Owner only |
| Calendar events | All signed-in members (shared calendar) | Server, automatically on claim | The two people on the event (+ owner) | Owner only |
| Messages | All signed-in members (per-request thread) | Any signed-in member, as themselves | Sender only | Sender (+ owner) |
| Content items | Everyone reads **published** items | Owner-admin | Owner-admin (logged in audit) | Owner-admin |
| Integration connections | Owner-admin (status only) | Server-seeded | Owner-admin / server | Owner-admin |
| Audit log | Owner-admin only | Server, automatically on admin actions | Nobody | Nobody |
| Data requests | Self + owner-admin | Self (export/delete from Account tab) | Owner-admin marks completed | — |
| Rate limits | Nobody (server only) | Server | Server | Server |

Row-level rules in `supabase/schema.sql` say the same thing in SQL: RLS is enabled on every table, members only see and change their own rows (feed/calendar/thread reads are the community exceptions, limited to signed-in members), and admin checks go through `user_roles` **on the server side**.

## Security & privacy (technical safeguards)

- Server-side validation on every input (the browser checks are only a convenience).
- Row-level access on every table (see schema + table above).
- Rate limits on sign-up, sign-in, password-reset, new-request, and reply forms, plus a honeypot field bots fill and humans never see.
- Passwords: scrypt hashes with per-user salt. Sessions: hashed tokens, 30-day expiry. Reset codes: hashed, 30-minute expiry, never displayed in the app.
- Secrets: environment variables only — never in the front end, never in this repo, never in the database.
- Audit trail: invite creation and content edits (and any future admin action) are written to `audit_log`.
- Consent wording is shown at sign-up next to the Privacy Policy link; marketing email is a separate opt-in checkbox, and unsubscribing is one toggle in the Account tab.
- **Retention (a setting, not a legal claim):** account data is kept until the member deletes their account, or the owner removes it after **24 months inactive**. Members can **export or delete** their own data at any time from the Account tab.
- Errors are friendly sentences everywhere; raw technical errors never reach the screen.
- No payments, no card numbers, no health data, nothing sensitive is collected by design.
- These are technical safeguards only; this README does not claim legal compliance with any law.

## Environment variables (names only — set real values on your host, never in the repo)

| Name | Used for |
|---|---|
| `PORT` | Backend port (default 8787) |
| `ZOOM_ACCOUNT_ID` | Marks the Zoom integration "connected" in Admin (status only) |
| `GOOGLE_CALENDAR_ID` | Marks the Google Calendar integration "connected" (status only) |
| `EMAIL_FROM` | Marks the email integration "connected" / sender identity for future email sending |

## API endpoints (front end ↔ backend)

`GET /api/health` · `POST /api/auth/signup` · `POST /api/auth/signin` · `POST /api/auth/signout` · `POST /api/auth/password-reset` · `GET/PATCH /api/me` · `GET/POST /api/requests` · `POST /api/requests/:id/claim` · `GET/POST /api/requests/:id/messages` · `PATCH /api/matches/:id` · `GET /api/calendar` · `GET /api/commitments` · `GET /api/content` · `POST /api/account/export` · `DELETE /api/account` · `GET /api/admin/overview` · `GET /api/admin/members` · `GET/POST /api/admin/invites` · `GET /api/admin/content` · `PUT /api/admin/content/:id` · `GET /api/admin/integrations` · `GET /api/admin/audit`

Made for Glam's private community. One complete app: front end + back end + production schema, in this one repo.
