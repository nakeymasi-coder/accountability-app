-- =====================================================================
-- Accountability App — production database schema (Supabase / Postgres)
-- Matches the Node demo backend (server/server.js) tables 1:1.
-- Every table has created_at + updated_at. Roles live in their OWN
-- table (user_roles), never on the profile. RLS is enabled on every
-- table: members see/change only their own rows; the single admin is
-- the owner account nakeymasi@gmail.com, checked server-side via
-- user_roles. Technical safeguards only — not a legal compliance claim.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- profiles ----------
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null check (char_length(display_name) between 1 and 80),
  consent_accepted_at timestamptz not null,
  marketing_email_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- credentials (password hashes only — never plain passwords) ----------
create table public.credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  password_hash text not null,
  password_salt text not null,
  password_reset_code_hash text not null default '',
  password_reset_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- sessions ----------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- user_roles (roles in their OWN table, server-checked) ----------
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('member','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, role)
);

-- ---------- invites ----------
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  created_by uuid references public.profiles(id) on delete set null,
  used_by uuid references public.profiles(id) on delete set null,
  max_uses integer not null default 1 check (max_uses >= 1),
  use_count integer not null default 0 check (use_count >= 0),
  expires_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- accountability_requests ----------
create table public.accountability_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  what_needed text not null check (char_length(what_needed) between 1 and 1000),
  partner_duties text not null check (char_length(partner_duties) between 1 and 1000),
  scheduled_for timestamptz not null,
  duration_minutes integer not null default 30 check (duration_minutes between 5 and 480),
  location_or_link text not null default '',
  status text not null default 'open' check (status in ('open','matched','completed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requester_id, title, scheduled_for)  -- duplicate-submission guard (excluding cancelled is enforced in app logic)
);

-- ---------- matches ----------
create table public.matches (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.accountability_requests(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  partner_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active','completed','released','no_show')),
  completed_at timestamptz,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (partner_id <> requester_id)
);

-- ---------- calendar_events ----------
create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.accountability_requests(id) on delete cascade,
  match_id uuid not null unique references public.matches(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  partner_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled','no_show')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

-- ---------- messages (reply thread per request) ----------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.accountability_requests(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- content_items (announcements / guides / privacy policy) ----------
create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  kind text not null check (kind in ('announcement','guide','privacy')),
  title text not null,
  body text not null,
  is_published boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- integration_connections (STATUS ONLY — secrets live in env vars) ----------
create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique check (provider in ('zoom','google_calendar','email')),
  status text not null default 'not_connected' check (status in ('not_connected','connected')),
  external_account_label text not null default '',
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- audit_log (admin actions) ----------
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  details text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- data_requests (export / delete / unsubscribe handling) ----------
create table public.data_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind in ('export','delete','unsubscribe')),
  status text not null default 'pending' check (status in ('pending','completed')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- rate_limits ----------
create table public.rate_limits (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rate_limits_key_window_idx on public.rate_limits (key, window_start);
create index messages_request_idx on public.messages (request_id, created_at);
create index calendar_events_starts_idx on public.calendar_events (starts_at);
create index requests_status_idx on public.accountability_requests (status, scheduled_for);

-- ---------- updated_at trigger ----------
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
do $$ declare t text; begin
  foreach t in array array['profiles','credentials','sessions','user_roles','invites','accountability_requests','matches','calendar_events','messages','content_items','integration_connections','audit_log','data_requests','rate_limits']
  loop execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_updated_at();', t, t); end loop;
end $$;

-- =====================================================================
-- ROW-LEVEL SECURITY — enabled on EVERY table.
-- Helper: is the current user the owner-admin? Checks user_roles on
-- the server side of the policy, and the owner email constant.
-- =====================================================================
create or replace function public.is_owner_admin() returns boolean language sql stable as $$
  select exists (
    select 1 from public.profiles p
    join public.user_roles r on r.user_id = p.id and r.role = 'admin'
    where p.id = auth.uid() and p.email = 'nakeymasi@gmail.com'
  );
$$;

alter table public.profiles enable row level security;
alter table public.credentials enable row level security;
alter table public.sessions enable row level security;
alter table public.user_roles enable row level security;
alter table public.invites enable row level security;
alter table public.accountability_requests enable row level security;
alter table public.matches enable row level security;
alter table public.calendar_events enable row level security;
alter table public.messages enable row level security;
alter table public.content_items enable row level security;
alter table public.integration_connections enable row level security;
alter table public.audit_log enable row level security;
alter table public.data_requests enable row level security;
alter table public.rate_limits enable row level security;

-- profiles: read own row (admin reads all); insert/update/delete own row only.
create policy profiles_select on public.profiles for select using (id = auth.uid() or public.is_owner_admin());
create policy profiles_insert on public.profiles for insert with check (id = auth.uid());
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_delete on public.profiles for delete using (id = auth.uid() or public.is_owner_admin());

-- credentials: owner of the row only; NOBODY reads another member's hashes. Admin: no access.
create policy credentials_all_own on public.credentials for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- sessions: own sessions only.
create policy sessions_all_own on public.sessions for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- user_roles: members read their own roles; writes are server/service-role
-- only (no client policy for insert/update/delete) so nobody can promote
-- themselves. Owner-admin grant happens in trusted server code that also
-- checks the email = 'nakeymasi@gmail.com' constant.
create policy user_roles_select on public.user_roles for select using (user_id = auth.uid() or public.is_owner_admin());

-- invites: admin creates/reads; a joining member may read one active code
-- to validate it at sign-up (enforced in server code before account creation).
create policy invites_admin on public.invites for all using (public.is_owner_admin()) with check (public.is_owner_admin());

-- accountability_requests: the community feed — any signed-in member reads
-- all requests; only the requester creates/updates/deletes their own.
create policy requests_select on public.accountability_requests for select using (auth.uid() is not null);
create policy requests_insert on public.accountability_requests for insert with check (requester_id = auth.uid());
create policy requests_update on public.accountability_requests for update using (requester_id = auth.uid() or public.is_owner_admin());
create policy requests_delete on public.accountability_requests for delete using (requester_id = auth.uid() or public.is_owner_admin());

-- matches: only the two people in the match (or admin) can read/change it.
create policy matches_select on public.matches for select using (requester_id = auth.uid() or partner_id = auth.uid() or public.is_owner_admin());
create policy matches_insert on public.matches for insert with check (partner_id = auth.uid());
create policy matches_update on public.matches for update using (requester_id = auth.uid() or partner_id = auth.uid());
create policy matches_delete on public.matches for delete using (public.is_owner_admin());

-- calendar_events: shared calendar — signed-in members read all events;
-- writes only for the two people on the event (or admin).
create policy calendar_select on public.calendar_events for select using (auth.uid() is not null);
create policy calendar_insert on public.calendar_events for insert with check (requester_id = auth.uid() or partner_id = auth.uid());
create policy calendar_update on public.calendar_events for update using (requester_id = auth.uid() or partner_id = auth.uid() or public.is_owner_admin());
create policy calendar_delete on public.calendar_events for delete using (public.is_owner_admin());

-- messages: signed-in members read a request's thread; members post as
-- themselves, edit/delete only their own messages.
create policy messages_select on public.messages for select using (auth.uid() is not null);
create policy messages_insert on public.messages for insert with check (sender_id = auth.uid());
create policy messages_update on public.messages for update using (sender_id = auth.uid());
create policy messages_delete on public.messages for delete using (sender_id = auth.uid() or public.is_owner_admin());

-- content_items: everyone reads published items; only admin writes.
create policy content_select on public.content_items for select using (is_published or public.is_owner_admin());
create policy content_write_admin on public.content_items for all using (public.is_owner_admin()) with check (public.is_owner_admin());

-- integration_connections: admin reads status; writes are admin/service only.
create policy integrations_admin on public.integration_connections for all using (public.is_owner_admin()) with check (public.is_owner_admin());

-- audit_log: admin reads; inserts happen from trusted server code only.
create policy audit_select_admin on public.audit_log for select using (public.is_owner_admin());

-- data_requests: members create/read their own; admin reads all.
create policy data_requests_select on public.data_requests for select using (user_id = auth.uid() or public.is_owner_admin());
create policy data_requests_insert on public.data_requests for insert with check (user_id = auth.uid());
create policy data_requests_update on public.data_requests for update using (public.is_owner_admin());

-- rate_limits: no client access at all (server/service-role only).
-- (No policies = default deny under RLS for anon/authenticated roles.)
