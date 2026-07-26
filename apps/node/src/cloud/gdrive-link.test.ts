import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { GdriveBackup, type GdriveEndpoints } from "../backup/gdrive.js";
import { ConfigStore } from "../config/store.js";
import { NodeDb } from "../db.js";
import type { Logger } from "../log.js";
import { CloudLink, type CloudLinkDeps } from "./link.js";

/**
 * The cloud dashboard's Drive card driven end to end against a real
 * GdriveBackup, with the realtime channel mocked: every reply the node would
 * broadcast is captured instead, so we can assert both the round-trip AND
 * that nothing from the token file ever leaves the node.
 */

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

/** Distinctive so a leak is unmistakable when we grep the serialized replies. */
const TOKEN_FILE = {
  refreshToken: "1//REFRESH-SECRET-MUST-NOT-LEAK",
  accessToken: "ya29.ACCESS-SECRET-MUST-NOT-LEAK",
  email: "owner@example.com",
};
const CLIENT_SECRET = "GOCSPX-CLIENT-SECRET-MUST-NOT-LEAK";
const USER_CODE = "WXYZ-1234";

interface GoogleMock {
  server: Server;
  endpoints: GdriveEndpoints;
  revokedTokens: string[];
}

/** Google stand-in: device code, token polling, revoke and /about. */
async function startGoogleMock(): Promise<GoogleMock> {
  const revokedTokens: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "POST" && url.pathname === "/device/code") {
        send(200, {
          device_code: "device-code-1",
          user_code: USER_CODE,
          verification_url: "https://www.google.com/device",
          expires_in: 900,
          interval: 5,
        });
        return;
      }
      // The user has not entered the code yet — the node keeps polling.
      if (req.method === "POST" && url.pathname === "/token") {
        send(428, { error: "authorization_pending" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/revoke") {
        revokedTokens.push(url.searchParams.get("token") ?? "");
        send(200, {});
        return;
      }
      if (req.method === "GET" && url.pathname === "/drive/v3/about") {
        if (req.headers.authorization !== `Bearer ${TOKEN_FILE.accessToken}`) {
          send(401, { error: "unauthorized" });
          return;
        }
        send(200, {
          user: { emailAddress: TOKEN_FILE.email },
          storageQuota: { limit: "16106127360", usage: "1073741824" },
        });
        return;
      }
      send(404, { error: "unexpected", path: url.pathname });
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    revokedTokens,
    endpoints: {
      deviceCode: `${base}/device/code`,
      token: `${base}/token`,
      revoke: `${base}/revoke`,
      api: `${base}/drive/v3`,
      upload: `${base}/upload/drive/v3`,
    },
  };
}

/** The private bits of CloudLink this test drives directly. */
interface LinkInternals {
  handleMessage(raw: unknown): Promise<void>;
  channel: { send(args: { payload: unknown }): Promise<string> } | null;
}

describe("cloud link: Google Drive handlers", () => {
  let google: GoogleMock;
  let store: ConfigStore;
  let db: NodeDb;
  let gdrive: GdriveBackup;
  let internals: LinkInternals;
  let tokenPath: string;
  let configFile: string;
  const sent: Record<string, unknown>[] = [];

  before(async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nightjar-gdrive-link-"));
    const configPath = path.join(root, "config");
    mkdirSync(configPath, { recursive: true });
    tokenPath = path.join(configPath, "gdrive-token.json");
    configFile = path.join(configPath, "config.json");
    // Pre-seeded token file == already connected, no device flow needed.
    writeFileSync(
      tokenPath,
      JSON.stringify({ ...TOKEN_FILE, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
      { mode: 0o600 },
    );

    google = await startGoogleMock();
    store = new ConfigStore(silentLog, configPath);
    store.update({
      backup: {
        gdrive: {
          enabled: false,
          shareLinks: false,
          folderName: "Nightjar",
          clientId: "test-client-id.apps.googleusercontent.com",
          clientSecret: CLIENT_SECRET,
        },
      },
    });
    db = new NodeDb(path.join(root, "db"));
    gdrive = new GdriveBackup({
      db,
      store,
      log: silentLog,
      endpoints: google.endpoints,
      dir: configPath,
    });
    gdrive.start();

    const link = new CloudLink({
      store,
      db,
      gdrive,
      log: silentLog,
      version: "test",
      identity: {} as CloudLinkDeps["identity"],
      cameras: {} as CloudLinkDeps["cameras"],
      go2rtc: {} as CloudLinkDeps["go2rtc"],
      recorder: {} as CloudLinkDeps["recorder"],
    });
    internals = link as unknown as LinkInternals;
    internals.channel = {
      send: async ({ payload }) => {
        sent.push(payload as Record<string, unknown>);
        return "ok";
      },
    };
  });

  after(async () => {
    await gdrive.stop();
    db.close();
    google.server.close();
  });

  /** Sends one request and returns the reply the node broadcast for it. */
  async function roundTrip(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const before = sent.length;
    await internals.handleMessage(message);
    const replies = sent.slice(before);
    const reply = replies[0];
    assert.equal(replies.length, 1, `expected exactly one reply to ${String(message.type)}`);
    assert.ok(reply, "no reply was broadcast");
    return reply;
  }

  it("gdrive_status_request reports the connected account, quota and queue", async () => {
    const reply = await roundTrip({ type: "gdrive_status_request", requestId: "r-status" });
    assert.equal(reply.type, "gdrive_status_reply");
    assert.equal(reply.requestId, "r-status");
    assert.equal(reply.status, "connected");
    assert.equal(reply.email, TOKEN_FILE.email);
    assert.equal(reply.folderName, "Nightjar");
    assert.equal(reply.enabled, false);
    assert.equal(reply.shareLinks, false);
    assert.equal(reply.queued, 0);
    assert.deepEqual(reply.quota, { usageBytes: 1073741824, limitBytes: 16106127360 });
  });

  it("gdrive_toggle_request flips each switch independently and persists it", async () => {
    const enabled = await roundTrip({
      type: "gdrive_toggle_request",
      requestId: "r-toggle-1",
      enabled: true,
    });
    assert.equal(enabled.type, "gdrive_toggle_reply");
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.shareLinks, false, "shareLinks must be left alone");
    assert.equal(store.get().backup.gdrive.enabled, true);

    const shared = await roundTrip({
      type: "gdrive_toggle_request",
      requestId: "r-toggle-2",
      shareLinks: true,
    });
    assert.equal(shared.enabled, true, "enabled must be left alone");
    assert.equal(shared.shareLinks, true);
    assert.equal(store.get().backup.gdrive.shareLinks, true);

    // The write really landed on disk, not just in the in-memory config.
    const onDisk = JSON.parse(readFileSync(configFile, "utf8")) as {
      backup: { gdrive: { enabled: boolean; shareLinks: boolean } };
    };
    assert.deepEqual(onDisk.backup.gdrive.enabled, true);
    assert.deepEqual(onDisk.backup.gdrive.shareLinks, true);
  });

  it("gdrive_disconnect_request revokes at Google and deletes the token file", async () => {
    const reply = await roundTrip({ type: "gdrive_disconnect_request", requestId: "r-disconnect" });
    assert.equal(reply.type, "gdrive_disconnect_reply");
    assert.equal(reply.status, "disconnected");
    assert.deepEqual(google.revokedTokens, [TOKEN_FILE.refreshToken]);
    assert.equal(existsSync(tokenPath), false, "token file must be gone");
  });

  it("gdrive_connect_request returns the device code to show in the dashboard", async () => {
    const reply = await roundTrip({ type: "gdrive_connect_request", requestId: "r-connect" });
    assert.equal(reply.type, "gdrive_connect_reply");
    assert.equal(reply.status, "connecting");
    assert.equal(reply.userCode, USER_CODE);
    assert.equal(reply.verificationUrl, "https://www.google.com/device");
    assert.ok(Date.parse(String(reply.expiresAt)) > Date.now(), "expiry must be in the future");

    // Polling while the code is pending keeps reporting the same code.
    const polled = await roundTrip({ type: "gdrive_status_request", requestId: "r-poll" });
    assert.equal(polled.status, "connecting");
    assert.equal(polled.userCode, USER_CODE);
  });

  it("no reply ever carries token material", () => {
    assert.ok(sent.length >= 5, "expected replies to inspect");
    const serialized = JSON.stringify(sent);
    for (const secret of [
      TOKEN_FILE.refreshToken,
      TOKEN_FILE.accessToken,
      CLIENT_SECRET,
      "refreshToken",
      "accessToken",
      "clientSecret",
      "clientId",
    ]) {
      assert.equal(
        serialized.includes(secret),
        false,
        `"${secret}" leaked into a realtime reply: ${serialized}`,
      );
    }
    // And no handler fell through to an error reply.
    for (const reply of sent) assert.notEqual(reply.type, "error");
  });
});
