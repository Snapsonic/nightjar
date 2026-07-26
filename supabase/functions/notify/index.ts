// Sends event notifications over Web Push, email (Postmark) and SMS (Magpipe).
//
// Called service-to-service by the `events_notify` Postgres trigger (pg_net)
// with the event row as JSON, authenticated via the x-nightjar-hook shared
// secret — NOT by browsers. Deployed with verify_jwt = false (config.toml)
// because pg_net sends no Authorization header.
//
// Flow: event row -> resolve owner (nodes.site_id -> sites.owner_id) ->
// notification_settings (camera-specific row wins over the global camera_id
// IS NULL row, defaults to {person,package}) -> shared decideNotify() filter
// (kinds, mute, 5-minute per (user, camera, kind) cooldown ACROSS channels —
// one event, at most one alert moment) -> per-channel fan-out:
//   * push: RFC 8291 aes128gcm + VAPID to every push_subscriptions row,
//     pruning subscriptions the push service reports gone (404/410).
//   * email: Postmark, when channels.email; to profiles.notify_email or the
//     auth account email.
//   * sms: Magpipe, when channels.sms and profiles.notify_phone is set.
// Channels run under Promise.allSettled — a failure in one never blocks the
// others — and each channel that sends records its own
// notification_deliveries row (channel column).
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
  /** sent_at of the most recent delivery for (user, camera, kind) on ANY channel. */
  lastDeliveryAt: string | null;
  now: Date;
}

/**
 * Channel-independent filter: kinds, mute, cooldown. Which channels actually
 * fire is decided per channel by channelEnabled(); the cooldown is shared so
 * one event produces at most one alert moment across push + email + sms.
 */
export function decideNotify(input: DecisionInput): { send: boolean; reason: string } {
  const kinds = input.settings?.kinds ?? DEFAULT_KINDS;
  if (!kinds.includes(input.kind)) return { send: false, reason: `kind ${input.kind} not enabled` };

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

/** Missing keys are false, except "push" which has always defaulted to on. */
export function channelEnabled(
  settings: NotifySettings | null,
  channel: "push" | "email" | "sms",
): boolean {
  const value = settings?.channels?.[channel];
  if (value === undefined || value === null) return channel === "push";
  return value === true;
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

function utcHhMm(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** External send timeout — never let a slow provider hold the function open. */
const SEND_TIMEOUT_MS = 5_000;

export function buildPayload(event: EventRow, cameraName: string): string {
  const startedAt = new Date(event.started_at);
  return JSON.stringify({
    title: `${capitalize(event.kind)} — ${cameraName}`,
    body: `at ${utcHhMm(event.started_at)}`,
    // The service worker reformats the body in device-local time from this.
    timestamp: startedAt.getTime(),
    tag: `nightjar-${event.camera_id}`,
    url: "/events",
  });
}

/* ---------- email (Postmark) ---------- */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Bulletproof alert email: tables + inline styles only, max-width 480, no
 * external images (the crescent moon is a styled text glyph — SVG-in-<img>
 * and remote assets are unreliable in Gmail). Colors are the Nightjar dark
 * theme and are forced inline, so the card reads the same in Gmail light and
 * dark modes.
 */
export function buildEmailHtml(kind: string, cameraName: string, startedAtIso: string): string {
  const kindLabel = escapeHtml(capitalize(kind));
  const camera = escapeHtml(cameraName);
  const time = utcHhMm(startedAtIso);
  const font =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;background-color:#0a0c13;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="480" style="width:100%;max-width:480px;background-color:#131722;border:1px solid #232a3b;border-radius:16px;">
        <tr>
          <td style="padding:28px 32px 0 32px;font-family:${font};">
            <span style="font-size:18px;line-height:1;color:#f0a441;vertical-align:middle;">&#9790;</span>
            <span style="font-size:16px;font-weight:600;letter-spacing:0.02em;color:#e8eaf0;vertical-align:middle;">&nbsp;nightjar.</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 6px 32px;font-family:${font};font-size:26px;line-height:1.25;font-weight:700;color:#ffffff;">
            ${kindLabel} detected
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px;font-family:${font};font-size:14px;line-height:1.5;color:#8b93a7;">
            at ${camera} &middot; ${time} UTC
          </td>
        </tr>
        <tr>
          <td style="padding:26px 32px 30px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="border-radius:10px;background-color:#f0a441;">
                  <a href="https://app.nightjar.ca/events" target="_blank" style="display:inline-block;padding:12px 28px;font-family:${font};font-size:14px;font-weight:700;color:#0a0c13;text-decoration:none;border-radius:10px;">View events</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 32px 24px 32px;border-top:1px solid #232a3b;font-family:${font};font-size:12px;line-height:1.6;color:#5b6375;">
            You&#39;re getting this because ${escapeHtml(kind)} alerts are on.
            Manage at <a href="https://app.nightjar.ca/settings" target="_blank" style="color:#8b93a7;text-decoration:underline;">app.nightjar.ca/settings</a>.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

export function buildEmailText(kind: string, cameraName: string, startedAtIso: string): string {
  return [
    `${capitalize(kind)} detected at ${cameraName} - ${utcHhMm(startedAtIso)} UTC.`,
    "",
    "View events: https://app.nightjar.ca/events",
    "",
    `You're getting this because ${kind} alerts are on. Manage at https://app.nightjar.ca/settings`,
  ].join("\n");
}

/* ---------- sms (Magpipe) ---------- */

/**
 * Single-segment, GSM-7-safe SMS: no emoji, plain hyphen instead of an em
 * dash (both would force UCS-2 and shrink the segment to 70 chars); camera
 * name truncated so the whole message stays <= 160 chars.
 */
export function buildSmsMessage(kind: string, cameraName: string, startedAtIso: string): string {
  const prefix = `Nightjar: ${capitalize(kind)} at `;
  const suffix = `, ${utcHhMm(startedAtIso)} - app.nightjar.ca/events`;
  const room = 160 - prefix.length - suffix.length;
  const name = cameraName.length > room ? cameraName.slice(0, room) : cameraName;
  return `${prefix}${name}${suffix}`;
}

/* ---------- per-channel senders ---------- */

type Admin = ReturnType<typeof adminClient>;

interface PushOutcome {
  status: "sent" | "skipped" | "failed";
  detail: string;
  sent: number;
  failed: number;
  removed: number;
}

interface SendOutcome {
  status: "sent" | "skipped" | "failed";
  detail: string;
}

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
  })().catch((err) => {
    appServerPromise = null; // allow retry on the next event
    throw err;
  });
  return appServerPromise;
}

async function sendPush(
  admin: Admin,
  ownerId: string,
  event: EventRow,
  cameraName: string,
): Promise<PushOutcome> {
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", ownerId);
  if (!subs || subs.length === 0) {
    return { status: "skipped", detail: "no subscriptions", sent: 0, failed: 0, removed: 0 };
  }

  const payload = buildPayload(event, cameraName);
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
  }
  await Promise.allSettled(writes);

  return {
    status: sentIds.length > 0 ? "sent" : "failed",
    detail: `sent ${sentIds.length}, failed ${failed}, removed ${goneIds.length}`,
    sent: sentIds.length,
    failed,
    removed: goneIds.length,
  };
}

async function sendEmail(
  admin: Admin,
  ownerId: string,
  notifyEmail: string | null,
  event: EventRow,
  cameraName: string,
): Promise<SendOutcome> {
  const apiKey = Deno.env.get("POSTMARK_API_KEY");
  const from = Deno.env.get("NIGHTJAR_EMAIL_FROM");
  if (!apiKey || !from) return { status: "skipped", detail: "email not configured" };

  // profiles.notify_email overrides; otherwise the auth account email.
  let to = notifyEmail;
  if (!to) {
    const { data, error } = await admin.auth.admin.getUserById(ownerId);
    if (error) return { status: "failed", detail: `getUserById: ${error.message}` };
    to = data.user?.email ?? null;
  }
  if (!to) return { status: "skipped", detail: "no email address" };

  const base = Deno.env.get("POSTMARK_API_BASE") ?? "https://api.postmarkapp.com";
  const res = await fetch(`${base}/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Postmark-Server-Token": apiKey,
    },
    body: JSON.stringify({
      From: from,
      To: to,
      Subject: `🌙 ${capitalize(event.kind)} — ${cameraName}`,
      HtmlBody: buildEmailHtml(event.kind, cameraName, event.started_at),
      TextBody: buildEmailText(event.kind, cameraName, event.started_at),
      MessageStream: "outbound",
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Postmark ${res.status}: ${body.slice(0, 300)}`);
  }
  await res.body?.cancel();
  return { status: "sent", detail: `email to ${to}` };
}

async function sendSms(
  notifyPhone: string,
  event: EventRow,
  cameraName: string,
): Promise<SendOutcome> {
  const apiKey = Deno.env.get("MAGPIPE_API_KEY");
  const from = Deno.env.get("MAGPIPE_SMS_FROM");
  if (!apiKey || !from) return { status: "skipped", detail: "sms not configured" };

  const base = Deno.env.get("MAGPIPE_API_BASE") ?? "https://api.magpipe.ai";
  const res = await fetch(`${base}/functions/v1/send-user-sms`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      serviceNumber: from,
      contactPhone: notifyPhone,
      message: buildSmsMessage(event.kind, cameraName, event.started_at),
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (parsed.error) detail = JSON.stringify(parsed.error).slice(0, 300);
    } catch {
      // non-JSON error body — keep the raw slice
    }
    throw new Error(`Magpipe ${res.status}: ${detail}`);
  }
  await res.body?.cancel();
  return { status: "sent", detail: `sms to ${notifyPhone}` };
}

/* ---------- handler ---------- */

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

  // Cooldown: most recent delivery for (user, camera, kind) on ANY channel —
  // one event window produces at most one alert moment across all channels.
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

  const wantPush = channelEnabled(settings, "push");
  const wantEmail = channelEnabled(settings, "email");
  const wantSms = channelEnabled(settings, "sms");
  if (!wantPush && !wantEmail && !wantSms) return json({ skipped: "all channels disabled" });

  const { data: camera } = await admin
    .from("cameras")
    .select("name")
    .eq("id", event.camera_id)
    .maybeSingle();
  const cameraName = camera?.name ?? "Camera";

  // Delivery addresses, only when a non-push channel needs them.
  let notifyEmail: string | null = null;
  let notifyPhone: string | null = null;
  if (wantEmail || wantSms) {
    const { data: profile } = await admin
      .from("profiles")
      .select("notify_email, notify_phone")
      .eq("id", ownerId)
      .maybeSingle();
    notifyEmail = profile?.notify_email ?? null;
    notifyPhone = profile?.notify_phone ?? null;
  }

  // Fan out. Each entry resolves to a labeled outcome; log-and-continue on
  // failure — one broken provider must not block the other channels.
  const tasks: { channel: "push" | "email" | "sms"; run: () => Promise<PushOutcome | SendOutcome> }[] = [];
  if (wantPush) {
    tasks.push({ channel: "push", run: () => sendPush(admin, ownerId, event, cameraName) });
  }
  if (wantEmail) {
    tasks.push({
      channel: "email",
      run: () => sendEmail(admin, ownerId, notifyEmail, event, cameraName),
    });
  }
  if (wantSms) {
    tasks.push({
      channel: "sms",
      run: () =>
        notifyPhone
          ? sendSms(notifyPhone, event, cameraName)
          : Promise.resolve<SendOutcome>({ status: "skipped", detail: "no phone number" }),
    });
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));

  const outcomes: Record<string, PushOutcome | SendOutcome> = {};
  const deliveredChannels: string[] = [];
  settled.forEach((result, i) => {
    const channel = tasks[i].channel;
    if (result.status === "fulfilled") {
      outcomes[channel] = result.value;
      if (result.value.status === "sent") deliveredChannels.push(channel);
    } else {
      console.error(`${channel} channel failed:`, result.reason);
      outcomes[channel] = {
        status: "failed",
        detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    }
  });

  // One deliveries row per channel that actually sent; the cooldown query
  // above ignores channel, so the first row already arms the shared cooldown.
  if (deliveredChannels.length > 0) {
    await admin.from("notification_deliveries").insert(
      deliveredChannels.map((channel) => ({
        user_id: ownerId,
        camera_id: event.camera_id,
        kind: event.kind,
        channel,
      })),
    );
  }

  return json({ delivered: deliveredChannels, outcomes });
});
