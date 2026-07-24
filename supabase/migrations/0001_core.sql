-- Nightjar core schema: profiles, sites, nodes, cameras, events, clips,
-- subscriptions (phase-2 stub), notification settings.
-- Auth model:
--   * Humans sign in via Supabase Auth (JWT sub = auth.users.id).
--   * Nodes authenticate via the node-token edge function, which mints a JWT
--     with app_metadata.node_id. RLS distinguishes the two.

create extension if not exists pg_cron;

-- ---------- helpers ----------

create or replace function public.jwt_node_id()
returns uuid
language sql stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'node_id',
      ''
    ),
    ''
  )::uuid
$$;

-- ---------- tables ----------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null default 'Home',
  created_at timestamptz not null default now()
);

create table public.nodes (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references public.sites (id) on delete set null,
  name text not null default 'nightjar-node',
  claim_code text unique,
  claim_code_expires_at timestamptz,
  node_secret_hash text not null,
  status text not null default 'unclaimed'
    check (status in ('unclaimed', 'online', 'offline')),
  last_seen_at timestamptz,
  version text,
  created_at timestamptz not null default now()
);

create table public.cameras (
  id uuid primary key,
  node_id uuid not null references public.nodes (id) on delete cascade,
  name text not null,
  make text,
  model text,
  capabilities jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key,
  node_id uuid not null references public.nodes (id) on delete cascade,
  camera_id uuid not null references public.cameras (id) on delete cascade,
  kind text not null check (kind in ('motion', 'person', 'vehicle', 'animal', 'package')),
  score real not null default 0,
  started_at timestamptz not null,
  ended_at timestamptz,
  clip_status text not null default 'local'
    check (clip_status in ('local', 'uploading', 'uploaded', 'expired')),
  thumbnail_path text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index events_camera_started_idx on public.events (camera_id, started_at desc);
create index events_node_started_idx on public.events (node_id, started_at desc);

create table public.event_clips (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references public.events (id) on delete cascade,
  storage_path text not null,
  bytes bigint,
  duration_s real,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'plus', 'pro')),
  status text not null default 'active',
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now()
);

create table public.notification_settings (
  user_id uuid not null references public.profiles (id) on delete cascade,
  camera_id uuid references public.cameras (id) on delete cascade,
  kinds text[] not null default '{person,package}',
  channels jsonb not null default '{"push": true, "email": false}',
  muted_until timestamptz,
  primary key (user_id, camera_id)
);

-- auto-create profile + free subscription on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));
  insert into public.subscriptions (owner_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- ownership helper ----------

create or replace function public.user_owns_node(p_node_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.nodes n
    join public.sites s on s.id = n.site_id
    where n.id = p_node_id and s.owner_id = auth.uid()
  )
$$;

-- ---------- RLS ----------

alter table public.profiles enable row level security;
alter table public.sites enable row level security;
alter table public.nodes enable row level security;
alter table public.cameras enable row level security;
alter table public.events enable row level security;
alter table public.event_clips enable row level security;
alter table public.subscriptions enable row level security;
alter table public.notification_settings enable row level security;

create policy "own profile" on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy "own sites" on public.sites
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- nodes: owners read/update/delete claimed nodes; node JWT updates its own row.
create policy "owner reads nodes" on public.nodes
  for select using (public.user_owns_node(id));
create policy "owner updates nodes" on public.nodes
  for update using (public.user_owns_node(id));
create policy "owner deletes nodes" on public.nodes
  for delete using (public.user_owns_node(id));
create policy "node updates itself" on public.nodes
  for update using (id = public.jwt_node_id()) with check (id = public.jwt_node_id());
create policy "node reads itself" on public.nodes
  for select using (id = public.jwt_node_id());

create policy "owner reads cameras" on public.cameras
  for select using (public.user_owns_node(node_id));
create policy "owner updates cameras" on public.cameras
  for update using (public.user_owns_node(node_id));
create policy "node manages own cameras" on public.cameras
  for all using (node_id = public.jwt_node_id()) with check (node_id = public.jwt_node_id());

create policy "owner reads events" on public.events
  for select using (public.user_owns_node(node_id));
create policy "owner deletes events" on public.events
  for delete using (public.user_owns_node(node_id));
create policy "node writes own events" on public.events
  for all using (node_id = public.jwt_node_id()) with check (node_id = public.jwt_node_id());

create policy "owner reads clips" on public.event_clips
  for select using (
    exists (
      select 1 from public.events e
      where e.id = event_id and public.user_owns_node(e.node_id)
    )
  );
create policy "node writes own clips" on public.event_clips
  for all using (
    exists (select 1 from public.events e where e.id = event_id and e.node_id = public.jwt_node_id())
  ) with check (
    exists (select 1 from public.events e where e.id = event_id and e.node_id = public.jwt_node_id())
  );

create policy "own subscription" on public.subscriptions
  for select using (owner_id = auth.uid());

create policy "own notification settings" on public.notification_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- realtime: private channel node:{id} ----------

create policy "channel access for owner or node"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.topic() like 'node:%'
    and (
      public.user_owns_node(split_part(realtime.topic(), ':', 2)::uuid)
      or split_part(realtime.topic(), ':', 2)::uuid = public.jwt_node_id()
    )
  );

create policy "channel write for owner or node"
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.topic() like 'node:%'
    and (
      public.user_owns_node(split_part(realtime.topic(), ':', 2)::uuid)
      or split_part(realtime.topic(), ':', 2)::uuid = public.jwt_node_id()
    )
  );

-- ---------- storage ----------

insert into storage.buckets (id, name, public)
values ('event-clips', 'event-clips', false), ('snapshots', 'snapshots', false)
on conflict (id) do nothing;

-- paths: {node_id}/{event_id}/clip.mp4 | thumb.jpg  and  {node_id}/snapshot-*.jpg
create policy "node writes own prefix" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('event-clips', 'snapshots')
    and split_part(name, '/', 1)::uuid = public.jwt_node_id()
  );

create policy "owner reads own nodes' objects" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('event-clips', 'snapshots')
    and public.user_owns_node(split_part(name, '/', 1)::uuid)
  );

-- ---------- retention cron ----------

-- expire clips past their window and delete expired unclaimed nodes hourly
select cron.schedule(
  'nightjar-retention',
  '17 * * * *',
  $cron$
    update public.events e set clip_status = 'expired'
    from public.event_clips c
    where c.event_id = e.id and c.expires_at < now() and e.clip_status = 'uploaded';
    delete from public.nodes
    where status = 'unclaimed' and claim_code_expires_at < now() - interval '1 day';
  $cron$
);
