-- Web Push notifications (roadmap #5).
--
--   * push_subscriptions: one row per browser push endpoint, owned by a user.
--   * notification_deliveries: log of sent pushes, used for the per
--     (user, camera, kind) cooldown in the notify edge function.
--   * AFTER INSERT trigger on public.events -> pg_net http_post to the
--     `notify` edge function, authenticated with a shared hook secret kept in
--     private.app_config (NOT in this migration — see below).
--
-- ORCHESTRATOR STEPS after applying:
--   1. update private.app_config set value = '<real NOTIFY_HOOK_SECRET>'
--      where key = 'notify_hook_secret';
--   2. Deploy the notify edge function with verify_jwt disabled
--      (supabase/config.toml [functions.notify]).

-- ---------- push_subscriptions ----------

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

create policy "own push subscriptions" on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- notification_deliveries ----------

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  camera_id uuid not null references public.cameras (id) on delete cascade,
  kind text not null,
  sent_at timestamptz not null default now()
);
create index notification_deliveries_cooldown_idx
  on public.notification_deliveries (user_id, camera_id, kind, sent_at desc);

alter table public.notification_deliveries enable row level security;

-- Owners may read their delivery log; writes happen with the service role
-- (edge function), which bypasses RLS.
create policy "own deliveries" on public.notification_deliveries
  for select using (user_id = auth.uid());

-- ---------- private config (hook secret) ----------

-- The DB->function hook secret cannot live in this migration in plaintext.
-- It lives in a private-schema table with no grants to client roles; the
-- orchestrator replaces the placeholder value after applying (step 1 above).
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.app_config (
  key text primary key,
  value text not null
);
revoke all on private.app_config from public, anon, authenticated;

insert into private.app_config (key, value)
values ('notify_hook_secret', 'CHANGE_ME')
on conflict (key) do nothing;

-- ---------- event -> notify trigger via pg_net ----------

-- pg_net installs its API into the `net` schema regardless of the extension
-- schema; async queue, so http_post never blocks the inserting transaction.
create extension if not exists pg_net with schema extensions;

create or replace function public.notify_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook_secret text;
begin
  select value into hook_secret
  from private.app_config
  where key = 'notify_hook_secret';

  -- Not configured yet (placeholder from the migration) — skip silently.
  if hook_secret is null or hook_secret = 'CHANGE_ME' then
    return new;
  end if;

  begin
    -- Project ref hardcoded for now: single production project; revisit if we
    -- ever run more than one environment off these migrations.
    perform net.http_post(
      url := 'https://vxjfhzkcneejnxxjedyu.supabase.co/functions/v1/notify',
      body := jsonb_build_object('event', to_jsonb(new)),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-nightjar-hook', hook_secret
      )
    );
  exception when others then
    -- Never let notification plumbing break event ingestion.
    raise warning 'notify_event failed: %', sqlerrm;
  end;

  return new;
end;
$$;

create trigger events_notify
  after insert on public.events
  for each row execute function public.notify_event();

-- ---------- retention ----------

-- Prune delivery log (only needed for the 5-minute cooldown) and push
-- subscriptions that have not received a successful push in 180 days
-- (the notify function bumps last_used_at on every successful send).
select cron.schedule(
  'nightjar-push-prune',
  '41 3 * * *',
  $cron$
    delete from public.notification_deliveries where sent_at < now() - interval '7 days';
    delete from public.push_subscriptions where last_used_at < now() - interval '180 days';
  $cron$
);
