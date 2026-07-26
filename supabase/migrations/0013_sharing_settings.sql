-- Account-level control over public clip sharing. Enforced in share-clip
-- (not just the UI) so a disabled account cannot mint links at all.
alter table public.profiles
  add column if not exists sharing_enabled boolean not null default true,
  add column if not exists default_share_expiry_days int not null default 7
    check (default_share_expiry_days in (1, 7, 30));
