import { parentPort } from "node:worker_threads";
import type { Detection } from "@nightjar/shared";

/**
 * Inference worker thread — runs object detection off the main event loop.
 *
 * The ONNX session lands next milestone: an onnxruntime-node InferenceSession
 * over an Apache-licensed YOLOX model (yolox_nano/tiny), letterboxing the
 * incoming grayscale frame to the model input, running one forward pass and
 * mapping COCO classes to the shared EventKind set
 * (person/vehicle/animal/package). Until then every frame yields [].
 *
 * Protocol (transferable buffers, zero-copy both ways):
 *   in:  { id: number, width: number, height: number, data: ArrayBuffer }
 *   out: { id: number, detections: Detection[] }
 */

export interface DetectRequest {
  id: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export interface DetectResponse {
  id: number;
  detections: Detection[];
}

function runInference(request: DetectRequest): Detection[] {
  // TODO(detect): onnxruntime-node + YOLOX forward pass over request.data.
  void request;
  return [];
}

parentPort?.on("message", (request: DetectRequest) => {
  parentPort?.postMessage({ id: request.id, detections: runInference(request) } satisfies DetectResponse);
});
