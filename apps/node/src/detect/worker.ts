import { Worker } from "node:worker_threads";
import type { Detection } from "@nightjar/shared";
import type { Logger } from "../log.js";
import type { DetectRequest, DetectResponse } from "./inference-worker.js";

/** Warn when a single inference call takes longer than this. */
const SLOW_INFERENCE_MS = 2_000;
/** Safety valve: resolve [] if the worker never answers (hung session). */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Object-detection front end: a pool of one worker_thread (see
 * inference-worker.ts) shared across cameras. JPEG snapshots are posted with
 * a transferable ArrayBuffer (zero-copy into the thread) and matched back by
 * request id. The worker runs a YOLOX-tiny ONNX session (Apache-2.0, see
 * inference-worker.ts for provenance); if the worker cannot start (or dies,
 * e.g. missing model file), detect() degrades to returning [] so the event
 * pipeline keeps running with kind "motion".
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
      this.log.info("detect worker thread started (YOLOX-tiny, CPU)");
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
   * Run object detection on one JPEG-encoded snapshot. The bytes are copied
   * into a standalone ArrayBuffer and transferred to the worker. Returns []
   * when the worker is down, the model file is missing, or nothing relevant
   * is detected.
   */
  async detect(jpeg: Buffer): Promise<Detection[]> {
    const worker = this.ensureWorker();
    if (!worker) return [];
    // Standalone ArrayBuffer so the transfer never detaches a pooled Buffer slab.
    const data = new ArrayBuffer(jpeg.byteLength);
    new Uint8Array(data).set(jpeg);
    const id = this.nextId++;
    const startedAt = Date.now();
    const detections = await new Promise<Detection[]>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.log.warn(`detect request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`);
          resolve([]);
        }
      }, REQUEST_TIMEOUT_MS);
      timeout.unref();
      this.pending.set(id, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
      worker.postMessage({ id, data } satisfies DetectRequest, [data]);
    });
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_INFERENCE_MS) {
      this.log.warn(`slow inference: ${elapsed}ms for one frame (CPU overloaded?)`);
    }
    return detections;
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
