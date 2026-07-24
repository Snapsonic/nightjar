import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { CameraCapabilities, CameraConfig } from "@nightjar/shared";
import type { ConfigStore } from "../config/store.js";
import type { Logger } from "../log.js";

const execFileAsync = promisify(execFile);

const FfprobeStream = z.object({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
});
const FfprobeOutput = z.object({ streams: z.array(FfprobeStream).default([]) });

function parseFps(...rates: (string | undefined)[]): number | undefined {
  for (const rate of rates) {
    if (!rate) continue;
    const [numRaw, denRaw] = rate.split("/");
    const num = Number(numRaw);
    const den = denRaw === undefined ? 1 : Number(denRaw);
    if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
      return Math.round((num / den) * 100) / 100;
    }
  }
  return undefined;
}

/** Probe an RTSP URL with ffprobe (TCP transport, 10s timeout). */
export async function probe(rtspUrl: string): Promise<CameraCapabilities> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_streams", "-rtsp_transport", "tcp", rtspUrl],
    { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const parsed = FfprobeOutput.parse(JSON.parse(stdout));
  const video = parsed.streams.find((s) => s.codec_type === "video");
  const audio = parsed.streams.find((s) => s.codec_type === "audio");
  if (!video) throw new Error("no video stream found");
  return CameraCapabilities.parse({
    hasSubstream: false, // set by the caller based on rtspSubUrl
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name,
    width: video.width,
    height: video.height,
    fps: parseFps(video.avg_frame_rate, video.r_frame_rate),
  });
}

export interface AddCameraInput {
  name: string;
  rtspUrl: string;
  rtspSubUrl?: string;
  make?: string;
  model?: string;
}

/** CRUD over the cameras array in NodeConfig, persisted via the config store. */
export class CameraManager {
  constructor(
    private readonly store: ConfigStore,
    private readonly log: Logger,
  ) {}

  list(): CameraConfig[] {
    return this.store.get().cameras;
  }

  get(id: string): CameraConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  /** Add a camera. Probes the RTSP URL but tolerates probe failure. */
  async addCamera(input: AddCameraInput): Promise<CameraConfig> {
    let capabilities = CameraCapabilities.parse({});
    try {
      capabilities = await probe(input.rtspUrl);
    } catch (err) {
      this.log.warn(
        `probe failed for "${input.name}" — adding with empty capabilities: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    capabilities.hasSubstream = input.rtspSubUrl !== undefined;

    const camera = CameraConfig.parse({
      id: randomUUID(),
      name: input.name,
      make: input.make,
      model: input.model,
      rtspUrl: input.rtspUrl,
      rtspSubUrl: input.rtspSubUrl,
      capabilities,
    });
    this.store.update({ cameras: [...this.list(), camera] });
    this.log.info(`added camera "${camera.name}" (${camera.id})`);
    return camera;
  }

  updateCamera(id: string, patch: Partial<Omit<CameraConfig, "id">>): CameraConfig | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const updated = CameraConfig.parse({ ...existing, ...patch, id });
    this.store.update({ cameras: this.list().map((c) => (c.id === id ? updated : c)) });
    return updated;
  }

  removeCamera(id: string): boolean {
    const cameras = this.list();
    if (!cameras.some((c) => c.id === id)) return false;
    this.store.update({ cameras: cameras.filter((c) => c.id !== id) });
    this.log.info(`removed camera ${id}`);
    return true;
  }

  /** Re-probe a camera and persist the refreshed capabilities. Throws on probe failure. */
  async probeCamera(id: string): Promise<CameraCapabilities | undefined> {
    const camera = this.get(id);
    if (!camera) return undefined;
    const capabilities = await probe(camera.rtspUrl);
    capabilities.hasSubstream = camera.rtspSubUrl !== undefined;
    this.updateCamera(id, { capabilities });
    return capabilities;
  }
}
