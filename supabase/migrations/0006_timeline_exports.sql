-- On-demand 24/7 timeline exports: nodes upload short clips to
-- timeline-exports/{node_id}/{camera_id}/{fromMs}-{toMs}.mp4 and hand out
-- signed URLs; owners can read their nodes' clips. Nodes also garbage-collect
-- their own exports (older than 24h), which needs DELETE on the own prefix.

insert into storage.buckets (id, name, public)
values ('timeline-exports', 'timeline-exports', false)
on conflict (id) do nothing;

create policy "node writes own timeline exports" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'timeline-exports'
    and split_part(name, '/', 1)::uuid = public.jwt_node_id()
  );

-- createSignedUrl RLS-checks SELECT on the object (see 0005).
create policy "node reads own timeline exports" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'timeline-exports'
    and split_part(name, '/', 1)::uuid = public.jwt_node_id()
  );

-- Storage's upsert flow evaluates UPDATE RLS even for plain retries (see 0004).
create policy "node updates own timeline exports" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'timeline-exports'
    and split_part(name, '/', 1)::uuid = public.jwt_node_id()
  )
  with check (
    bucket_id = 'timeline-exports'
    and split_part(name, '/', 1)::uuid = public.jwt_node_id()
  );

create policy "node deletes own timeline exports" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'timeline-exports'
    and split_part(name, '/', 1)::uuid = public.jwt_node_id()
  );

create policy "owner reads own nodes' timeline exports" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'timeline-exports'
    and public.user_owns_node(split_part(name, '/', 1)::uuid)
  );
