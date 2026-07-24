import type { Detection } from "@nightjar/shared";

/**
 * Object-detection worker — STUB.
 *
 * Intended design: a worker_thread hosting onnxruntime-node with a small
 * object-detection model (e.g. yolov8n or a MobileNet-SSD variant) mapped to
 * the shared EventKind classes (person/vehicle/animal/package). The main
 * thread posts { frame } messages (JPEG or raw frames from the motion
 * detector) and receives Detection[] back; inference stays off the event
 * loop. One worker is shared across cameras with a small bounded queue —
 * frames are dropped, never buffered unboundedly.
 */
export class DetectWorker {
  /** Run object detection on one frame. Throws until the worker is implemented. */
  async detect(frame: Buffer): Promise<Detection[]> {
    void frame;
    throw new Error("not implemented");
  }

  /** Terminate the worker thread (no-op in the stub). */
  async close(): Promise<void> {
    // no worker yet
  }
}
