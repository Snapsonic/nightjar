import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { NightjarClient } from "@nightjar/db";
import { EventPipeline } from "./pipeline.js";
import type { CloudLink } from "../cloud/link.js";
import { ConfigStore } from "../config/store.js";
import { NodeDb } from "../db.js";
import type { Logger } from "../log.js";

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

const EVENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NODE_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

interface Captured {
  clipUpserts: Record<string, unknown>[];
  clipUpdates: { patch: Record<string, unknown>; eventId: string }[];
}

/**
 * Just enough of the Supabase client for uploadEvent()/publishDriveUrl():
 * table upsert/update, the sign-upload function and signed-URL storage writes.
 */
function fakeClient(captured: Captured): NightjarClient {
  const okResult = { data: null, error: null };
  const client = {
    from(table: string) {
      return {
        upsert(payload: Record<string, unknown>) {
          if (table === "event_clips") captured.clipUpserts.push(payload);
          return Promise.resolve(okResult);
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(_column: string, value: string) {
              if (table === "event_clips") {
                captured.clipUpdates.push({ patch, eventId: value });
              }
              return Promise.resolve(okResult);
            },
          };
        },
      };
    },
    functions: {
      invoke(_name: string, _opts: unknown) {
        return Promise.resolve({
          data: {
            uploads: [
              { file: "clip.mp4", path: `${EVENT_ID}/clip.mp4`, token: "clip-token" },
              { file: "thumb.jpg", path: `${EVENT_ID}/thumb.jpg`, token: "thumb-token" },
            ],
          },
          error: null,
        });
      },
    },
    storage: {
      from() {
        return {
          uploadToSignedUrl() {
            return Promise.resolve(okResult);
          },
        };
      },
    },
  };
  return client as unknown as NightjarClient;
}

function makePipeline(): {
  pipeline: EventPipeline;
  db: NodeDb;
  captured: Captured;
  dir: string;
  root: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "nightjar-pipeline-"));
  const configPath = path.join(root, "config");
  const dir = path.join(root, "clips", EVENT_ID);
  mkdirSync(configPath, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "clip.mp4"), "fake-mp4-bytes");
  writeFileSync(path.join(dir, "thumb.jpg"), "fake-jpg-bytes");

  const captured: Captured = { clipUpserts: [], clipUpdates: [] };
  const db = new NodeDb(path.join(root, "db"));
  db.insertEvent({
    id: EVENT_ID,
    cameraId: "cam-1",
    kind: "person",
    score: 0.9,
    startedAt: "2026-07-24T14:32:07.000Z",
    endedAt: "2026-07-24T14:32:20.000Z",
    clipStatus: "local",
    metadata: { durationS: 13 },
  });

  const link = {
    getClient: () => fakeClient(captured),
    getNodeId: () => NODE_ID,
  } as unknown as CloudLink;

  const pipeline = new EventPipeline({
    db,
    link,
    recorder: {} as never,
    detect: {} as never,
    store: new ConfigStore(silentLog, configPath),
    log: silentLog,
  });
  return { pipeline, db, captured, dir, root };
}

/** uploadEvent is private — the cloud payload it builds is what we assert on. */
function uploadEvent(pipeline: EventPipeline, eventId: string, dir: string): Promise<void> {
  return (
    pipeline as unknown as { uploadEvent(id: string, dir: string): Promise<void> }
  ).uploadEvent(eventId, dir);
}

describe("event_clips drive_url", () => {
  it("includes drive_url in the upsert when the node captured one", async () => {
    const fx = makePipeline();
    try {
      const url = "https://drive.google.com/file/d/file-4/view?usp=drivesdk";
      fx.db.setEventDriveUrl(EVENT_ID, url);
      await uploadEvent(fx.pipeline, EVENT_ID, fx.dir);
      const payload = fx.captured.clipUpserts[0];
      assert.ok(payload, "one event_clips upsert");
      assert.equal(payload.drive_url, url);
      assert.equal(payload.event_id, EVENT_ID);
    } finally {
      fx.db.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("omits drive_url entirely when there is none, so a later Drive write survives", async () => {
    const fx = makePipeline();
    try {
      await uploadEvent(fx.pipeline, EVENT_ID, fx.dir);
      const payload = fx.captured.clipUpserts[0];
      assert.ok(payload, "one event_clips upsert");
      assert.ok(
        !("drive_url" in payload),
        `key must be absent, got ${JSON.stringify(payload)}`,
      );
    } finally {
      fx.db.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("publishDriveUrl updates the existing event_clips row", async () => {
    const fx = makePipeline();
    try {
      const url = "https://drive.google.com/file/d/file-9/view?usp=drivesdk";
      await fx.pipeline.publishDriveUrl(EVENT_ID, url);
      assert.deepEqual(fx.captured.clipUpdates, [
        { patch: { drive_url: url }, eventId: EVENT_ID },
      ]);
    } finally {
      fx.db.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("publishDriveUrl is a no-op while the cloud link is down", async () => {
    const fx = makePipeline();
    try {
      const offline = new EventPipeline({
        db: fx.db,
        link: { getClient: () => null, getNodeId: () => NODE_ID } as unknown as CloudLink,
        recorder: {} as never,
        detect: {} as never,
        store: new ConfigStore(silentLog, path.join(fx.root, "config")),
        log: silentLog,
      });
      await offline.publishDriveUrl(EVENT_ID, "https://drive.google.com/file/d/x/view");
      assert.deepEqual(fx.captured.clipUpdates, []);
    } finally {
      fx.db.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
