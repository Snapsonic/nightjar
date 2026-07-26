-- Shareable event-clip links (roadmap #17 extended: social sharing + AI captions).
--
--   * clip_shares: one row per share link. `token` is 24 random bytes
--     (base64url) minted by the share-clip edge function; the public page at
--     https://nightjar.ca/s/<token> resolves it through the share-view edge
--     function, which runs with the service role so expiry, revocation and
--     view counting are enforced server-side.
--   * RLS: owners manage their own rows. There is deliberately NO anon
--     policy — anonymous viewers never talk to PostgREST for shares.
--
-- ORCHESTRATOR STEPS after applying:
--   1. Deploy the share-clip, share-view and caption-clip edge functions from
--      the repo root (supabase/config.toml disables JWT verification for
--      share-view — it is called by anonymous viewers).
--   2. Set the ANTHROPIC_API_KEY function secret (used by caption-clip).

create table public.clip_shares (
  id uuid primary key default gen_random_uuid(),
  token text unique not null,
  event_id uuid not null references public.events (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  caption text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  view_count int not null default 0,
  created_at timestamptz default now()
);

-- Token lookups are the hot path (every public view). The UNIQUE constraint
-- above already backs this with a btree index; the explicit index below keeps
-- the intent obvious and survives a constraint refactor.
create index clip_shares_token_idx on public.clip_shares (token);
-- "Manage links" lists a user's shares for one event.
create index clip_shares_event_owner_idx on public.clip_shares (event_id, owner_id);

alter table public.clip_shares enable row level security;

create policy "own clip shares" on public.clip_shares
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Prune shares that have been expired for more than 30 days. Expired-but-not-
-- yet-pruned rows are kept so the owner's "Manage links" history stays useful
-- for a while; share-view rejects them regardless.
select cron.schedule(
  'nightjar-clip-share-prune',
  '37 4 * * *',
  $cron$
    delete from public.clip_shares where expires_at < now() - interval '30 days';
  $cron$
);
