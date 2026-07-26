-- Clip links in alerts (follow-up to 0010_notification_channels and
-- 0011_clip_shares): an SMS/email alert should carry a tappable link to watch
-- the clip instead of only pointing at app.nightjar.ca/events.
--
--   * event_clips.drive_url: the "anyone with the link" Google Drive URL for
--     the backed-up clip, written by the node's gdrive uploader (the existing
--     "node writes own clips" policy from 0001_core already covers this
--     column — it is scoped to the whole row, not a column list). NULL for
--     every clip that was not backed up with link sharing turned on.
--   * notification_settings.channels gains two keys in the default:
--       clip_links  boolean  — include a clip link in alerts (default true)
--       link_source 'nightjar' | 'drive' — which link to use (default nightjar)
--     Rows written before this migration keep their existing jsonb; notify
--     treats a missing clip_links as TRUE (opt-out) and a missing/unknown
--     link_source as 'nightjar'.
--
-- The Nightjar link is a normal clip_shares row (0011) minted inline by the
-- notify function with the service role: 7-day expiry, caption null. It is
-- therefore expiring AND revocable from "Manage links", so a leaked text
-- ages out on its own.
--
-- ORCHESTRATOR STEPS after applying:
--   1. Redeploy the notify edge function (`supabase functions deploy notify`
--      from the repo root so config.toml's verify_jwt = false is picked up).
--      No new function secrets are required.
--   2. Regenerate packages/db types if you prefer generated over hand-edited
--      (`supabase gen types typescript --linked > packages/db/src/database.types.ts`);
--      this migration ships the equivalent hand edit already.

-- ---------- event_clips: opt-in Google Drive share URL ----------

alter table public.event_clips
  add column if not exists drive_url text;

comment on column public.event_clips.drive_url is
  'Anyone-with-the-link Google Drive URL for the backed-up clip, written by '
  'the owning node when backup.gdrive.shareLinks is on; null otherwise.';

-- The settings UI asks "does this user have any Drive-backed clip yet?" to
-- decide whether the Drive link option is selectable. Partial index so that
-- existence probe stays cheap as event_clips grows.
create index if not exists event_clips_drive_url_idx
  on public.event_clips (event_id)
  where drive_url is not null;

-- ---------- notification_settings: clip-link preferences ----------

alter table public.notification_settings
  alter column channels set default
    '{"push": true, "email": false, "sms": false, "clip_links": true, "link_source": "nightjar"}'::jsonb;

comment on column public.notification_settings.channels is
  'Per-channel prefs plus clip-link prefs: {push, email, sms, clip_links, '
  'link_source}. Missing keys read as false, except push and clip_links '
  'which default on, and link_source which defaults to "nightjar".';

-- ---------- clip_shares: reuse lookup ----------

-- notify reuses an existing unexpired, unrevoked share for the event instead
-- of minting a new token every time it runs for the same event (retries, and
-- future re-notifies). That probe filters on (event_id, owner_id) — already
-- indexed by clip_shares_event_owner_idx from 0011 — and then on
-- revoked_at IS NULL AND expires_at > now(), which stays a cheap filter
-- because an event has at most a handful of shares.
