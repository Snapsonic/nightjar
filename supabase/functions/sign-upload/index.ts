// Node requests signed upload URLs for an event's clip + thumbnail.
// Caller must be a node JWT (app_metadata.node_id) that owns the event.
import { adminClient, callerClient, handleOptions, json } from "../_shared/util.ts";

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const { data: auth } = await callerClient(req).auth.getUser();
  const nodeId = auth?.user?.app_metadata?.node_id as string | undefined;
  if (!nodeId) return json({ error: "node token required" }, 401);

  const { eventId, files } = await req.json().catch(() => ({}));
  if (typeof eventId !== "string" || !Array.isArray(files) || files.length === 0) {
    return json({ error: "eventId and files required" }, 400);
  }
  const allowed = new Set(["clip.mp4", "thumb.jpg"]);
  if (!files.every((f: unknown) => typeof f === "string" && allowed.has(f))) {
    return json({ error: "files must be clip.mp4 or thumb.jpg" }, 400);
  }

  const admin = adminClient();
  const { data: event } = await admin
    .from("events")
    .select("id, node_id")
    .eq("id", eventId)
    .eq("node_id", nodeId)
    .maybeSingle();
  if (!event) return json({ error: "event not found" }, 404);

  const uploads = [];
  for (const file of files as string[]) {
    const path = `${nodeId}/${eventId}/${file}`;
    const { data, error } = await admin.storage.from("event-clips").createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    uploads.push({ file, path, token: data.token });
  }

  return json({ uploads });
});
