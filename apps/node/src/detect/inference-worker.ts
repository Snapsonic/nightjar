import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";
import { decode as decodeJpeg } from "jpeg-js";
import * as ort from "onnxruntime-node";
import type { Detection, EventKind } from "@nightjar/shared";

/**
 * Inference worker thread — runs object detection off the main event loop.
 *
 * Model: YOLOX-tiny ONNX from the official Megvii release
 *   https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx
 *   License: Apache-2.0 — https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE
 * (deliberately NOT Ultralytics YOLOv5/v8 — those weights are AGPL).
 * Downloaded by scripts/fetch-model.mjs into apps/node/models/ (gitignored).
 *
 * Pre/post-processing mirrors the official YOLOX ONNXRuntime demo
 * (demo/ONNXRuntime/onnx_inference.py + yolox/data/data_augment.py preproc +
 * yolox/utils/demo_utils.py demo_postprocess):
 *   - input is raw 0-255 float32 BGR, CHW, letterboxed top-left with pad 114,
 *     bilinear resize — NO mean/std normalization, NO /255 (removed upstream
 *     in 2021; verified against the demo code above)
 *   - outputs are per-anchor regressions that must be grid/stride decoded:
 *     xy = (pred + grid) * stride, wh = exp(pred) * stride
 *   - score = objectness * class probability, then class-aware NMS
 *
 * The ONNX session is created once at worker start on the default CPU
 * execution provider with ORT's default thread settings (no intra-op cap —
 * YOLOX-tiny at 416x416 is light enough that defaults are fine, and the
 * session lives in this worker thread so the main loop is never blocked).
 *
 * Protocol:
 *   in:  { id: number, data: ArrayBuffer }   — JPEG bytes (transferred)
 *   out: { id: number, detections: Detection[] }
 */

/* ---------- constants (tuning lives here, not in NodeConfig) ---------- */

const MODEL_PATH = fileURLToPath(new URL("../../models/yolox_tiny.onnx", import.meta.url));
/** YOLOX-tiny test size (see the official ONNXRuntime demo table). */
const INPUT_SIZE = 416;
/** Letterbox padding value used by the official preproc. */
const PAD_VALUE = 114;
/** Keep candidates with objectness * class probability above this. */
const CONF_THRESHOLD = 0.35;
/** Class-aware NMS IoU threshold (matches the official demo). */
const NMS_IOU = 0.45;
/** YOLOX FPN strides for non-p6 models. */
const STRIDES = [8, 16, 32] as const;

/**
 * COCO class index → Nightjar EventKind. Unlisted classes are ignored.
 * "package" is an approximation via bag-like classes until a dedicated
 * package model lands (see README).
 */
const COCO_TO_KIND: ReadonlyMap<number, EventKind> = new Map<number, EventKind>([
  [0, "person"],
  [1, "vehicle"], // bicycle
  [2, "vehicle"], // car
  [3, "vehicle"], // motorcycle
  [5, "vehicle"], // bus
  [7, "vehicle"], // truck
  [14, "animal"], // bird
  [15, "cat"],
  [16, "dog"],
  [17, "animal"], // horse
  [18, "animal"], // sheep
  [19, "animal"], // cow
  [21, "bear"],
  [24, "package"], // backpack
  [26, "package"], // handbag
  [28, "package"], // suitcase
]);

export interface DetectRequest {
  id: number;
  /** JPEG-encoded snapshot bytes (transferred ArrayBuffer). */
  data: ArrayBuffer;
}

export interface DetectResponse {
  id: number;
  detections: Detection[];
}

/* ---------- session ---------- */

const sessionPromise: Promise<ort.InferenceSession | null> = (async () => {
  if (!existsSync(MODEL_PATH)) {
    console.error(
      `[detect] model missing at ${MODEL_PATH} — run "pnpm --filter @nightjar/node fetch-model" ` +
        "to download YOLOX-tiny (Apache-2.0). Detections disabled until then.",
    );
    return null;
  }
  const startedAt = Date.now();
  // Default CPU execution provider, default ORT threading (see header note).
  const session = await ort.InferenceSession.create(MODEL_PATH);
  console.log(`[detect] YOLOX-tiny session ready in ${Date.now() - startedAt}ms`);
  return session;
})().catch((err: unknown) => {
  console.error(
    `[detect] failed to create ONNX session: ${err instanceof Error ? err.message : String(err)}`,
  );
  return null;
});

/* ---------- preprocessing ---------- */

interface Preprocessed {
  tensor: ort.Tensor;
  /** Letterbox scale: model-input px per source px. */
  ratio: number;
  srcWidth: number;
  srcHeight: number;
}

/**
 * JPEG → letterboxed CHW float32 BGR tensor, exactly like the official
 * preproc(): scale by r = min(S/h, S/w) with bilinear sampling, place at the
 * top-left, pad with 114, keep raw 0-255 values.
 */
function preprocess(jpeg: Buffer): Preprocessed {
  const image = decodeJpeg(jpeg, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
  const { width, height, data } = image; // RGBA
  const ratio = Math.min(INPUT_SIZE / height, INPUT_SIZE / width);
  const outW = Math.round(width * ratio);
  const outH = Math.round(height * ratio);

  const plane = INPUT_SIZE * INPUT_SIZE;
  const chw = new Float32Array(3 * plane).fill(PAD_VALUE);
  for (let oy = 0; oy < outH; oy++) {
    // cv2.INTER_LINEAR center-aligned sampling.
    const sy = Math.min(Math.max((oy + 0.5) / ratio - 0.5, 0), height - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, height - 1);
    const fy = sy - y0;
    for (let ox = 0; ox < outW; ox++) {
      const sx = Math.min(Math.max((ox + 0.5) / ratio - 0.5, 0), width - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, width - 1);
      const fx = sx - x0;
      const i00 = (y0 * width + x0) * 4;
      const i01 = (y0 * width + x1) * 4;
      const i10 = (y1 * width + x0) * 4;
      const i11 = (y1 * width + x1) * 4;
      const w00 = (1 - fy) * (1 - fx);
      const w01 = (1 - fy) * fx;
      const w10 = fy * (1 - fx);
      const w11 = fy * fx;
      const out = oy * INPUT_SIZE + ox;
      // BGR channel order (cv2.imread convention the model was trained with).
      for (let c = 0; c < 3; c++) {
        const value =
          (data[i00 + c] as number) * w00 +
          (data[i01 + c] as number) * w01 +
          (data[i10 + c] as number) * w10 +
          (data[i11 + c] as number) * w11;
        chw[(2 - c) * plane + out] = value; // RGBA c=0..2 is R,G,B → planes 2,1,0
      }
    }
  }
  return {
    tensor: new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    ratio,
    srcWidth: width,
    srcHeight: height,
  };
}

/* ---------- postprocessing ---------- */

/** Per-anchor grid position and stride, in model output order. */
const ANCHORS: { gx: number; gy: number; stride: number }[] = [];
for (const stride of STRIDES) {
  const size = INPUT_SIZE / stride;
  for (let gy = 0; gy < size; gy++) {
    for (let gx = 0; gx < size; gx++) ANCHORS.push({ gx, gy, stride });
  }
}

interface Candidate {
  kind: EventKind;
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function iou(a: Candidate, b: Candidate): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy class-aware NMS (candidates of different kinds never suppress each other). */
function nms(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];
  for (const candidate of sorted) {
    if (kept.some((k) => k.kind === candidate.kind && iou(k, candidate) > NMS_IOU)) continue;
    kept.push(candidate);
  }
  return kept;
}

/** Decode the raw [1, N, 85] YOLOX output into normalized Detection[]. */
function postprocess(output: Float32Array, pre: Preprocessed, atMs: number): Detection[] {
  const numClasses = 80;
  const step = 5 + numClasses;
  const candidates: Candidate[] = [];
  for (let i = 0; i < ANCHORS.length; i++) {
    const base = i * step;
    const objectness = output[base + 4] as number;
    if (objectness < CONF_THRESHOLD) continue; // score = obj * cls <= obj
    let bestClass = -1;
    let bestProb = 0;
    for (let c = 0; c < numClasses; c++) {
      const prob = output[base + 5 + c] as number;
      if (prob > bestProb) {
        bestProb = prob;
        bestClass = c;
      }
    }
    const score = objectness * bestProb;
    if (score < CONF_THRESHOLD) continue;
    const kind = COCO_TO_KIND.get(bestClass);
    if (!kind) continue;
    const anchor = ANCHORS[i] as (typeof ANCHORS)[number];
    // demo_postprocess: xy = (pred + grid) * stride, wh = exp(pred) * stride.
    const cx = ((output[base] as number) + anchor.gx) * anchor.stride;
    const cy = ((output[base + 1] as number) + anchor.gy) * anchor.stride;
    const w = Math.exp(output[base + 2] as number) * anchor.stride;
    const h = Math.exp(output[base + 3] as number) * anchor.stride;
    // Undo the letterbox back into source-image pixels.
    candidates.push({
      kind,
      score,
      x1: (cx - w / 2) / pre.ratio,
      y1: (cy - h / 2) / pre.ratio,
      x2: (cx + w / 2) / pre.ratio,
      y2: (cy + h / 2) / pre.ratio,
    });
  }
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return nms(candidates).map((c) => {
    const x = clamp(c.x1 / pre.srcWidth);
    const y = clamp(c.y1 / pre.srcHeight);
    return {
      kind: c.kind,
      score: Math.min(1, c.score),
      box: [x, y, clamp(c.x2 / pre.srcWidth) - x, clamp(c.y2 / pre.srcHeight) - y],
      atMs,
    };
  });
}

/* ---------- message loop ---------- */

async function runInference(request: DetectRequest): Promise<Detection[]> {
  const session = await sessionPromise;
  if (!session) return [];
  const pre = preprocess(Buffer.from(request.data));
  const inputName = session.inputNames[0] ?? "images";
  const results = await session.run({ [inputName]: pre.tensor });
  const outputName = session.outputNames[0] ?? "output";
  const output = results[outputName];
  if (!output) return [];
  return postprocess(output.data as Float32Array, pre, Date.now());
}

parentPort?.on("message", (request: DetectRequest) => {
  void runInference(request)
    .catch((err: unknown) => {
      console.error(
        `[detect] inference failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as Detection[];
    })
    .then((detections) => {
      parentPort?.postMessage({ id: request.id, detections } satisfies DetectResponse);
    });
});
