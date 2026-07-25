-- Storage's upsert flow evaluates UPDATE RLS even when the object doesn't
-- exist yet; nodes only had INSERT. Allow nodes to overwrite within their own
-- prefix so retried/idempotent uploads don't 403.
create policy "node updates own prefix" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('event-clips', 'snapshots')
    and split_part(name, '/', 1)::uuid = public.jwt_node_id()
  )
  with check (
    bucket_id in ('event-clips', 'snapshots')
    and split_part(name, '/', 1)::uuid = public.jwt_node_id()
  );
