-- Activity zones (roadmap #13): named polygons per camera, edited from the
-- web UI and enforced on the node. The node's camera sync upserts the zones
-- array (shared Zone schema: {id, name, points[[x,y]...], mode}) alongside
-- capabilities. Empty array = whole frame active.
--
-- NOTE: apply this BEFORE deploying node builds that sync the zones column —
-- their camera upsert includes `zones` and fails until the column exists.

alter table public.cameras
  add column if not exists zones jsonb not null default '[]';
