import { Worker } from "node:worker_threads";
import type { Detection } from "@nightjar/shared";
import type { Logger } from "../log.js";
import type { DetectRequest, DetectResponse } from "./inference-worker.js";

/**
 * Object-detection front end: a pool of one worker_thread (see
 * inference-worker.ts) shared across cameras. Frames are posted with a
 * transferable ArrayBuffer (zero-copy into the thread) and matched back by
 * request id. Inference itself is still stubbed — the worker returns []
 * until the onnxruntime-node + YOLOX (Apache-licensed) session lands — but
 * the threading, messaging and failure paths are final. If the worker cannot
 * start (or dies), detect() degrades to returning [] so the event pipeline
 * keeps running.
 */
export class DetectWorker {
  private worker: Worker | null = null;
  private workerFailed = false;
  private nextId = 1;
  private readonly pending = new Map<number, (detections: Detection[]) => void>();

  constructor(private readonly log: Logger) {}

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.workerFailed) return null;
    try {
      const worker = new Worker(new URL("./inference-worker.ts", import.meta.url));
      worker.unref();
      worker.on("message", (response: DetectResponse) => {
        const resolve = this.pending.get(response.id);
        if (resolve) {
          this.pending.delete(response.id);
          resolve(response.detections);
        }
      });
      worker.on("error", (err) => {
        this.log.warn(`detect worker error: ${err.message} — detections disabled`);
        this.failWorker(worker);
      });
      worker.on("exit", () => {
        if (this.worker === worker) this.failWorker(worker);
      });
      this.worker = worker;
      this.log.info("detect worker thread started (inference stubbed)");
      return worker;
    } catch (err) {
      this.workerFailed = true;
      this.log.warn(
        `detect worker unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private failWorker(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.workerFailed = true;
    for (const [id, resolve] of [...this.pending]) {
      this.pending.delete(id);
      resolve([]);
    }
    void worker.terminate().catch(() => undefined);
  }

  /**
   * Run object detection on one grayscale frame (width x height, 1 byte/px).
   * The frame is copied into a standalone ArrayBuffer and transferred to the
   * worker. Returns [] while inference is stubbed or the worker is down.
   */
  async detect(frame: Buffer, width: number, height: number): Promise<Detection[]> {
    const worker = this.ensureWorker();
    if (!worker) return [];
    // Standalone ArrayBuffer so the transfer never detaches a pooled Buffer slab.
    const data = new ArrayBuffer(frame.byteLength);
    new Uint8Array(data).set(frame);
    const id = this.nextId++;
    return new Promise<Detection[]>((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage({ id, width, height, data } satisfies DetectRequest, [data]);
    });
  }

  /** Terminate the worker thread. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    for (const [id, resolve] of [...this.pending]) {
      this.pending.delete(id);
      resolve([]);
    }
    if (worker) await worker.terminate().catch(() => undefined);
  }
}
