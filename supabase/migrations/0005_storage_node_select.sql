-- createSignedUrl RLS-checks SELECT on the object; nodes could insert but not
-- read their own uploads, so signing snapshot URLs failed "Object not found".
create policy "node reads own prefix" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('event-clips', 'snapshots')
    and split_part(name, '/', 1)::uuid = public.jwt_node_id()
  );
