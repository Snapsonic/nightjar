import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { NightjarClient } from "@nightjar/db";
import { EventPipeline, pickKind } from "./pipeline.js";
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

  it("never sends expires_at — the database owns cloud retention", async () => {
    const fx = makePipeline();
    try {
      await uploadEvent(fx.pipeline, EVENT_ID, fx.dir);
      const payload = fx.captured.clipUpserts[0];
      assert.ok(payload, "one event_clips upsert");
      // Migration 0014 derives expires_at from the owner's plan in a BEFORE
      // trigger and revokes the node's grant on the column: sending it would
      // be both pointless and a hard 42501 on the upsert.
      assert.ok(
        !("expires_at" in payload),
        `expires_at must be absent, got ${JSON.stringify(payload)}`,
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

describe("pickKind", () => {
  const det = (kind: string, score: number) =>
    ({ kind, score, box: [0, 0, 0.1, 0.1], atMs: 0 }) as never;

  it("does not let a marginal person outrank a better-scoring cat", () => {
    // The real alert this fixes: a 51% person on a terracotta chiminea beat a
    // correctly identified 63% cat, and reported the cat's own 63% as its
    // confidence in the person.
    const picked = pickKind([det("animal", 0.631), det("person", 0.51)]);
    assert.equal(picked?.kind, "animal");
    assert.equal(picked?.score, 0.631);
  });

  it("still reports the person when the two are close", () => {
    // Priority is the point: a frame holding both the dog and a delivery is a
    // delivery, and a near-tie must not flip that.
    const picked = pickKind([det("dog", 0.75), det("person", 0.7)]);
    assert.equal(picked?.kind, "person");
    assert.equal(picked?.score, 0.7); // the person's score, not the dog's
  });

  it("a confident person outranks a higher-scoring animal", () => {
    const picked = pickKind([det("cat", 0.95), det("person", 0.8)]);
    assert.equal(picked?.kind, "person");
    assert.equal(picked?.score, 0.8);
  });

  it("a barely-there person loses to a confident cat", () => {
    const picked = pickKind([det("cat", 0.95), det("person", 0.52)]);
    assert.equal(picked?.kind, "cat");
  });

  it("keeps the person beside a much better vehicle", () => {
    // The regression this rule was retuned for: a real person at 58% next to a
    // parked van at 72%. Demoting that to a vehicle event loses the alert that
    // actually matters.
    const picked = pickKind([det("vehicle", 0.72), det("person", 0.58)]);
    assert.equal(picked?.kind, "person");
    assert.equal(picked?.score, 0.58);
  });

  it("a lone weak detection still names its event", () => {
    const picked = pickKind([det("person", 0.51)]);
    assert.equal(picked?.kind, "person");
  });

  it("keeps the person beside a slightly better vehicle", () => {
    // Within the margin, so priority applies — a person next to a car is the
    // thing worth reporting.
    const picked = pickKind([det("vehicle", 0.62), det("person", 0.6)]);
    assert.equal(picked?.kind, "person");
    assert.equal(picked?.score, 0.6);
  });

  it("reports the strongest box of the winning kind", () => {
    const picked = pickKind([det("person", 0.7), det("person", 0.84), det("vehicle", 0.9)]);
    assert.equal(picked?.kind, "person");
    assert.equal(picked?.score, 0.84);
  });

  it("returns null when nothing was detected", () => {
    assert.equal(pickKind([]), null);
  });
});

describe("detection snapshots", () => {
  const makeWith = (recorder: unknown, root: string) =>
    new EventPipeline({
      db: new NodeDb(path.join(root, "db2")),
      link: { getClient: () => null, getNodeId: () => NODE_ID } as unknown as CloudLink,
      recorder: recorder as never,
      detect: {} as never,
      store: new ConfigStore(silentLog, path.join(root, "config")),
      log: silentLog,
    });
  // fetchSnapshot is private; the point of these tests is which source it
  // reaches for, which is exactly what callers cannot observe.
  const snapshot = (p: EventPipeline, cameraId: string) =>
    (p as unknown as { fetchSnapshot(id: string): Promise<Buffer | null> }).fetchSnapshot(cameraId);

  it("takes the frame from recorded segments without calling go2rtc", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nightjar-snap-"));
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      throw new Error("go2rtc must not be reached when the frame is already on disk");
    }) as typeof fetch;
    try {
      const asked: number[] = [];
      const pipeline = makeWith(
        {
          latestFrame: async (_id: string, maxAgeMs: number) => {
            asked.push(maxAgeMs);
            return Buffer.from("segment-jpeg");
          },
        },
        root,
      );
      const frame = await snapshot(pipeline, "cam-1");
      assert.equal(frame?.toString(), "segment-jpeg");
      assert.deepEqual(calls, []);
      // Bounded, so a live event is never classified against stale footage.
      assert.deepEqual(asked, [30_000]);
    } finally {
      globalThis.fetch = realFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to go2rtc when no recent segment exists (record=false, or capture down)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nightjar-snap-"));
    const realFetch = globalThis.fetch;
    let asked = "";
    globalThis.fetch = (async (url: unknown) => {
      asked = String(url);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;
    try {
      const pipeline = makeWith({ latestFrame: async () => null }, root);
      const frame = await snapshot(pipeline, "cam-1");
      assert.equal(frame?.length, 3);
      assert.ok(asked.includes("/api/frame.jpeg"), `expected go2rtc call, got ${asked}`);
    } finally {
      globalThis.fetch = realFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still tries go2rtc when reading the segment throws", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nightjar-snap-"));
    const realFetch = globalThis.fetch;
    let reached = false;
    globalThis.fetch = (async () => {
      reached = true;
      return new Response(new Uint8Array([9]), { status: 200 });
    }) as typeof fetch;
    try {
      const pipeline = makeWith(
        {
          latestFrame: async () => {
            throw new Error("recordings volume unavailable");
          },
        },
        root,
      );
      const frame = await snapshot(pipeline, "cam-1");
      assert.ok(reached);
      assert.equal(frame?.length, 1);
    } finally {
      globalThis.fetch = realFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
