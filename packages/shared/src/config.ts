import { z } from "zod";
import { CameraConfig } from "./camera";

export const RetentionConfig = z.object({
  maxDays: z.number().int().min(1).max(365).default(14),
  /** Stop-recording safety margin: prune oldest when disk usage crosses this fraction. */
  diskHighWatermark: z.number().min(0.5).max(0.99).default(0.9),
});

export const CloudConfig = z.object({
  enabled: z.boolean().default(true),
  supabaseUrl: z.string().url().optional(),
  supabaseAnonKey: z.string().optional(),
});

export const NodeConfig = z.object({
  version: z.literal(1).default(1),
  nodeName: z.string().min(1).max(80).default("nightjar-node"),
  cameras: z.array(CameraConfig).default([]),
  retention: RetentionConfig.default({}),
  cloud: CloudConfig.default({}),
  go2rtc: z
    .object({
      apiUrl: z.string().url().default("http://127.0.0.1:1984"),
    })
    .default({}),
  paths: z
    .object({
      recordings: z.string().default("/recordings"),
      db: z.string().default("/db"),
    })
    .default({}),
});
export type NodeConfig = z.infer<typeof NodeConfig>;
