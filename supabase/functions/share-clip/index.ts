// Owner-facing management of public clip-share links (roadmap #17 extended).
//
// Authenticated with the signed-in user's JWT. Actions via POST {action}:
//   * create: {eventId, expiresInDays?, caption?} -> mint a token and return
//     the public URL. Requires the caller to own the event's node and the
//     clip to be uploaded to cloud storage.
//   * revoke: {token} -> set revoked_at on the caller's own share.
//   * list:   {eventId} -> the caller's shares for that event.
//
// Anonymous viewers never hit this function — they resolve tokens through
// share-view (service role), so expiry/revocation/counting stay server-side.
import { adminClient, callerClient, handleOptions, json } from "../_shared/util.ts";

const SHARE_BASE_URL = "https://nightjar.ca/s/";
const ALLOWED_EXPIRY_DAYS = [1, 7, 30];
const DEFAULT_EXPIRY_DAYS = 7;
const MAX_CAPTION_LENGTH = 500;

/** 24 random bytes, base64url — unguessable and URL-safe. */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

type Admin = ReturnType<typeof adminClient>;

/** Resolve the owner (sites.owner_id) of the node an event belongs to. */
async function eventOwnership(
  admin: Admin,
  eventId: string,
): Promise<{ event: { id: string; clip_status: string }; ownerId: string | null } | null> {
  const { data: event } = await admin
    .from("events")
    .select("id, node_id, clip_status")
    .eq("id", eventId)
    .maybeSingle();
  if (!event) return null;

  const { data: node } = await admin
    .from("nodes")
    .select("site_id")
    .eq("id", event.node_id)
    .maybeSingle();
  if (!node?.site_id) return { event, ownerId: null };

  const { data: site } = await admin
    .from("sites")
    .select("owner_id")
    .eq("id", node.site_id)
    .maybeSingle();
  return { event, ownerId: site?.owner_id ?? null };
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const { data: auth } = await callerClient(req).auth.getUser();
  const userId = auth?.user?.id;
  // Node JWTs are authenticated too, but shares belong to humans.
  if (!userId || auth?.user?.app_metadata?.node_id) {
    return json({ error: "sign in required" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  const admin = adminClient();

  if (action === "create") {
    const { eventId, expiresInDays, caption } = body;
    if (typeof eventId !== "string" || eventId === "") {
      return json({ error: "eventId required" }, 400);
    }
    const days = expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : expiresInDays;
    if (!ALLOWED_EXPIRY_DAYS.includes(days)) {
      return json({ error: "expiresInDays must be 1, 7 or 30" }, 400);
    }
    if (caption !== undefined && (typeof caption !== "string" || caption.length > MAX_CAPTION_LENGTH)) {
      return json({ error: `caption must be a string of at most ${MAX_CAPTION_LENGTH} characters` }, 400);
    }

    const ownership = await eventOwnership(admin, eventId);
    if (!ownership) return json({ error: "event not found" }, 404);
    if (ownership.ownerId !== userId) return json({ error: "not your event" }, 403);
    if (ownership.event.clip_status !== "uploaded") {
      return json({ error: "clip is not uploaded to the cloud yet" }, 409);
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const { data: share, error } = await admin
      .from("clip_shares")
      .insert({
        token,
        event_id: eventId,
        owner_id: userId,
        caption: caption ?? null,
        expires_at: expiresAt,
      })
      .select("token, expires_at")
      .single();
    if (error || !share) return json({ error: error?.message ?? "could not create share" }, 500);

    return json({
      token: share.token,
      url: `${SHARE_BASE_URL}${share.token}`,
      expiresAt: share.expires_at,
    });
  }

  if (action === "revoke") {
    const { token } = body;
    if (typeof token !== "string" || token === "") return json({ error: "token required" }, 400);
    // owner_id filter makes revoking someone else's token a silent no-op.
    const { error } = await admin
      .from("clip_shares")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token", token)
      .eq("owner_id", userId)
      .is("revoked_at", null);
    if (error) return json({ error: error.message }, 500);
    return json({ revoked: true });
  }

  if (action === "list") {
    const { eventId } = body;
    if (typeof eventId !== "string" || eventId === "") {
      return json({ error: "eventId required" }, 400);
    }
    const { data: shares, error } = await admin
      .from("clip_shares")
      .select("token, caption, expires_at, revoked_at, view_count, created_at")
      .eq("event_id", eventId)
      .eq("owner_id", userId)
      .order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json({
      shares: (shares ?? []).map((share) => ({
        token: share.token,
        url: `${SHARE_BASE_URL}${share.token}`,
        caption: share.caption,
        expiresAt: share.expires_at,
        revokedAt: share.revoked_at,
        viewCount: share.view_count,
        createdAt: share.created_at,
      })),
    });
  }

  return json({ error: "action must be create, revoke or list" }, 400);
});
