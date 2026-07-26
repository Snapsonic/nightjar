// PUBLIC resolver for clip-share tokens (roadmap #17 extended).
//
// Deployed with verify_jwt = false (supabase/config.toml) — anonymous viewers
// of https://nightjar.ca/s/<token> call this directly. All reads run with the
// service role so expiry, revocation and view counting are enforced here, and
// the response is a hand-picked allowlist of fields: NO node ids, storage
// paths, camera ids or any other node-internal data ever leaves this function.
//
// GET ?token=<token> ->
//   200 {caption, kind, cameraName, startedAt, clipUrl, thumbnailUrl, durationS}
//   200 {status:"pending", ...} while the clip is still uploading
//   404 missing / revoked / expired
//   429 crude abuse guard (view_count > 10000)
import { adminClient, corsHeaders, json } from "../_shared/util.ts";

const SIGNED_URL_TTL_SEC = 3600;
const VIEW_COUNT_ABUSE_LIMIT = 10_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { ...corsHeaders, "Access-Control-Allow-Methods": "GET, OPTIONS" },
    });
  }
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const token = new URL(req.url).searchParams.get("token");
  if (!token) return json({ error: "token required" }, 400);

  const admin = adminClient();
  const { data: share } = await admin
    .from("clip_shares")
    .select("id, event_id, caption, expires_at, revoked_at, view_count")
    .eq("token", token)
    .maybeSingle();

  // Missing, revoked and expired are indistinguishable to viewers on purpose.
  if (!share) return json({ error: "share not found" }, 404);
  if (share.revoked_at) return json({ error: "share not found" }, 404);
  if (new Date(share.expires_at).getTime() <= Date.now()) {
    return json({ error: "share not found" }, 404);
  }
  if (share.view_count > VIEW_COUNT_ABUSE_LIMIT) {
    return json({ error: "too many views" }, 429);
  }

  const { data: event } = await admin
    .from("events")
    .select("id, camera_id, kind, started_at, thumbnail_path, clip_status")
    .eq("id", share.event_id)
    .maybeSingle();
  if (!event || event.clip_status !== "uploaded") {
    return json({ error: "share not found" }, 404);
  }

  const { data: camera } = await admin
    .from("cameras")
    .select("name")
    .eq("id", event.camera_id)
    .maybeSingle();
  const cameraName = camera?.name ?? "Camera";

  const { data: clipRow } = await admin
    .from("event_clips")
    .select("storage_path, duration_s")
    .eq("event_id", event.id)
    .maybeSingle();
  // Alerts are sent the moment an event closes, so a link tapped immediately
  // can arrive before the upload lands. That is "not ready yet", not "gone".
  if (!clipRow) {
    return json({ status: "pending", kind: event.kind, cameraName, startedAt: event.started_at }, 200);
  }

  // Best-effort view count — a lost race just undercounts.
  await admin
    .from("clip_shares")
    .update({ view_count: share.view_count + 1 })
    .eq("id", share.id);

  const storage = admin.storage.from("event-clips");
  const { data: signedClip, error: clipError } = await storage.createSignedUrl(
    clipRow.storage_path,
    SIGNED_URL_TTL_SEC,
  );
  if (clipError || !signedClip) {
    return json({ status: "pending", kind: event.kind, cameraName, startedAt: event.started_at }, 200);
  }

  let thumbnailUrl: string | null = null;
  if (event.thumbnail_path) {
    const { data: signedThumb } = await storage.createSignedUrl(
      event.thumbnail_path,
      SIGNED_URL_TTL_SEC,
    );
    thumbnailUrl = signedThumb?.signedUrl ?? null; // thumbnail is decorative
  }

  // Allowlist response — never spread database rows into this object.
  return json({
    caption: share.caption,
    kind: event.kind,
    cameraName,
    startedAt: event.started_at,
    clipUrl: signedClip.signedUrl,
    thumbnailUrl,
    durationS: clipRow.duration_s,
  });
});
