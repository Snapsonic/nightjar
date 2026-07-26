// Sends Web Push notifications for freshly inserted events.
//
// Called service-to-service by the `events_notify` Postgres trigger (pg_net)
// with the event row as JSON, authenticated via the x-nightjar-hook shared
// secret — NOT by browsers. Deployed with verify_jwt = false (config.toml)
// because pg_net sends no Authorization header.
//
// Flow: event row -> resolve owner (nodes.site_id -> sites.owner_id) ->
// notification_settings (camera-specific row wins over the global camera_id
// IS NULL row, defaults to {person,package}) -> 5-minute per
// (user, camera, kind) cooldown via notification_deliveries -> Web Push
// (RFC 8291 aes128gcm + VAPID) to every push_subscriptions row, pruning
// subscriptions the push service reports gone (404/410).
import * as webpush from "jsr:@negrel/webpush@0.5.0";
import { adminClient, json } from "../_shared/util.ts";

/* ---------- pure decision logic (unit-tested in isolation) ---------- */

export const DEFAULT_KINDS = ["person", "package"];
export const COOLDOWN_MS = 5 * 60 * 1000;

export interface NotifySettings {
  kinds: string[];
  channels: Record<string, unknown> | null;
  muted_until: string | null;
}

export interface DecisionInput {
  kind: string;
  /** Camera-specific settings row, else the global (camera_id IS NULL) row, else null. */
  settings: NotifySettings | null;
  /** sent_at of the most recent delivery for (user, camera, kind), if any. */
  lastDeliveryAt: string | null;
  now: Date;
}

export function decideNotify(input: DecisionInput): { send: boolean; reason: string } {
  const kinds = input.settings?.kinds ?? DEFAULT_KINDS;
  if (!kinds.includes(input.kind)) return { send: false, reason: `kind ${input.kind} not enabled` };

  if (input.settings?.channels && input.settings.channels["push"] === false) {
    return { send: false, reason: "push channel disabled" };
  }

  const mutedUntil = input.settings?.muted_until;
  if (mutedUntil && new Date(mutedUntil).getTime() > input.now.getTime()) {
    return { send: false, reason: `muted until ${mutedUntil}` };
  }

  if (
    input.lastDeliveryAt &&
    input.now.getTime() - new Date(input.lastDeliveryAt).getTime() < COOLDOWN_MS
  ) {
    return { send: false, reason: "cooldown (delivery within 5 minutes)" };
  }

  return { send: true, reason: "ok" };
}

/* ---------- VAPID key handling ---------- */

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Converts standard VAPID env keys (base64url raw: public = 65-byte
 * uncompressed P-256 point, private = 32-byte scalar) to the JWK pair
 * expected by @negrel/webpush.
 */
export function vapidEnvToJwk(
  publicKey: string,
  privateKey: string,
): webpush.ExportedVapidKeys {
  const raw = base64UrlToBytes(publicKey);
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY is not an uncompressed P-256 point");
  }
  const x = bytesToBase64Url(raw.slice(1, 33));
  const y = bytesToBase64Url(raw.slice(33, 65));
  const d = bytesToBase64Url(base64UrlToBytes(privateKey));
  return {
    publicKey: { kty: "EC", crv: "P-256", x, y, ext: true },
    privateKey: { kty: "EC", crv: "P-256", x, y, d, ext: true },
  };
}

/* ---------- helpers ---------- */

interface EventRow {
  id: string;
  node_id: string;
  camera_id: string;
  kind: string;
  started_at: string;
}

function isEventRow(value: unknown): value is EventRow {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["id", "node_id", "camera_id", "kind", "started_at"].every(
    (key) => typeof row[key] === "string" && row[key] !== "",
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function buildPayload(event: EventRow, cameraName: string): string {
  const startedAt = new Date(event.started_at);
  const hh = String(startedAt.getUTCHours()).padStart(2, "0");
  const mm = String(startedAt.getUTCMinutes()).padStart(2, "0");
  return JSON.stringify({
    title: `${capitalize(event.kind)} — ${cameraName}`,
    body: `at ${hh}:${mm}`,
    // The service worker reformats the body in device-local time from this.
    timestamp: startedAt.getTime(),
    tag: `nightjar-${event.camera_id}`,
    url: "/events",
  });
}

/* ---------- handler ---------- */

let appServerPromise: Promise<webpush.ApplicationServer> | null = null;

function getAppServer(): Promise<webpush.ApplicationServer> {
  appServerPromise ??= (async () => {
    const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    if (!publicKey || !privateKey) throw new Error("VAPID keys not configured");
    const vapidKeys = await webpush.importVapidKeys(vapidEnvToJwk(publicKey, privateKey), {
      extractable: false,
    });
    return webpush.ApplicationServer.new({
      contactInformation: Deno.env.get("VAPID_SUBJECT") ?? "mailto:hello@nightjar.ca",
      vapidKeys,
    });
  })();
  return appServerPromise;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Service-to-service auth: shared hook secret only. No Authorization header
  // expected (pg_net does not send one) — verify_jwt is off for this function.
  const hookSecret = Deno.env.get("NOTIFY_HOOK_SECRET");
  if (!hookSecret || req.headers.get("x-nightjar-hook") !== hookSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const body: unknown = await req.json().catch(() => null);
  const event = (body as { event?: unknown } | null)?.event;
  if (!isEventRow(event)) return json({ error: "invalid event payload" }, 400);

  const admin = adminClient();

  // Owner: nodes.site_id -> sites.owner_id.
  const { data: node } = await admin
    .from("nodes")
    .select("site_id")
    .eq("id", event.node_id)
    .maybeSingle();
  if (!node?.site_id) return json({ skipped: "node unclaimed" });
  const { data: site } = await admin
    .from("sites")
    .select("owner_id")
    .eq("id", node.site_id)
    .maybeSingle();
  if (!site?.owner_id) return json({ skipped: "no owner" });
  const ownerId: string = site.owner_id;

  // Settings: camera-specific row wins over the global (camera_id IS NULL) row.
  const { data: settingsRows } = await admin
    .from("notification_settings")
    .select("camera_id, kinds, channels, muted_until")
    .eq("user_id", ownerId)
    .or(`camera_id.eq.${event.camera_id},camera_id.is.null`);
  const settings: NotifySettings | null =
    settingsRows?.find((row) => row.camera_id === event.camera_id) ??
    settingsRows?.find((row) => row.camera_id === null) ??
    null;

  // Cooldown: most recent delivery for (user, camera, kind).
  const { data: lastDelivery } = await admin
    .from("notification_deliveries")
    .select("sent_at")
    .eq("user_id", ownerId)
    .eq("camera_id", event.camera_id)
    .eq("kind", event.kind)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const decision = decideNotify({
    kind: event.kind,
    settings,
    lastDeliveryAt: lastDelivery?.sent_at ?? null,
    now: new Date(),
  });
  if (!decision.send) return json({ skipped: decision.reason });

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", ownerId);
  if (!subs || subs.length === 0) return json({ skipped: "no subscriptions" });

  const { data: camera } = await admin
    .from("cameras")
    .select("name")
    .eq("id", event.camera_id)
    .maybeSingle();
  const payload = buildPayload(event, camera?.name ?? "Camera");

  const appServer = await getAppServer();
  const results = await Promise.allSettled(
    subs.map(async (sub) => {
      const subscriber = appServer.subscribe({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      });
      await subscriber.pushTextMessage(payload, {
        ttl: 300,
        urgency: webpush.Urgency.High,
      });
    }),
  );

  const goneIds: string[] = [];
  const sentIds: string[] = [];
  let failed = 0;
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      sentIds.push(subs[i].id);
      return;
    }
    const err = result.reason;
    if (
      err instanceof webpush.PushMessageError &&
      (err.response.status === 404 || err.response.status === 410)
    ) {
      goneIds.push(subs[i].id);
    } else {
      failed += 1;
      console.error(`push to subscription ${subs[i].id} failed:`, err);
    }
  });

  const writes: PromiseLike<unknown>[] = [];
  if (goneIds.length > 0) {
    writes.push(admin.from("push_subscriptions").delete().in("id", goneIds));
  }
  if (sentIds.length > 0) {
    writes.push(
      admin
        .from("push_subscriptions")
        .update({ last_used_at: new Date().toISOString() })
        .in("id", sentIds),
    );
    writes.push(
      admin.from("notification_deliveries").insert({
        user_id: ownerId,
        camera_id: event.camera_id,
        kind: event.kind,
      }),
    );
  }
  await Promise.allSettled(writes);

  return json({ sent: sentIds.length, failed, removed: goneIds.length });
});
