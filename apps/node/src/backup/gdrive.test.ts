import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { GdriveBackup, type GdriveEndpoints } from "./gdrive.js";
import { ConfigStore } from "../config/store.js";
import { NodeDb } from "../db.js";
import type { Logger } from "../log.js";

/* ---------- fakes ---------- */

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

/** Everything the mock Google server saw, for assertions. */
interface DriveCalls {
  uploadSessions: string[];
  permissions: { fileId: string; body: unknown }[];
  metadataGets: string[];
}

/**
 * Minimal Google Drive stand-in: folder find-or-create, resumable upload and
 * the permissions endpoint. Files never pre-exist, so every upload runs the
 * full resumable path.
 */
async function startDriveMock(opts: { webViewLinkOnUpload: boolean }): Promise<{
  server: Server;
  endpoints: GdriveEndpoints;
  calls: DriveCalls;
}> {
  const calls: DriveCalls = { uploadSessions: [], permissions: [], metadataGets: [] };
  let fileSeq = 0;
  let base = "";

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const readBody = (cb: (body: unknown) => void): void => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          cb(raw ? JSON.parse(raw) : null);
        } catch {
          cb(null);
        }
      });
    };

    // --- resumable upload session init ---
    if (req.method === "POST" && url.pathname === "/upload/drive/v3/files") {
      calls.uploadSessions.push(url.search);
      const id = `file-${++fileSeq}`;
      readBody(() => {
        send(200, {}, { location: `${base}/upload-session/${id}` });
      });
      return;
    }

    // --- resumable upload bytes ---
    if (req.method === "PUT" && url.pathname.startsWith("/upload-session/")) {
      const id = url.pathname.split("/").pop() as string;
      req.on("data", () => {});
      req.on("end", () => {
        send(
          200,
          opts.webViewLinkOnUpload
            ? { id, webViewLink: `https://drive.google.com/file/d/${id}/view?usp=drivesdk` }
            : { id },
        );
      });
      return;
    }

    // --- permissions ---
    const permFileId = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/)?.[1];
    if (req.method === "POST" && permFileId) {
      readBody((body) => {
        calls.permissions.push({ fileId: permFileId, body });
        send(200, { id: "anyoneWithLink", role: "reader", type: "anyone" });
      });
      return;
    }

    // --- single-file metadata (fallback when the upload omitted the link) ---
    const metaFileId = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)?.[1];
    if (req.method === "GET" && metaFileId) {
      calls.metadataGets.push(metaFileId);
      send(200, {
        id: metaFileId,
        webViewLink: `https://drive.google.com/file/d/${metaFileId}/view?usp=drivesdk`,
      });
      return;
    }

    // --- files.list (folder lookup / findFile): always empty ---
    if (req.method === "GET" && url.pathname === "/drive/v3/files") {
      send(200, { files: [] });
      return;
    }

    // --- folder create ---
    if (req.method === "POST" && url.pathname === "/drive/v3/files") {
      readBody(() => send(200, { id: `folder-${++fileSeq}` }));
      return;
    }

    send(404, { error: "unexpected", path: url.pathname });
  });

  // Short keep-alive + unref: undici holds sockets open, which would keep the
  // test process alive well past the last assertion.
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  return {
    server,
    calls,
    endpoints: {
      deviceCode: `${base}/device/code`,
      token: `${base}/token`,
      revoke: `${base}/revoke`,
      api: `${base}/drive/v3`,
      upload: `${base}/upload/drive/v3`,
    },
  };
}

/* ---------- fixture ---------- */

interface Fixture {
  backup: GdriveBackup;
  db: NodeDb;
  store: ConfigStore;
  calls: DriveCalls;
  server: Server;
  root: string;
  clipDir: string;
  published: { eventId: string; driveUrl: string }[];
  eventId: string;
}

const EVENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function makeFixture(opts: {
  shareLinks: boolean;
  webViewLinkOnUpload?: boolean;
  publisher?: (eventId: string, driveUrl: string) => Promise<void>;
}): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), "nightjar-gdrive-"));
  const configPath = path.join(root, "config");
  const dbPath = path.join(root, "db");
  const clipDir = path.join(root, "clips", EVENT_ID);
  mkdirSync(configPath, { recursive: true });
  mkdirSync(clipDir, { recursive: true });
  writeFileSync(path.join(clipDir, "clip.mp4"), "fake-mp4-bytes");
  writeFileSync(path.join(clipDir, "thumb.jpg"), "fake-jpg-bytes");

  // A token file makes the backup "connected" without running the device flow.
  writeFileSync(
    path.join(configPath, "gdrive-token.json"),
    JSON.stringify({
      refreshToken: "refresh-test",
      accessToken: "access-test",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    { mode: 0o600 },
  );

  const { server, endpoints, calls } = await startDriveMock({
    webViewLinkOnUpload: opts.webViewLinkOnUpload ?? true,
  });

  const store = new ConfigStore(silentLog, configPath);
  store.update({
    backup: {
      gdrive: {
        enabled: true,
        folderName: "Nightjar",
        shareLinks: opts.shareLinks,
      },
    },
  });

  const db = new NodeDb(dbPath);
  db.insertEvent({
    id: EVENT_ID,
    cameraId: "cam-1",
    kind: "person",
    score: 0.9,
    startedAt: "2026-07-24T14:32:07.000Z",
    endedAt: "2026-07-24T14:32:20.000Z",
    clipStatus: "local",
    metadata: {},
  });

  const published: { eventId: string; driveUrl: string }[] = [];
  const backup = new GdriveBackup({
    db,
    store,
    log: silentLog,
    endpoints,
    dir: configPath,
    publishDriveUrl:
      opts.publisher ??
      ((eventId, driveUrl) => {
        published.push({ eventId, driveUrl });
        return Promise.resolve();
      }),
  });

  return { backup, db, store, calls, server, root, clipDir, published, eventId: EVENT_ID };
}

async function runOneBackup(fx: Fixture): Promise<void> {
  fx.backup.start();
  fx.backup.enqueueIfActive(fx.eventId, fx.clipDir);
  const deadline = Date.now() + 10_000;
  while (fx.db.countGdriveQueue() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await fx.backup.stop();
  assert.equal(fx.db.countGdriveQueue(), 0, "backup job did not drain");
}

function teardown(fx: Fixture): void {
  fx.db.close();
  fx.server.closeAllConnections();
  fx.server.close();
  rmSync(fx.root, { recursive: true, force: true });
}

/* ---------- tests ---------- */

describe("gdrive share links", () => {
  it("requests id+webViewLink on upload and captures the link", async () => {
    const fx = await makeFixture({ shareLinks: true });
    try {
      await runOneBackup(fx);
      assert.equal(fx.calls.uploadSessions.length, 2, "clip + thumbnail uploaded");
      for (const search of fx.calls.uploadSessions) {
        assert.ok(
          search.includes("fields=id%2CwebViewLink") || search.includes("fields=id,webViewLink"),
          `session URL asks for the link fields: ${search}`,
        );
      }
      assert.equal(
        fx.db.getEventDriveUrl(fx.eventId),
        "https://drive.google.com/file/d/file-4/view?usp=drivesdk",
      );
    } finally {
      teardown(fx);
    }
  });

  it("creates an anyone-with-link reader permission only when shareLinks is on", async () => {
    const on = await makeFixture({ shareLinks: true });
    try {
      await runOneBackup(on);
      assert.equal(on.calls.permissions.length, 1, "exactly one permission call");
      const permission = on.calls.permissions[0];
      assert.ok(permission);
      assert.deepEqual(permission.body, { role: "reader", type: "anyone" });
      // Only the clip is shared — the thumbnail stays private.
      assert.equal(permission.fileId, "file-4");
    } finally {
      teardown(on);
    }

    const off = await makeFixture({ shareLinks: false });
    try {
      await runOneBackup(off);
      assert.equal(off.calls.permissions.length, 0, "no permission call when shareLinks is off");
      assert.equal(off.db.getEventDriveUrl(off.eventId), null, "no drive url recorded");
      assert.deepEqual(off.published, [], "nothing published to the cloud");
      // The backup itself still happened.
      assert.equal(off.calls.uploadSessions.length, 2);
    } finally {
      teardown(off);
    }
  });

  it("publishes the captured URL to the cloud and stores it locally", async () => {
    const fx = await makeFixture({ shareLinks: true });
    try {
      await runOneBackup(fx);
      assert.deepEqual(fx.published, [
        {
          eventId: fx.eventId,
          driveUrl: "https://drive.google.com/file/d/file-4/view?usp=drivesdk",
        },
      ]);
      assert.equal(
        fx.db.getEventDriveUrl(fx.eventId),
        "https://drive.google.com/file/d/file-4/view?usp=drivesdk",
      );
    } finally {
      teardown(fx);
    }
  });

  it("falls back to a metadata fetch when the upload response omits webViewLink", async () => {
    const fx = await makeFixture({ shareLinks: true, webViewLinkOnUpload: false });
    try {
      await runOneBackup(fx);
      assert.deepEqual(fx.calls.metadataGets, ["file-4"], "asked Drive for the link");
      assert.equal(
        fx.db.getEventDriveUrl(fx.eventId),
        "https://drive.google.com/file/d/file-4/view?usp=drivesdk",
      );
    } finally {
      teardown(fx);
    }
  });

  it("still completes the backup when the cloud publish throws", async () => {
    const fx = await makeFixture({
      shareLinks: true,
      publisher: () => Promise.reject(new Error("cloud offline")),
    });
    try {
      await runOneBackup(fx);
      // Job drained (runOneBackup asserts it) and the URL is kept locally for
      // EventPipeline.uploadEvent to fold into the event_clips upsert.
      assert.equal(
        fx.db.getEventDriveUrl(fx.eventId),
        "https://drive.google.com/file/d/file-4/view?usp=drivesdk",
      );
    } finally {
      teardown(fx);
    }
  });
});

/* ---------- config default ---------- */

describe("gdrive config", () => {
  it("defaults shareLinks to false and round-trips a toggle", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nightjar-cfg-"));
    try {
      const store = new ConfigStore(silentLog, root);
      assert.equal(store.get().backup.gdrive.shareLinks, false);
      const next = store.update({
        backup: { gdrive: { ...store.get().backup.gdrive, shareLinks: true } },
      });
      assert.equal(next.backup.gdrive.shareLinks, true);
      assert.equal(new ConfigStore(silentLog, root).get().backup.gdrive.shareLinks, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* keep node:test's `before`/`after` imports meaningful for lint parity */
before(() => {});
after(() => {});
