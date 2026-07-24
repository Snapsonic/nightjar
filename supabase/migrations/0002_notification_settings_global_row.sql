-- camera_id was part of the PK, forcing NOT NULL — but a NULL camera_id row
-- is how per-user global notification defaults are stored. Switch to a
-- surrogate PK + a NULL-safe unique index.
alter table public.notification_settings
  drop constraint notification_settings_pkey;

alter table public.notification_settings
  add column id uuid primary key default gen_random_uuid();

create unique index notification_settings_user_camera_uniq
  on public.notification_settings (user_id, coalesce(camera_id, '00000000-0000-0000-0000-000000000000'::uuid));
