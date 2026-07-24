#!/usr/bin/env node
// Downloads the YOLOX-tiny ONNX model used by the detect worker.
//
// Source: official Megvii YOLOX release (Apache-2.0):
//   https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx
//   License: Apache License 2.0 — https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE
//
// Usage: pnpm --filter @nightjar/node fetch-model
// The file lands in apps/node/models/yolox_tiny.onnx (gitignored, ~20 MB).

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_URL =
  "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx";
/** Exact size of the release asset — guards against truncated downloads. */
const MODEL_BYTES = 20219662;

const modelsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "models");
const target = path.join(modelsDir, "yolox_tiny.onnx");

try {
  if (statSync(target).size === MODEL_BYTES) {
    console.log(`model already present: ${target}`);
    process.exit(0);
  }
  console.log("existing model has wrong size — re-downloading");
} catch {
  // missing — download below
}

console.log(`downloading YOLOX-tiny (Apache-2.0) from ${MODEL_URL} ...`);
const res = await fetch(MODEL_URL, { redirect: "follow" });
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await res.arrayBuffer());
if (bytes.length !== MODEL_BYTES) {
  console.error(`download failed: got ${bytes.length} bytes, expected ${MODEL_BYTES}`);
  process.exit(1);
}

mkdirSync(modelsDir, { recursive: true });
const tmp = `${target}.tmp`;
writeFileSync(tmp, bytes);
renameSync(tmp, target);
const sha256 = createHash("sha256").update(bytes).digest("hex");
console.log(`saved ${target} (${(bytes.length / 1e6).toFixed(1)} MB, sha256 ${sha256})`);
