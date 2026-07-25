import { z } from "zod";

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
  TimelineExportRequest,
  TimelineExportReply,
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
