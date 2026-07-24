import { z } from "zod";

export const CameraCapabilities = z.object({
  hasSubstream: z.boolean().default(false),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
});
export type CameraCapabilities = z.infer<typeof CameraCapabilities>;

export const CameraConfig = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  make: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  /** Main (high-res) RTSP URL. May contain credentials — never leaves the node. */
  rtspUrl: z.string().url(),
  /** Optional low-res substream used for motion detection and remote live view. */
  rtspSubUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
  record: z.boolean().default(true),
  detect: z.boolean().default(true),
  capabilities: CameraCapabilities.default({}),
});
export type CameraConfig = z.infer<typeof CameraConfig>;

/** Cloud-safe projection of a camera — everything except stream URLs/credentials. */
export const CameraPublic = CameraConfig.omit({ rtspUrl: true, rtspSubUrl: true });
export type CameraPublic = z.infer<typeof CameraPublic>;

export const go2rtcStreamName = (cameraId: string, sub = false) =>
  `cam_${cameraId}${sub ? "_sub" : ""}`;
