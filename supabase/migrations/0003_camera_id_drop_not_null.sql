-- Dropping the old composite PK (0002) left the implicit NOT NULL behind;
-- the global-settings row needs camera_id NULL.
alter table public.notification_settings
  alter column camera_id drop not null;
