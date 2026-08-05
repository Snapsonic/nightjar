import { z } from "zod";
import {
  MAX_QUIET_WINDOWS_PER_CAMERA,
  MAX_ZONES_PER_CAMERA,
  QuietWindow,
  Zone,
} from "./camera";

/**
 * Messages exchanged over the per-node Supabase Realtime channel
 * (topic `node:{nodeId}`, private). Browser <-> node signaling and commands.
 *
 * Every request carries a client-generated `requestId`; the node echoes it in
 * the reply so multiple browsers (or tabs) can multiplex one channel.
 */

export const REALTIME_BROADCAST_EVENT = "nightjar";

export const nodeTopic = (nodeId: string) => `node:${nodeId}`;

const base = { requestId: z.string().min(1) };

export const WhepOffer = z.object({
  type: z.literal("whep_offer"),
  ...base,
  cameraId: z.string().uuid(),
  /** Use the low-res substream when available (default for remote view). */
  sub: z.boolean().default(true),
  sdp: z.string().min(1),
});

export const WhepAnswer = z.object({
  type: z.literal("whep_answer"),
  ...base,
  sdp: z.string().min(1),
});

export const SnapshotRequest = z.object({
  type: z.literal("snapshot_request"),
  ...base,
  cameraId: z.string().uuid(),
});

export const SnapshotReply = z.object({
  type: z.literal("snapshot_reply"),
  ...base,
  /** Signed Supabase Storage URL, short TTL. */
  url: z.string().url(),
});

export const NodeStatusRequest = z.object({
  type: z.literal("status_request"),
  ...base,
});

export const NodeStatusReply = z.object({
  type: z.literal("status_reply"),
  ...base,
  version: z.string(),
  uptimeSec: z.number(),
  cameras: z.array(
    z.object({
      cameraId: z.string().uuid(),
      online: z.boolean(),
      recording: z.boolean(),
      /** True when the recorder indexed a segment recently (capture liveness). */
      capturing: z.boolean().optional(),
      /**
       * Fraction (0..1) of the recent window this camera has footage for.
       * `capturing` only says a segment landed lately; this says how much of
       * the time was actually recorded, so a camera that keeps reconnecting
       * stops reading as perfectly healthy.
       */
      coverage: z.number().min(0).max(1).optional(),
      /** ISO time of the newest indexed recording segment, when any exists. */
      lastSegmentAt: z.string().optional(),
    }),
  ),
  disk: z.object({ usedBytes: z.number(), totalBytes: z.number() }).optional(),
});

/* ---------- timeline (24/7 recording playback) ---------- */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const TimelineDaysRequest = z.object({
  type: z.literal("timeline_days_request"),
  ...base,
  cameraId: z.string().uuid(),
});

export const TimelineDaysReply = z.object({
  type: z.literal("timeline_days_reply"),
  ...base,
  cameraId: z.string().uuid(),
  /** Node-local days (YYYY-MM-DD) with at least one recorded segment, ascending. */
  days: z.array(z.string().regex(DAY_RE)),
});

export const TimelineCoverageRequest = z.object({
  type: z.literal("timeline_coverage_request"),
  ...base,
  cameraId: z.string().uuid(),
  day: z.string().regex(DAY_RE),
});

export const TimelineCoverageReply = z.object({
  type: z.literal("timeline_coverage_reply"),
  ...base,
  cameraId: z.string().uuid(),
  day: z.string().regex(DAY_RE),
  /** Merged recorded spans (unix ms; adjacent segments within 2s joined). */
  spans: z.array(z.object({ startMs: z.number(), endMs: z.number() })),
});

export const TimelinePreviewRequest = z.object({
  type: z.literal("timeline_preview_request"),
  ...base,
  cameraId: z.string().uuid(),
  /** Instant to preview (unix ms). The node buckets it to the minute. */
  atMs: z.number().int().nonnegative(),
});

export const TimelinePreviewReply = z.object({
  type: z.literal("timeline_preview_reply"),
  ...base,
  /** Signed Supabase Storage URL for the preview JPEG (10 min TTL). */
  url: z.string().url(),
});

export const TimelineExportRequest = z.object({
  type: z.literal("timeline_export_request"),
  ...base,
  cameraId: z.string().uuid(),
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative(),
});

export const TimelineExportReply = z.object({
  type: z.literal("timeline_export_reply"),
  ...base,
  /** Signed Supabase Storage URL for the exported clip (1h TTL). */
  url: z.string().url(),
});

/* ---------- activity zones ---------- */

/** Replace a camera's activity zones (the web editor's save path). The node
 *  validates with the shared Zone schema, persists via the camera manager and
 *  rebuilds its motion masks; the zones also ride along on the next camera
 *  row sync to the cloud. */
export const UpdateZonesRequest = z.object({
  type: z.literal("update_zones_request"),
  ...base,
  cameraId: z.string().uuid(),
  zones: z.array(Zone).max(MAX_ZONES_PER_CAMERA),
});

export const UpdateZonesReply = z.object({
  type: z.literal("update_zones_reply"),
  ...base,
  ok: z.literal(true),
});

/* ---------- quiet hours ---------- */

/** Replace a camera's quiet windows (the camera page's schedule editor). The
 *  node validates with the shared QuietWindow schema, persists via the camera
 *  manager, and the windows ride along on the next camera row sync. */
export const UpdateQuietHoursRequest = z.object({
  type: z.literal("update_quiet_hours_request"),
  ...base,
  cameraId: z.string().uuid(),
  quietHours: z.array(QuietWindow).max(MAX_QUIET_WINDOWS_PER_CAMERA),
});

export const UpdateQuietHoursReply = z.object({
  type: z.literal("update_quiet_hours_reply"),
  ...base,
  ok: z.literal(true),
});

/* ---------- Google Drive backup ("bring your own cloud") ---------- */

export const GdriveQuota = z.object({
  usageBytes: z.number().nonnegative(),
  /** null when the account reports no storage limit. */
  limitBytes: z.number().nonnegative().nullable(),
});

/**
 * The node's Drive-backup state, relayed to the cloud dashboard so Drive can
 * be connected from app.nightjar.ca instead of only the node's LAN UI.
 *
 * Deliberately token-free: the OAuth refresh/access tokens live only in
 * `${CONFIG_DIR}/gdrive-token.json` on the node and never touch this channel.
 * The one credential-adjacent value here is the device-flow `userCode`, which
 * is worthless on its own — it only becomes a grant once the signed-in user
 * approves it at `verificationUrl`. The device flow explicitly allows the
 * approving device to differ from the device showing the code, which is what
 * makes this relay safe.
 *
 * Zod strips unknown keys, so even a mistaken extra field on the node side
 * cannot ride along to the browser.
 */
const gdriveStatusFields = {
  status: z.enum(["notConfigured", "disconnected", "connecting", "connected", "error"]),
  /** connected: Google account holding the grant (null when not yet known). */
  email: z.string().nullable().optional(),
  /** connected: Drive folder clips are filed under. */
  folderName: z.string().optional(),
  /** connected: backup.gdrive.enabled. */
  enabled: z.boolean().optional(),
  /** connected: backup.gdrive.shareLinks. */
  shareLinks: z.boolean().optional(),
  /** connected: jobs waiting in the node's gdrive_queue. */
  queued: z.number().int().nonnegative().optional(),
  quota: GdriveQuota.nullable().optional(),
  /** connecting: the short code to type at `verificationUrl`. */
  userCode: z.string().optional(),
  verificationUrl: z.string().optional(),
  /** connecting: ISO time the code stops working. */
  expiresAt: z.string().optional(),
  /** error: human-readable reason. */
  message: z.string().optional(),
};

export const GdriveStatusRequest = z.object({
  type: z.literal("gdrive_status_request"),
  ...base,
});

export const GdriveStatusReply = z.object({
  type: z.literal("gdrive_status_reply"),
  ...base,
  ...gdriveStatusFields,
});

/** Start the device flow; the reply carries the connecting state + userCode. */
export const GdriveConnectRequest = z.object({
  type: z.literal("gdrive_connect_request"),
  ...base,
});

export const GdriveConnectReply = z.object({
  type: z.literal("gdrive_connect_reply"),
  ...base,
  ...gdriveStatusFields,
});

/** Flip either backup switch; omitted fields are left alone. */
export const GdriveToggleRequest = z.object({
  type: z.literal("gdrive_toggle_request"),
  ...base,
  enabled: z.boolean().optional(),
  shareLinks: z.boolean().optional(),
});

export const GdriveToggleReply = z.object({
  type: z.literal("gdrive_toggle_reply"),
  ...base,
  ...gdriveStatusFields,
});

/** Revoke the grant at Google and delete the node's token file. */
export const GdriveDisconnectRequest = z.object({
  type: z.literal("gdrive_disconnect_request"),
  ...base,
});

export const GdriveDisconnectReply = z.object({
  type: z.literal("gdrive_disconnect_reply"),
  ...base,
  ...gdriveStatusFields,
});

/** The status payload shared by all four Drive replies (sans envelope). */
export type GdriveStatusPayload = Omit<z.infer<typeof GdriveStatusReply>, "type" | "requestId">;

export const ErrorReply = z.object({
  type: z.literal("error"),
  ...base,
  code: z.enum(["camera_not_found", "camera_offline", "go2rtc_unreachable", "internal"]),
  message: z.string(),
});

export const RealtimeMessage = z.discriminatedUnion("type", [
  WhepOffer,
  WhepAnswer,
  SnapshotRequest,
  SnapshotReply,
  NodeStatusRequest,
  NodeStatusReply,
  TimelineDaysRequest,
  TimelineDaysReply,
  TimelineCoverageRequest,
  TimelineCoverageReply,
  TimelinePreviewRequest,
  TimelinePreviewReply,
  TimelineExportRequest,
  TimelineExportReply,
  UpdateZonesRequest,
  UpdateZonesReply,
  UpdateQuietHoursRequest,
  UpdateQuietHoursReply,
  GdriveStatusRequest,
  GdriveStatusReply,
  GdriveConnectRequest,
  GdriveConnectReply,
  GdriveToggleRequest,
  GdriveToggleReply,
  GdriveDisconnectRequest,
  GdriveDisconnectReply,
  ErrorReply,
]);
export type RealtimeMessage = z.infer<typeof RealtimeMessage>;

/* ---------- Edge function payloads ---------- */

export const NodeRegisterRequest = z.object({
  nodeSecret: z.string().min(32),
  nodeName: z.string().min(1).max(80),
  version: z.string(),
});
export const NodeRegisterResponse = z.object({
  nodeId: z.string().uuid(),
  claimCode: z.string().length(6),
  claimCodeExpiresAt: z.string().datetime(),
});

export const NodeClaimRequest = z.object({
  claimCode: z.string().length(6),
  siteName: z.string().min(1).max(80).optional(),
});
export const NodeClaimResponse = z.object({
  nodeId: z.string().uuid(),
  siteId: z.string().uuid(),
});

export const NodeTokenRequest = z.object({
  nodeId: z.string().uuid(),
  nodeSecret: z.string().min(32),
});
export const NodeTokenResponse = z.object({
  /** Supabase-signed JWT with app_metadata.node_id, ~1h TTL. */
  accessToken: z.string(),
  expiresAt: z.string().datetime(),
  claimed: z.boolean(),
});

export const SignUploadRequest = z.object({
  eventId: z.string().uuid(),
  files: z.array(z.enum(["clip.mp4", "thumb.jpg"])).min(1),
});
export const SignUploadResponse = z.object({
  uploads: z.array(
    z.object({
      file: z.string(),
      path: z.string(),
      token: z.string(),
    }),
  ),
});

export const TurnCredentialsResponse = z.object({
  iceServers: z.array(
    z.object({
      urls: z.union([z.string(), z.array(z.string())]),
      username: z.string().optional(),
      credential: z.string().optional(),
    }),
  ),
  ttlSec: z.number(),
});

export const DEFAULT_STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

/** share-clip {action:"status"} / {action:"revoke_all"} response. */
export const ShareStatusResponse = z.object({
  sharingEnabled: z.boolean().default(true),
  defaultExpiryDays: z.number().int().default(7),
  activeShares: z.number().int().default(0),
  revoked: z.number().int().optional(),
});
