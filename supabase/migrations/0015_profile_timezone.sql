-- Alerts were rendering UTC ("20:13 UTC" for a 1:13 PM event), which makes the
-- reader do timezone arithmetic on their own security footage. The web app
-- stamps the browser's IANA zone on sign-in; notifications format in it.
alter table public.profiles
  add column if not exists timezone text;
