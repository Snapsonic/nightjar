-- Cloud storage garbage collection + server-side plan-gated retention
-- (roadmap #24 storage GC, #25 plan-gated clip retention).
--
-- The problem this fixes: nothing has ever deleted a storage object. The
-- retention cron from 0001_core only flips events.clip_status to 'expired';
-- the bytes stay in the event-clips bucket forever, and snapshots /
-- timeline-exports are only cleaned by the node, which can only do it while
-- it is online. The project fills its storage quota, uploads start 413ing and
-- the node's serial upload queue dead-letters real events.
--
-- Two halves:
--
--   1. THE CLOCK (this migration). expires_at on event_clips is now owned by
--      the database, not the node. A BEFORE INSERT OR UPDATE trigger derives
--      it from the owner's plan — free 3d, plus 30d, pro 60d — by walking
--      event -> node -> site -> profile -> subscriptions.plan, and overwrites
--      whatever the client sent. A modified/hostile node therefore cannot buy
--      itself unlimited retention by sending expires_at = null or year 2099.
--      The window is anchored to event_clips.created_at (NOT now()), so an
--      idempotent re-upsert of the same row does not slide the expiry
--      forward.
--
--   2. THE BROOM (supabase/functions/storage-gc). An hourly pg_cron job pokes
--      the storage-gc edge function through pg_net — exactly the shape of the
--      events_notify -> notify hook from 0007_push_notifications, including
--      the x-nightjar-hook shared secret out of private.app_config. The
--      function does the deleting, because only it can talk to the storage
--      API; Postgres cannot remove an object by itself.
--
-- Plan changes: the trigger only reprices a row when that row is written, so
-- an upgrade would not extend clips already uploaded. The hourly cron calls
-- public.sync_event_clip_expiry() first, which reprices every row whose
-- expires_at no longer matches its owner's current plan (both directions).
--
-- ORCHESTRATOR STEPS after applying (in this order):
--   1. update private.app_config set value = '<random 32+ byte secret>'
--      where key = 'storage_gc_hook_secret';
--      This is a SEPARATE secret from notify_hook_secret on purpose: the two
--      hooks can be rotated independently, and a leaked notify secret must
--      not hand anyone a delete button.
--   2. supabase secrets set STORAGE_GC_HOOK_SECRET=<the same value>
--      supabase secrets set STORAGE_GC_DRY_RUN=true
--   3. supabase functions deploy storage-gc   (from the repo root, so
--      config.toml's verify_jwt = false is picked up)
--   4. Validate against production WITHOUT deleting anything:
--      curl -X POST -H "x-nightjar-hook: <secret>" \
--        'https://vxjfhzkcneejnxxjedyu.supabase.co/functions/v1/storage-gc?dry_run=1'
--      Compare the JSON summary against the projection in the PR/report.
--   5. Arm it: supabase secrets set STORAGE_GC_DRY_RUN=false
--      (the cron is already scheduled by this migration and has been running
--      harmless dry runs on the hour until this point).
--
--   !! ORDERING HAZARD for the LAST section of this file (column privileges).
--   Revoking the node's INSERT/UPDATE on event_clips.expires_at makes the
--   OLD node build's upsert fail with 42501, because it still sends
--   expires_at. Deploy the updated apps/node (which no longer sends it) BEFORE
--   applying this migration, or accept a gap: the node's uploader retries with
--   backoff (up to 50 attempts, 5 min cap) so a sub-hour gap only delays
--   clips, it does not lose them. To undo just that section:
--     grant insert, update on public.event_clips to authenticated, anon;

-- ---------- plan -> retention window ----------

-- Single source of truth for the pricing page's "cloud history" numbers.
-- Pure; safe to expose (it reads nothing).
create or replace function public.clip_retention_days(p_plan text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_plan
    when 'pro' then 60
    when 'plus' then 30
    else 3            -- 'free', unknown plans, and no subscription at all
  end
$$;

comment on function public.clip_retention_days(text) is
  'Cloud clip retention window in days for a subscription plan: free 3, '
  'plus 30, pro 60. Anything unrecognised is treated as free.';

-- Retention for one event's clip, resolved through the ownership chain
-- event -> node -> site -> profile -> subscriptions. SECURITY DEFINER because
-- the caller is the node's own JWT, which cannot read sites/subscriptions.
-- Only an ACTIVE subscription buys a longer window; a lapsed pro falls back
-- to free, and so does an unclaimed node (nodes.site_id is null).
create or replace function public.event_clip_retention_days(p_event_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select public.clip_retention_days(coalesce(sub.plan, 'free'))
  from public.events e
  join public.nodes n on n.id = e.node_id
  left join public.sites s on s.id = n.site_id
  left join public.subscriptions sub
    on sub.owner_id = s.owner_id and sub.status = 'active'
  where e.id = p_event_id
$$;

comment on function public.event_clip_retention_days(uuid) is
  'Retention window in days for one event''s clip, from the owning '
  'profile''s active subscription plan. Defaults to free (3 days) when the '
  'node is unclaimed or the subscription is missing/inactive.';

-- Neither client role has any business calling this directly.
revoke execute on function public.event_clip_retention_days(uuid) from public, anon, authenticated;

-- ---------- event_clips.expires_at is owned by the database ----------

create or replace function public.set_event_clip_expiry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days int;
begin
  -- Ignore whatever the client sent. This is the whole point: expires_at is
  -- a billing artefact, and the node is not a trusted source for it.
  v_days := coalesce(public.event_clip_retention_days(new.event_id), 3);
  -- Anchored to created_at, not now(): the node upserts the same event_clips
  -- row on every upload retry, and an now()-anchored window would let a
  -- flapping upload keep a clip alive indefinitely.
  new.expires_at := coalesce(new.created_at, now()) + make_interval(days => v_days);
  return new;
end;
$$;

comment on function public.set_event_clip_expiry() is
  'BEFORE INSERT OR UPDATE trigger on event_clips: overwrites expires_at '
  'with created_at + the owner plan''s retention window.';

revoke execute on function public.set_event_clip_expiry() from public, anon, authenticated;

drop trigger if exists event_clips_set_expiry on public.event_clips;
create trigger event_clips_set_expiry
  before insert or update on public.event_clips
  for each row execute function public.set_event_clip_expiry();

-- ---------- plan-change resync ----------

-- The trigger only reprices a row when that row is written. This reprices
-- rows whose owner changed plan since the clip was uploaded, in both
-- directions, and is called at the top of the hourly GC cron. Returns the
-- number of rows repriced. The UPDATE re-fires the trigger, which computes
-- the same value — belt and braces.
create or replace function public.sync_event_clip_expiry()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.event_clips c
  set expires_at = c.created_at
    + make_interval(days => coalesce(public.event_clip_retention_days(c.event_id), 3))
  where c.expires_at is distinct from (
    c.created_at + make_interval(days => coalesce(public.event_clip_retention_days(c.event_id), 3))
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.sync_event_clip_expiry() is
  'Repriced expires_at for every event_clips row whose owner changed plan '
  'since upload. Called hourly by the nightjar-storage-gc cron.';

revoke execute on function public.sync_event_clip_expiry() from public, anon, authenticated;

-- ---------- backfill ----------

-- Every existing row currently carries whatever the node invented (a flat
-- 3 days from upload time). Reprice them all from the owner's plan. The
-- trigger above would compute the same value; spelling it out keeps the
-- migration readable and independent of trigger firing order.
update public.event_clips c
set expires_at = c.created_at
  + make_interval(days => coalesce(public.event_clip_retention_days(c.event_id), 3));

-- ---------- hourly GC cron -> storage-gc edge function ----------

-- Same shape as public.notify_event() from 0007_push_notifications: pg_net
-- fire-and-forget, secret out of private.app_config, never raise.
insert into private.app_config (key, value)
values ('storage_gc_hook_secret', 'CHANGE_ME')
on conflict (key) do nothing;

create or replace function public.run_storage_gc()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook_secret text;
begin
  select value into hook_secret
  from private.app_config
  where key = 'storage_gc_hook_secret';

  -- Not configured yet (placeholder from the migration) — skip silently, the
  -- same way notify_event() does.
  if hook_secret is null or hook_secret = 'CHANGE_ME' then
    return;
  end if;

  begin
    -- Project ref hardcoded, matching notify_event(): single production
    -- project; revisit if we ever run more than one environment off these
    -- migrations.
    perform net.http_post(
      url := 'https://vxjfhzkcneejnxxjedyu.supabase.co/functions/v1/storage-gc',
      body := jsonb_build_object('source', 'cron'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-nightjar-hook', hook_secret
      ),
      -- pg_net is async, so this only bounds how long the background worker
      -- waits for a reply; the function itself is batch-capped and returns
      -- well inside it.
      timeout_milliseconds := 120000
    );
  exception when others then
    -- GC plumbing must never take anything else down with it.
    raise warning 'run_storage_gc failed: %', sqlerrm;
  end;
end;
$$;

comment on function public.run_storage_gc() is
  'Hourly pg_net poke to the storage-gc edge function, authenticated with '
  'private.app_config''s storage_gc_hook_secret.';

revoke execute on function public.run_storage_gc() from public, anon, authenticated;

-- :23 past the hour keeps it clear of nightjar-retention (:17), which flips
-- clip_status for anything the GC has not reached yet.
select cron.schedule(
  'nightjar-storage-gc',
  '23 * * * *',
  $cron$
    select public.sync_event_clip_expiry();
    select public.run_storage_gc();
  $cron$
);

-- ---------- lock the node out of expires_at (see ORDERING HAZARD above) ----------

-- PostgreSQL has no way to subtract one column from a table-level grant, so
-- the table-level INSERT/UPDATE is dropped and re-granted column by column.
-- Every column the node actually writes is listed. Three are deliberately
-- absent:
--   * expires_at — the whole point of this section.
--   * created_at — it ANCHORS expires_at, so a client that could set it could
--     set the expiry by proxy (created_at = year 3000). The column defaults to
--     now() and the node never sends it.
--   * id — defaulted, never sent.
-- SELECT/DELETE are untouched, and RLS still applies on top of all of this.
revoke insert, update on public.event_clips from authenticated, anon;

grant insert (event_id, storage_path, bytes, duration_s, drive_url)
  on public.event_clips to authenticated;
grant update (event_id, storage_path, bytes, duration_s, drive_url)
  on public.event_clips to authenticated;

-- anon has no RLS policy on event_clips and never writes it; it keeps the
-- same column list purely so the two client roles stay symmetric and a future
-- policy change does not silently depend on a missing grant.
grant insert (event_id, storage_path, bytes, duration_s, drive_url)
  on public.event_clips to anon;
grant update (event_id, storage_path, bytes, duration_s, drive_url)
  on public.event_clips to anon;

comment on column public.event_clips.expires_at is
  'When the cloud copy of this clip may be deleted. Owned by the database: '
  'set by the event_clips_set_expiry trigger from the owner plan''s '
  'retention window (free 3d / plus 30d / pro 60d), anchored to created_at. '
  'Clients have no INSERT/UPDATE grant on this column.';
