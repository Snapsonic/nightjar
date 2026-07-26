-- Email + SMS notification channels alongside Web Push (roadmap follow-up to
-- 0007_push_notifications).
--
--   * notification_settings.channels gains an "sms" key in the default. Rows
--     created before this migration keep their existing jsonb; the notify edge
--     function treats missing keys as false, except "push" which defaults on.
--   * profiles.notify_email: optional override for alert emails
--     (null = use the auth account email).
--   * profiles.notify_phone: E.164 destination for SMS (null = SMS
--     unavailable, the sms channel is skipped).
--   * notification_deliveries.channel: which channel a delivery row records
--     ('push' | 'email' | 'sms'). The 5-minute cooldown remains per
--     (user, camera, kind) ACROSS channels — one event, one alert moment.
--
-- ORCHESTRATOR: edge-function secrets POSTMARK_API_KEY, NIGHTJAR_EMAIL_FROM,
-- MAGPIPE_API_KEY, MAGPIPE_SMS_FROM must be set before deploying the updated
-- notify function.

-- ---------- notification_settings: sms channel in the default ----------

alter table public.notification_settings
  alter column channels set default '{"push": true, "email": false, "sms": false}'::jsonb;

-- ---------- profiles: per-user delivery addresses ----------

-- RLS: the existing "own profile" owner policy already covers these columns.
alter table public.profiles
  add column if not exists notify_email text;
alter table public.profiles
  add column if not exists notify_phone text;

comment on column public.profiles.notify_email is
  'Override destination for alert emails; null = use the auth account email.';
comment on column public.profiles.notify_phone is
  'E.164 destination for SMS alerts; null = SMS channel unavailable.';

-- ---------- notification_deliveries: per-channel rows ----------

alter table public.notification_deliveries
  add column if not exists channel text not null default 'push';

-- Rebuild the cooldown index to include channel. channel comes AFTER
-- sent_at on purpose: the cooldown lookup scans (user_id, camera_id, kind)
-- ordered by sent_at desc across ALL channels, so channel must not sit
-- between the equality columns and the sort column; as a trailing column it
-- still makes per-channel queries index-only.
drop index if exists public.notification_deliveries_cooldown_idx;
create index notification_deliveries_cooldown_idx
  on public.notification_deliveries (user_id, camera_id, kind, sent_at desc, channel);
