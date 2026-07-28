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
//
// Every alert also tries to carry a tappable clip link (see resolveClipLink):
// the owner's own Google Drive URL when they opted into that, otherwise a
// short-lived Nightjar share (clip_shares, 7 days, revocable), otherwise the
// plain /events page as before.
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

/* ---------- clip links (pure parts) ---------- */

export type LinkSource = "nightjar" | "drive";

export interface ClipLink {
  url: string;
  source: LinkSource;
  /** ISO expiry — Nightjar shares only; Drive links do not expire. */
  expiresAt: string | null;
}

// The app serves /s/<token>; nightjar.ca 307s here for older links.
export const SHARE_BASE_URL = "https://app.nightjar.ca/s/";
export const EVENTS_URL = "https://app.nightjar.ca/events";
export const SHARE_EXPIRY_DAYS = 7;
/**
 * clip_status values worth minting a link for. "uploading" counts on purpose:
 * the events_notify trigger fires on INSERT, and the node inserts the event
 * row with clip_status 'uploading' *before* it pushes the bytes — so at alert
 * time the clip is normally still in flight and would otherwise never get a
 * link. share-view 404s until the upload finishes (seconds), and the share is
 * revocable if it never does.
 */
export const LINKABLE_CLIP_STATUSES = ["uploaded", "uploading"];
/** Below this the camera name is unreadable — drop the link instead. */
const MIN_SMS_CAMERA_CHARS = 6;

/** clip_links is opt-OUT: missing/invalid reads as true. */
export function clipLinksEnabled(settings: NotifySettings | null): boolean {
  return settings?.channels?.clip_links !== false;
}

/** link_source defaults to "nightjar"; anything unrecognised reads as that. */
export function linkSource(settings: NotifySettings | null): LinkSource {
  return settings?.channels?.link_source === "drive" ? "drive" : "nightjar";
}

/** Whole days left on the link, rounded up and floored at 1. */
export function daysUntil(expiresAt: string, now: Date): number {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

/** The muted line under the email CTA. Null when there is no link. */
export function buildLinkNote(link: ClipLink | null, now: Date): string | null {
  if (!link) return null;
  if (link.source === "drive") return "Google Drive link";
  if (!link.expiresAt) return "Link expires";
  const days = daysUntil(link.expiresAt, now);
  return `Link expires in ${days} day${days === 1 ? "" : "s"}`;
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
  /** Present in the trigger payload (to_jsonb(new)); re-read before use. */
  clip_status?: string;
  score?: number;
}

function isEventRow(value: unknown): value is EventRow {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["id", "node_id", "camera_id", "kind", "started_at"].every(
    (key) => typeof row[key] === "string" && row[key] !== "",
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Event time in the recipient's own zone. Falls back to UTC (clearly labelled)
 * when we have not learned their timezone yet — an unlabelled wrong time is
 * worse than a labelled inconvenient one.
 */
export function formatLocalTime(iso: string, timeZone: string | null): string {
  const d = new Date(iso);
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
    } catch {
      // invalid zone string — fall through to UTC
    }
  }
  return `${utcHhMm(iso)} UTC`;
}

/**
 * Compact hh:mm in the recipient's zone, for SMS.
 *
 * formatLocalTime's weekday + 12-hour rendering is too expensive for a
 * single-segment SMS, but sending UTC is worse than verbose: an alert reading
 * "04:35" for something that happened at 21:35 local reads as a stale alert
 * about the middle of the night. 24-hour en-GB gives a zero-padded hh:mm.
 * Without a known zone we say UTC out loud rather than imply local time.
 */
function compactLocalHhMm(iso: string, timeZone: string | null): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(iso));
    } catch {
      // invalid zone string — fall through to labelled UTC
    }
  }
  return `${utcHhMm(iso)} UTC`;
}

function utcHhMm(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** External send timeout — never let a slow provider hold the function open. */
const SEND_TIMEOUT_MS = 5_000;
/**
 * How long the email waits for the clip thumbnail to finish uploading before
 * sending without it: 6 attempts, 2.5s apart, so ~15s worst case. Long enough
 * for a normal clip upload, short enough that a stuck upload does not sit on
 * the alert.
 */
const THUMBNAIL_WAIT_ATTEMPTS = 6;
const THUMBNAIL_WAIT_INTERVAL_MS = 2_500;

export function buildPayload(
  event: EventRow,
  cameraName: string,
  link: ClipLink | null = null,
): string {
  const startedAt = new Date(event.started_at);
  return JSON.stringify({
    title: `${capitalize(event.kind)} — ${cameraName}`,
    body: `at ${utcHhMm(event.started_at)}`,
    // The service worker reformats the body in device-local time from this.
    timestamp: startedAt.getTime(),
    tag: `nightjar-${event.camera_id}`,
    // Absolute when we have a clip link (nightjar.ca / drive.google.com are a
    // different origin than the app) — the service worker openWindow()s it.
    url: link?.url ?? "/events",
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
export interface EmailExtras {
  /** Signed thumbnail URL — the hero image. Clients that block images still
   *  get a complete, readable email. */
  thumbnailUrl?: string | null;
  /** Detection confidence 0..1, shown as a percentage when present. */
  score?: number | null;
  timeZone?: string | null;
}

export function buildEmailHtml(
  kind: string,
  cameraName: string,
  startedAtIso: string,
  link: ClipLink | null = null,
  now: Date = new Date(),
  extras: EmailExtras = {},
): string {
  const kindLabel = escapeHtml(capitalize(kind));
  const camera = escapeHtml(cameraName);
  const time = escapeHtml(formatLocalTime(startedAtIso, extras.timeZone ?? null));
  const confidence =
    typeof extras.score === "number" && extras.score > 0
      ? `${Math.round(extras.score * 100)}% confidence`
      : null;
  // The amber CTA becomes "Watch clip" whenever we have a link, with a muted
  // line under it saying what kind of link it is; otherwise it stays the
  // original "View events" button and there is no note.
  const ctaHref = escapeHtml(link?.url ?? EVENTS_URL);
  const ctaLabel = link ? "Watch clip" : "View events";
  const note = buildLinkNote(link, now);
  const font =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  // Hero: the thumbnail, wrapped in the same link as the CTA so tapping the
  // picture does the obvious thing. Omitted entirely when there is no clip.
  const heroRow = extras.thumbnailUrl
    ? `
        <tr>
          <td style="padding:22px 20px 0 20px;">
            <a href="${escapeHtml(link?.url ?? EVENTS_URL)}" target="_blank" style="text-decoration:none;">
              <img src="${escapeHtml(extras.thumbnailUrl)}" width="440" alt="${kindLabel} at ${camera}"
                style="display:block;width:100%;max-width:440px;height:auto;border-radius:12px;border:1px solid #232a3b;" />
            </a>
          </td>
        </tr>`
    : "";
  const metaLine = confidence ? `at ${camera} &middot; ${time} &middot; ${escapeHtml(confidence)}` : `at ${camera} &middot; ${time}`;
  const noteRow = note
    ? `
              <tr>
                <td style="padding:10px 2px 0 2px;font-family:${font};font-size:12px;line-height:1.5;color:#5b6375;">
                  ${escapeHtml(note)}
                </td>
              </tr>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;background-color:#0a0c13;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="480" style="width:100%;max-width:480px;background-color:#131722;border:1px solid #232a3b;border-radius:16px;">
        <tr>
          <td style="padding:28px 32px 0 32px;font-family:${font};">
            <span style="font-size:16px;font-weight:600;letter-spacing:0.02em;color:#e8eaf0;">nightjar<span style="color:#f0a441;">.</span></span>
          </td>
        </tr>
        ${heroRow}
        <tr>
          <td style="padding:22px 32px 6px 32px;font-family:${font};font-size:26px;line-height:1.25;font-weight:700;color:#ffffff;">
            ${kindLabel} detected
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px;font-family:${font};font-size:14px;line-height:1.5;color:#8b93a7;">
            ${metaLine}
          </td>
        </tr>
        <tr>
          <td style="padding:26px 32px 30px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="border-radius:10px;background-color:#f0a441;">
                  <a href="${ctaHref}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:${font};font-size:14px;font-weight:700;color:#0a0c13;text-decoration:none;border-radius:10px;">${ctaLabel}</a>
                </td>
              </tr>${noteRow}
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

export function buildEmailText(
  kind: string,
  cameraName: string,
  startedAtIso: string,
  link: ClipLink | null = null,
  timeZone: string | null = null,
  now: Date = new Date(),
): string {
  const note = buildLinkNote(link, now);
  return [
    `${capitalize(kind)} detected at ${cameraName} - ${formatLocalTime(startedAtIso, timeZone)}.`,
    "",
    link ? `Watch clip: ${link.url}` : `View events: ${EVENTS_URL}`,
    ...(note ? [note] : []),
    "",
    `You're getting this because ${kind} alerts are on. Manage at https://app.nightjar.ca/settings`,
  ].join("\n");
}

/* ---------- sms (Magpipe) ---------- */

/**
 * Whether alert SMS may contain a URL.
 *
 * Off by default, and that is not a style choice. Carriers spam-filter
 * link-bearing SMS from unregistered long codes, and they do it silently: the
 * send returns 200, the message is accepted, and the delivery receipt comes
 * back "undelivered" with error 30007. Confirmed by A/B test on the live
 * sender, seconds apart to the same handset — the message carrying an
 * app.nightjar.ca link was filtered, the identical message without one was
 * delivered. Every linked alert was being dropped while both our logs and the
 * deliveries table said "sent".
 *
 * Note this is not the US A2P 10DLC regime, which Canadian carriers do not
 * use. Rogers/Bell/Telus filter unregistered A2P traffic on their own, and
 * Canadian long codes bought on or after 2025-03-26 additionally need A2P
 * registration or Persona verification even for Canada-only sending. Our
 * sender was bought well after that date, so it is unregistered either way.
 *
 * Dropping the link costs a tap-through and makes the alert actually arrive,
 * which is the whole point of an alert. Set SMS_INCLUDE_LINK=true to restore
 * links once the sender is registered/verified (or moved to a toll-free
 * number, which is exempt from the long-code rules).
 */
function smsLinksAllowed(): boolean {
  return (Deno.env.get("SMS_INCLUDE_LINK") ?? "").toLowerCase() === "true";
}

/**
 * Single-segment, GSM-7-safe SMS: no emoji, plain hyphen instead of an em
 * dash (both would force UCS-2 and shrink the segment to 70 chars); camera
 * name truncated so the whole message stays <= 160 chars.
 *
 * With links enabled the clip link replaces the tail:
 *   "Nightjar: Person at Backyard, 14:32 - https://app.nightjar.ca/s/<token>"
 * base64url share tokens (A-Za-z0-9-_) and Drive URLs are all inside the
 * GSM-7 basic alphabet, so the single-segment budget still holds. A link long
 * enough to squeeze the camera name below MIN_SMS_CAMERA_CHARS is dropped in
 * favour of the events page rather than sent as a multi-segment message.
 *
 * With links disabled (the default — see smsLinksAllowed) the message carries
 * no URL at all, not even a bare domain: carrier filters match on the domain,
 * not the scheme, so "app.nightjar.ca/events" trips 30007 just as readily as
 * the full https:// form.
 */
export function buildSmsMessage(
  kind: string,
  cameraName: string,
  startedAtIso: string,
  link: ClipLink | null = null,
  allowLinks: boolean = smsLinksAllowed(),
  timeZone: string | null = null,
): string {
  const prefix = `Nightjar: ${capitalize(kind)} at `;
  const time = compactLocalHhMm(startedAtIso, timeZone);
  if (!allowLinks) {
    const suffix = ` at ${time}`;
    const room = Math.max(0, 160 - prefix.length - suffix.length);
    return `${prefix}${cameraName.slice(0, room)}${suffix}`;
  }
  const fallbackSuffix = `, ${time} - app.nightjar.ca/events`;
  let suffix = link ? `, ${time} - ${link.url}` : fallbackSuffix;
  if (160 - prefix.length - suffix.length < MIN_SMS_CAMERA_CHARS) suffix = fallbackSuffix;
  const room = Math.max(0, 160 - prefix.length - suffix.length);
  const name = cameraName.length > room ? cameraName.slice(0, room) : cameraName;
  return `${prefix}${name}${suffix}`;
}

/* ---------- clip link resolution ---------- */

type Admin = ReturnType<typeof adminClient>;

/** 24 random bytes, base64url — same shape as share-clip's tokens. */
function generateShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The link this alert should carry, in preference order:
 *   1. link_source === "drive" AND event_clips.drive_url present -> that URL.
 *      (The user opted into their own storage; the node writes drive_url when
 *      backup.gdrive.shareLinks is on.)
 *   2. clip_links on AND the clip is uploaded/uploading -> a Nightjar share.
 *      An existing unexpired, unrevoked share for the event is REUSED so a
 *      retry does not litter clip_shares with tokens; otherwise a fresh
 *      7-day, caption-less row is inserted here with the service role. We do
 *      NOT call the share-clip function: it authenticates a human JWT, which
 *      this service-to-service path does not have.
 *   3. otherwise null -> callers fall back to the /events page as before.
 *
 * Never throws: a link is a nice-to-have, and losing it must not lose the
 * alert.
 */
export async function resolveClipLink(
  admin: Admin,
  event: EventRow,
  ownerId: string,
  settings: NotifySettings | null,
  now: Date,
): Promise<ClipLink | null> {
  if (!clipLinksEnabled(settings)) return null;
  try {
    // clip_status is re-read rather than trusted from the trigger payload:
    // pg_net delivers asynchronously, so the upload may already have landed.
    const [freshEvent, clipRow] = await Promise.all([
      admin.from("events").select("clip_status").eq("id", event.id).maybeSingle(),
      admin.from("event_clips").select("drive_url").eq("event_id", event.id).maybeSingle(),
    ]);
    const clipStatus = freshEvent.data?.clip_status ?? event.clip_status ?? null;

    if (linkSource(settings) === "drive") {
      const driveUrl = clipRow.data?.drive_url ?? null;
      if (typeof driveUrl === "string" && driveUrl !== "") {
        return { url: driveUrl, source: "drive", expiresAt: null };
      }
      // Drive preferred but this clip has no Drive copy (backup off, still
      // queued, or share links not enabled) — fall through to a Nightjar
      // share rather than dropping the link entirely.
    }

    if (clipStatus === null || !LINKABLE_CLIP_STATUSES.includes(clipStatus)) return null;

    const { data: existing } = await admin
      .from("clip_shares")
      .select("token, expires_at")
      .eq("event_id", event.id)
      .eq("owner_id", ownerId)
      .is("revoked_at", null)
      .gt("expires_at", now.toISOString())
      .order("expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.token) {
      return {
        url: `${SHARE_BASE_URL}${existing.token}`,
        source: "nightjar",
        expiresAt: existing.expires_at,
      };
    }

    const expiresAt = new Date(now.getTime() + SHARE_EXPIRY_DAYS * 86_400_000).toISOString();
    const { data: minted, error } = await admin
      .from("clip_shares")
      .insert({
        token: generateShareToken(),
        event_id: event.id,
        owner_id: ownerId,
        caption: null,
        expires_at: expiresAt,
      })
      .select("token, expires_at")
      .single();
    if (error || !minted) {
      console.error("clip share mint failed:", error?.message ?? "no row returned");
      return null;
    }
    return {
      url: `${SHARE_BASE_URL}${minted.token}`,
      source: "nightjar",
      expiresAt: minted.expires_at,
    };
  } catch (err) {
    console.error("clip link resolution failed:", err);
    return null;
  }
}

/* ---------- per-channel senders ---------- */

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
  link: ClipLink | null,
): Promise<PushOutcome> {
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", ownerId);
  if (!subs || subs.length === 0) {
    return { status: "skipped", detail: "no subscriptions", sent: 0, failed: 0, removed: 0 };
  }

  const payload = buildPayload(event, cameraName, link);
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
  link: ClipLink | null,
  timeZone: string | null = null,
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

  // Hero image: a signed thumbnail URL. Mail clients proxy and cache the image
  // at delivery, so the short TTL is fine; a failure here just drops the image.
  let thumbnailUrl: string | null = null;
  try {
    // Wait for the thumbnail before giving up on it.
    //
    // events_notify fires AFTER INSERT, and the node inserts the row with
    // clip_status 'uploading' *before* it uploads anything — thumbnail_path is
    // still null at that moment and only lands seconds later. Reading it once,
    // as this did, therefore meant a real alert never carried an image; the
    // only emails that did were ones re-triggered by hand against events whose
    // upload had long since finished, which is exactly how the bug survived
    // being "verified".
    //
    // Only the email waits. Push and SMS are dispatched in parallel by the
    // caller and still go out immediately, so the alert is not delayed — just
    // its picture. If the upload is slower than the budget the email goes out
    // without the image, which is what happened on every alert before this.
    let thumbnailPath: string | null = null;
    for (let attempt = 0; attempt < THUMBNAIL_WAIT_ATTEMPTS; attempt++) {
      const { data: row } = await admin
        .from("events")
        .select("thumbnail_path")
        .eq("id", event.id)
        .maybeSingle();
      thumbnailPath = row?.thumbnail_path ?? null;
      if (thumbnailPath) break;
      if (attempt < THUMBNAIL_WAIT_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, THUMBNAIL_WAIT_INTERVAL_MS));
      }
    }
    const clip = { thumbnail_path: thumbnailPath };
    if (clip?.thumbnail_path) {
      const { data: signed } = await admin.storage
        .from("event-clips")
        .createSignedUrl(clip.thumbnail_path, 60 * 60 * 24 * 7);
      thumbnailUrl = signed?.signedUrl ?? null;
    }
  } catch {
    // image is a nicety, not a requirement
  }

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
      HtmlBody: buildEmailHtml(event.kind, cameraName, event.started_at, link, new Date(), {
        thumbnailUrl,
        score: typeof event.score === "number" ? event.score : null,
        timeZone,
      }),
      TextBody: buildEmailText(event.kind, cameraName, event.started_at, link, timeZone),
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
  link: ClipLink | null,
  timeZone: string | null = null,
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
      message: buildSmsMessage(
        event.kind,
        cameraName,
        event.started_at,
        link,
        smsLinksAllowed(),
        timeZone,
      ),
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

  const now = new Date();
  const decision = decideNotify({
    kind: event.kind,
    settings,
    lastDeliveryAt: lastDelivery?.sent_at ?? null,
    now,
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
  let timeZone: string | null = null;
  if (wantEmail || wantSms) {
    const { data: profile } = await admin
      .from("profiles")
      .select("notify_email, notify_phone, timezone")
      .eq("id", ownerId)
      .maybeSingle();
    notifyEmail = profile?.notify_email ?? null;
    notifyPhone = profile?.notify_phone ?? null;
    timeZone = profile?.timezone ?? null;
  }

  // One link per alert moment, shared by every channel — so the SMS, the
  // email CTA and the push all open the same clip, and we mint at most one
  // share per event no matter how many channels fire.
  const link = await resolveClipLink(admin, event, ownerId, settings, now);

  // Fan out. Each entry resolves to a labeled outcome; log-and-continue on
  // failure — one broken provider must not block the other channels.
  const tasks: { channel: "push" | "email" | "sms"; run: () => Promise<PushOutcome | SendOutcome> }[] = [];
  if (wantPush) {
    tasks.push({ channel: "push", run: () => sendPush(admin, ownerId, event, cameraName, link) });
  }
  if (wantEmail) {
    tasks.push({
      channel: "email",
      run: () => sendEmail(admin, ownerId, notifyEmail, event, cameraName, link, timeZone),
    });
  }
  if (wantSms) {
    tasks.push({
      channel: "sms",
      run: () =>
        notifyPhone
          ? sendSms(notifyPhone, event, cameraName, link, timeZone)
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

  return json({ delivered: deliveredChannels, outcomes, link: link?.source ?? null });
});
