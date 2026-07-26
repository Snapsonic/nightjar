import { z } from "zod";

export const CameraCapabilities = z.object({
  hasSubstream: z.boolean().default(false),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  /** True when the source publishes an audio track (ffprobe for RTSP cameras,
   *  SDM audio traits for Nest). Absent on configs saved by older builds. */
  hasAudio: z.boolean().optional(),
  /** Two-way audio: "backchannel" means the camera can receive audio sent
   *  back through its stream (RTSP/ONVIF Profile T backchannel — go2rtc
   *  forwards browser mic audio automatically). Nest cameras bridged over
   *  legacy RTSP can never receive audio (SDM has no talkback there), so
   *  they stay "none". For plain RTSP cameras this is a config field the
   *  user can flip to "backchannel"; it survives re-probes.
   *  TODO: auto-detect ONVIF backchannel support instead of relying on the
   *  user-set flag. */
  talkback: z.enum(["none", "backchannel"]).default("none"),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
});
export type CameraCapabilities = z.infer<typeof CameraCapabilities>;

/** One polygon vertex in normalized 0..1 image coordinates ([x, y]). */
export const ZonePoint = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export type ZonePoint = z.infer<typeof ZonePoint>;

/**
 * Activity zone: a named polygon over the camera image. Only motion/detections
 * inside a zone count. An empty zones list means the whole frame is active
 * (the pre-zones behavior). "exclude" mode is reserved for later — the enum
 * exists now so configs stay forward-compatible.
 */
export const Zone = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(40),
  points: z.array(ZonePoint).min(3).max(20),
  mode: z.enum(["include"]).default("include"),
});
export type Zone = z.infer<typeof Zone>;

/** Sanity cap on zones per camera (protocol + editor enforce it too). */
export const MAX_ZONES_PER_CAMERA = 16;

/** Nest (Google Smart Device Management) camera binding. The device id is an
 *  opaque SDM identifier — not a credential (useless without the node's own
 *  OAuth grant), so it may appear in the CameraPublic projection. */
export const NestCameraSource = z.object({
  deviceId: z.string().min(1),
  /** SDM live-stream protocols (e.g. ["RTSP"] or ["WEB_RTC"]). go2rtc's nest
   *  source defaults to WebRTC, so RTSP-generation cameras MUST carry this —
   *  omitting it makes go2rtc call GenerateWebRtcStream and Google 400s. */
  protocols: z.array(z.string()).default([]),
});
export type NestCameraSource = z.infer<typeof NestCameraSource>;

/**
 * Base object schema (no cross-field rules) so projections like CameraPublic
 * can still use .omit(); CameraConfig below adds the source/url invariants.
 */
const CameraConfigBase = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  make: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  /** Where the video comes from: a plain RTSP camera (default) or a Nest
   *  camera bridged through go2rtc's native `nest:` source. */
  source: z.enum(["rtsp", "nest"]).default("rtsp"),
  /** Main (high-res) RTSP URL. May contain credentials — never leaves the
   *  node. Required when source is "rtsp"; absent for "nest". */
  rtspUrl: z.string().url().optional(),
  /** Optional low-res substream used for motion detection and remote live view. */
  rtspSubUrl: z.string().url().optional(),
  /** Required when source is "nest". */
  nest: NestCameraSource.optional(),
  enabled: z.boolean().default(true),
  record: z.boolean().default(true),
  detect: z.boolean().default(true),
  capabilities: CameraCapabilities.default({}),
  /** Activity zones. Empty (the default, and what legacy configs parse to)
   *  means the whole frame is active. Not a credential — included in
   *  CameraPublic and synced to the cloud so the web UI can edit them. */
  zones: z.array(Zone).max(MAX_ZONES_PER_CAMERA).default([]),
});

export const CameraConfig = CameraConfigBase.superRefine((camera, ctx) => {
  if (camera.source === "rtsp" && camera.rtspUrl === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rtspUrl"],
      message: 'rtspUrl is required when source is "rtsp"',
    });
  }
  if (camera.source === "nest" && camera.nest === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nest"],
      message: 'nest.deviceId is required when source is "nest"',
    });
  }
});
export type CameraConfig = z.infer<typeof CameraConfig>;

/** Cloud-safe projection of a camera — everything except stream URLs/credentials. */
export const CameraPublic = CameraConfigBase.omit({ rtspUrl: true, rtspSubUrl: true });
export type CameraPublic = z.infer<typeof CameraPublic>;

export const go2rtcStreamName = (cameraId: string, sub = false) =>
  `cam_${cameraId}${sub ? "_sub" : ""}`;

/** go2rtc's RTSP restream module — enabled by default on this port. Nest
 *  cameras have no direct RTSP URL, so the recorder/motion detector pull
 *  them back out of go2rtc here. */
export const GO2RTC_RTSP_PORT = 8554;
