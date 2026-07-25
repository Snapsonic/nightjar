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
  /** "rtsp" (default) or "nest" (bridged via go2rtc's native nest source). */
  source?: "rtsp" | "nest";
  /** Required when source is "rtsp". */
  rtspUrl?: string;
  rtspSubUrl?: string;
  /** Required when source is "nest". */
  nestDeviceId?: string;
  /** SDM live-stream protocols for nest cameras (["RTSP"] or ["WEB_RTC"]). */
  nestProtocols?: string[];
  make?: string;
  model?: string;
  /** Pre-computed capabilities (e.g. from SDM traits for nest cameras). */
  capabilities?: CameraCapabilities;
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

  /** Add a camera. Probes RTSP URLs (tolerating failure); nest cameras skip
   *  the probe — their stream only exists once go2rtc pulls the nest source. */
  async addCamera(input: AddCameraInput): Promise<CameraConfig> {
    const source = input.source ?? "rtsp";
    let capabilities = input.capabilities ?? CameraCapabilities.parse({});
    if (source === "rtsp") {
      if (!input.rtspUrl) throw new Error("rtspUrl is required for RTSP cameras");
      if (input.capabilities === undefined) {
        try {
          capabilities = await probe(input.rtspUrl);
        } catch (err) {
          this.log.warn(
            `probe failed for "${input.name}" — adding with empty capabilities: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      capabilities.hasSubstream = input.rtspSubUrl !== undefined;
    } else {
      if (!input.nestDeviceId) throw new Error("nestDeviceId is required for Nest cameras");
      capabilities.hasSubstream = false;
      this.log.info(
        `nest camera "${input.name}" — skipping ffprobe (stream is served by go2rtc's nest source)`,
      );
    }

    const camera = CameraConfig.parse({
      id: randomUUID(),
      name: input.name,
      make: input.make,
      model: input.model,
      source,
      rtspUrl: source === "rtsp" ? input.rtspUrl : undefined,
      rtspSubUrl: source === "rtsp" ? input.rtspSubUrl : undefined,
      nest:
        source === "nest"
          ? { deviceId: input.nestDeviceId as string, protocols: input.nestProtocols ?? [] }
          : undefined,
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
    if (camera.source !== "rtsp" || !camera.rtspUrl) {
      throw new Error("probe is only supported for RTSP cameras");
    }
    const capabilities = await probe(camera.rtspUrl);
    capabilities.hasSubstream = camera.rtspSubUrl !== undefined;
    this.updateCamera(id, { capabilities });
    return capabilities;
  }
}
