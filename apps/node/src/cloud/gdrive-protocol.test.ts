import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GdriveConnectReply,
  GdriveDisconnectReply,
  GdriveStatusReply,
  GdriveToggleReply,
  GdriveToggleRequest,
  RealtimeMessage,
} from "@nightjar/shared";

/** JSON round-trip through the discriminated union, the way the wire works. */
function overTheWire(message: unknown): unknown {
  return RealtimeMessage.parse(JSON.parse(JSON.stringify(message)));
}

test("gdrive requests round-trip through the RealtimeMessage union", () => {
  for (const type of [
    "gdrive_status_request",
    "gdrive_connect_request",
    "gdrive_disconnect_request",
  ] as const) {
    const message = { type, requestId: "req-1" };
    assert.deepEqual(overTheWire(message), message);
  }
});

test("gdrive_toggle_request carries either switch, or both, or neither", () => {
  for (const patch of [{}, { enabled: true }, { shareLinks: false }, { enabled: false, shareLinks: true }]) {
    const message = { type: "gdrive_toggle_request", requestId: "req-1", ...patch };
    assert.deepEqual(overTheWire(message), message);
    assert.deepEqual(GdriveToggleRequest.parse(message), message);
  }
});

test("every gdrive reply type accepts the shared status payload", () => {
  const payloads = [
    { status: "notConfigured" },
    { status: "disconnected" },
    {
      status: "connecting",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://www.google.com/device",
      expiresAt: "2026-07-26T00:15:00.000Z",
    },
    {
      status: "connected",
      email: "person@example.com",
      folderName: "Nightjar",
      enabled: true,
      shareLinks: false,
      queued: 3,
      quota: { usageBytes: 1024, limitBytes: 16106127360 },
    },
    // Unlimited-storage accounts report no limit; email may be unknown.
    {
      status: "connected",
      email: null,
      folderName: "Nightjar",
      enabled: false,
      shareLinks: false,
      queued: 0,
      quota: { usageBytes: 0, limitBytes: null },
    },
    { status: "connected", folderName: "Nightjar", enabled: true, shareLinks: true, queued: 0, quota: null },
    { status: "error", message: "the code expired before it was entered" },
  ];
  const replies = [
    ["gdrive_status_reply", GdriveStatusReply],
    ["gdrive_connect_reply", GdriveConnectReply],
    ["gdrive_toggle_reply", GdriveToggleReply],
    ["gdrive_disconnect_reply", GdriveDisconnectReply],
  ] as const;

  for (const [type, schema] of replies) {
    for (const payload of payloads) {
      const message = { type, requestId: "req-1", ...payload };
      assert.deepEqual(schema.parse(message), message);
      assert.deepEqual(overTheWire(message), message);
    }
  }
});

test("gdrive replies reject unknown statuses and strip unknown keys", () => {
  assert.equal(
    GdriveStatusReply.safeParse({ type: "gdrive_status_reply", requestId: "r", status: "wat" })
      .success,
    false,
  );
  // Zod strips unknown keys — a stray token field could not ride along even if
  // the node tried to send one.
  const stripped = GdriveStatusReply.parse({
    type: "gdrive_status_reply",
    requestId: "r",
    status: "connected",
    refreshToken: "1//leaked",
    accessToken: "ya29.leaked",
  });
  assert.equal("refreshToken" in stripped, false);
  assert.equal("accessToken" in stripped, false);
});
