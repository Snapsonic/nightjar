/* Nightjar local UI — vanilla JS, no build step. */
"use strict";

const POLL_MS = 5000;

/** cameraId -> { pc: RTCPeerConnection, video: HTMLVideoElement, starting: boolean } */
const players = new Map();
/** cameraId -> card element */
const cards = new Map();

const el = (id) => document.getElementById(id);

/* ---------------- WHEP player ---------------- */

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000); // don't hang forever on gathering
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function startPlayer(cameraId, video) {
  const existing = players.get(cameraId);
  if (existing && (existing.starting || existing.pc.connectionState === "connected")) return;
  stopPlayer(cameraId);

  const pc = new RTCPeerConnection();
  const stream = new MediaStream();
  const entry = { pc, video, starting: true };
  players.set(cameraId, entry);

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });
  pc.ontrack = (event) => {
    stream.addTrack(event.track);
    if (video.srcObject !== stream) video.srcObject = stream;
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      stopPlayer(cameraId); // next poll restarts it if the camera is online
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const res = await fetch(`/api/whep/${encodeURIComponent(cameraId)}`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) throw new Error(`WHEP HTTP ${res.status}`);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    entry.starting = false;
  } catch (err) {
    console.warn(`WHEP failed for ${cameraId}:`, err);
    stopPlayer(cameraId);
  }
}

function stopPlayer(cameraId) {
  const entry = players.get(cameraId);
  if (!entry) return;
  players.delete(cameraId);
  try {
    entry.pc.close();
  } catch {}
  if (entry.video) entry.video.srcObject = null;
}

/* ---------------- rendering ---------------- */

function renderHeader(status) {
  const dot = el("statusDot");
  const text = el("statusText");
  const cloud = status.cloud || { state: "disabled" };
  const online = status.cameras.filter((c) => c.online).length;
  const parts = [`${online}/${status.cameras.length} cameras`];

  let cls = "dot-warn";
  if (cloud.state === "online") {
    cls = "dot-ok";
    parts.unshift("cloud connected");
  } else if (cloud.state === "disabled") {
    cls = status.go2rtcHealthy ? "dot-ok" : "dot-warn";
    parts.unshift("local only");
  } else if (cloud.state === "unclaimed") {
    parts.unshift("awaiting pairing");
  } else if (cloud.state === "error") {
    cls = "dot-bad";
    parts.unshift("cloud error");
  } else {
    parts.unshift(cloud.state);
  }
  if (!status.go2rtcHealthy) {
    cls = "dot-bad";
    parts.push("go2rtc unreachable");
  }
  dot.className = `dot ${cls}`;
  text.textContent = parts.join(" · ");

  el("footerMeta").textContent =
    `${status.nodeName} · v${status.version}` + (status.nodeId ? ` · ${status.nodeId}` : "");
}

function renderPairing(status) {
  const section = el("pairing");
  const cloud = status.cloud || { state: "disabled" };
  section.textContent = "";

  if (cloud.state === "unclaimed") {
    section.classList.remove("hidden");
    const h2 = document.createElement("h2");
    h2.textContent = "Pair this node";
    const code = document.createElement("div");
    code.className = "claim-code";
    code.textContent = cloud.claimCode || "——————";
    const hint = document.createElement("p");
    hint.className = "hint";
    if (cloud.claimCode) {
      const strong = document.createElement("strong");
      strong.textContent = "app.nightjar.ca";
      hint.append("Enter this code at ", strong, " to claim your node.");
      if (cloud.claimCodeExpiresAt) {
        const expires = new Date(cloud.claimCodeExpiresAt);
        if (expires.getTime() < Date.now()) {
          hint.append(" (Code expired — restart pairing from the app.)");
        } else {
          hint.append(` Code expires at ${expires.toLocaleTimeString()}.`);
        }
      }
    } else {
      hint.textContent = "Waiting to be claimed. Claim code unavailable (shown once at registration).";
    }
    section.append(h2, code, hint);
  } else if (cloud.state === "online" || cloud.state === "connecting") {
    section.classList.remove("hidden");
    const badge = document.createElement("span");
    badge.className = "paired-badge";
    badge.textContent = cloud.state === "online" ? "● Paired — cloud connected" : "● Paired — connecting…";
    section.append(badge);
  } else if (cloud.state === "error") {
    section.classList.remove("hidden");
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = `Cloud link error: ${cloud.message || "unknown"}`;
    section.append(p);
  } else {
    section.classList.add("hidden");
  }
}

function buildCameraCard(camera) {
  const card = document.createElement("article");
  card.className = "camera-card";
  card.dataset.cameraId = camera.id;

  const videoWrap = document.createElement("div");
  videoWrap.className = "camera-video";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  const overlay = document.createElement("div");
  overlay.className = "offline-overlay";
  overlay.textContent = "offline";
  videoWrap.append(video, overlay);

  const meta = document.createElement("div");
  meta.className = "camera-meta";

  const nameWrap = document.createElement("div");
  nameWrap.className = "camera-name";
  const dot = document.createElement("span");
  dot.className = "dot dot-unknown";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = camera.name;
  const caps = document.createElement("span");
  caps.className = "camera-caps";
  nameWrap.append(dot, name, caps);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    if (!confirm(`Delete camera "${camera.name}"?`)) return;
    del.disabled = true;
    try {
      const res = await fetch(`/api/cameras/${encodeURIComponent(camera.id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.warn("delete failed:", err);
      del.disabled = false;
      return;
    }
    refresh();
  });

  meta.append(nameWrap, del);
  card.append(videoWrap, meta);
  return { card, video, overlay, dot, name, caps };
}

function renderCameras(status) {
  const grid = el("cameraGrid");
  const seen = new Set();

  for (const camera of status.cameras) {
    seen.add(camera.id);
    let entry = cards.get(camera.id);
    if (!entry) {
      entry = buildCameraCard(camera);
      cards.set(camera.id, entry);
      grid.append(entry.card);
    }
    entry.name.textContent = camera.name;
    entry.dot.className = `dot ${camera.online ? "dot-ok" : "dot-bad"}`;
    const c = camera.capabilities || {};
    entry.caps.textContent = [
      c.width && c.height ? `${c.width}×${c.height}` : null,
      c.videoCodec || null,
      camera.hasSubstream ? "sub" : null,
    ]
      .filter(Boolean)
      .join(" · ");

    if (camera.online && camera.enabled) {
      entry.overlay.classList.add("hidden");
      startPlayer(camera.id, entry.video);
    } else {
      entry.overlay.classList.remove("hidden");
      entry.overlay.textContent = camera.enabled ? "offline" : "disabled";
      stopPlayer(camera.id);
    }
  }

  for (const [cameraId, entry] of [...cards]) {
    if (!seen.has(cameraId)) {
      stopPlayer(cameraId);
      entry.card.remove();
      cards.delete(cameraId);
    }
  }

  el("noCameras").classList.toggle("hidden", status.cameras.length > 0);
}

/* ---------------- events ---------------- */

function renderEvents(events, cameraNames) {
  const list = el("eventList");
  list.textContent = "";
  for (const event of events) {
    const item = document.createElement("li");
    item.className = "event-item";
    const kind = document.createElement("span");
    kind.className = `event-kind event-kind-${event.kind}`;
    kind.textContent = event.kind;
    const camera = document.createElement("span");
    camera.className = "event-camera";
    camera.textContent = cameraNames.get(event.cameraId) || event.cameraId.slice(0, 8);
    const when = document.createElement("span");
    when.className = "event-time";
    when.textContent = new Date(event.startedAt).toLocaleString();
    const status = document.createElement("span");
    status.className = "event-status";
    status.textContent = event.clipStatus === "uploaded" ? "uploaded" : event.clipStatus;
    item.append(kind, camera, when, status);
    list.append(item);
  }
  el("noEvents").classList.toggle("hidden", events.length > 0);
}

async function refreshEvents(status) {
  let events;
  try {
    const res = await fetch("/api/events");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    events = await res.json();
  } catch {
    return; // keep the previous list on transient errors
  }
  const cameraNames = new Map(status.cameras.map((c) => [c.id, c.name]));
  renderEvents(events, cameraNames);
}

/* ---------------- Google Drive backup ---------------- */

/** True while a backup action (connect/disconnect/toggle) is in flight —
 *  keeps the poller from rebuilding the card mid-click. */
let backupBusy = false;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

async function backupAction(url, body) {
  backupBusy = true;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error((payload && payload.error) || `HTTP ${res.status}`);
    if (payload) renderBackup(payload);
  } catch (err) {
    console.warn("backup action failed:", err);
  } finally {
    backupBusy = false;
  }
  refreshBackup();
}

function backupButton(label, onClick, danger) {
  const button = document.createElement("button");
  button.type = "button";
  if (danger) button.className = "danger";
  button.textContent = label;
  button.addEventListener("click", () => {
    button.disabled = true;
    onClick();
  });
  return button;
}

function renderBackup(backup) {
  const card = el("backupCard");
  card.textContent = "";

  if (backup.status === "notConfigured") {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Google Drive backup is not configured on this build. ";
    const link = document.createElement("a");
    link.href = "https://github.com/Snapsonic/nightjar/blob/main/apps/node/README.md#google-drive-backup";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "See the node README";
    p.append(link, " for how to supply your own Google OAuth client.");
    card.append(p);
    return;
  }

  if (backup.status === "disconnected" || backup.status === "error") {
    if (backup.status === "error") {
      const err = document.createElement("p");
      err.className = "error";
      err.textContent = `Google Drive: ${backup.message || "unknown error"}`;
      card.append(err);
    }
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent =
      "Event clips can also copy to your own Google Drive. " +
      "Nightjar can only see files it creates — never the rest of your Drive.";
    const row = document.createElement("div");
    row.className = "form-row";
    row.append(
      backupButton(backup.status === "error" ? "Try again" : "Connect Google Drive", () =>
        backupAction("/api/backup/gdrive/connect"),
      ),
    );
    card.append(p, row);
    return;
  }

  if (backup.status === "connecting") {
    const h = document.createElement("p");
    h.className = "hint";
    const strong = document.createElement("strong");
    strong.textContent = (backup.verificationUrl || "https://google.com/device").replace(
      /^https?:\/\//,
      "",
    );
    h.append("On any device, go to ", strong, " and enter this code:");
    const code = document.createElement("div");
    code.className = "claim-code";
    code.textContent = backup.userCode || "————";
    const hint = document.createElement("p");
    hint.className = "hint";
    if (backup.expiresAt) {
      hint.textContent = `Code expires at ${new Date(backup.expiresAt).toLocaleTimeString()}.`;
    }
    card.append(h, code, hint);
    return;
  }

  if (backup.status === "connected") {
    const rows = document.createElement("dl");
    rows.className = "backup-rows";
    const addRow = (label, value) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      rows.append(dt, dd);
    };
    addRow("Account", backup.email || "—");
    if (backup.quota) {
      addRow(
        "Drive usage",
        backup.quota.limitBytes === null
          ? `${formatBytes(backup.quota.usageBytes)} used`
          : `${formatBytes(backup.quota.usageBytes)} of ${formatBytes(backup.quota.limitBytes)} used`,
      );
    }
    addRow("Folder", backup.folderName || "Nightjar");
    addRow("Queued clips", String(backup.queued ?? 0));

    const toggle = document.createElement("label");
    toggle.className = "backup-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!backup.enabled;
    checkbox.addEventListener("change", () => {
      checkbox.disabled = true;
      backupAction("/api/backup/gdrive/toggle", { enabled: checkbox.checked });
    });
    toggle.append(checkbox, " Back up new event clips to Drive");

    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Nightjar can only see files it creates — never the rest of your Drive.";

    const row = document.createElement("div");
    row.className = "form-row";
    row.append(
      backupButton(
        "Disconnect",
        () => {
          if (confirm("Disconnect Google Drive? Already-backed-up clips stay in your Drive.")) {
            backupAction("/api/backup/gdrive/disconnect");
          } else {
            refreshBackup();
          }
        },
        true,
      ),
    );
    card.append(rows, toggle, note, row);
  }
}

async function refreshBackup() {
  if (backupBusy) return;
  let backup;
  try {
    const res = await fetch("/api/backup/gdrive");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    backup = await res.json();
  } catch {
    return; // keep the previous card on transient errors
  }
  if (!backupBusy) renderBackup(backup);
}

/* ---------------- status polling ---------------- */

async function refresh() {
  let status;
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status = await res.json();
  } catch (err) {
    el("statusDot").className = "dot dot-bad";
    el("statusText").textContent = "node unreachable";
    return;
  }
  renderHeader(status);
  renderPairing(status);
  renderCameras(status);
  refreshEvents(status);
  refreshBackup();
}

/* ---------------- add-camera form ---------------- */

el("addCameraForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = el("addCameraButton");
  const errorEl = el("addCameraError");
  errorEl.textContent = "";

  const data = new FormData(form);
  const body = {
    name: String(data.get("name") || "").trim(),
    rtspUrl: String(data.get("rtspUrl") || "").trim(),
  };
  const sub = String(data.get("rtspSubUrl") || "").trim();
  if (sub) body.rtspSubUrl = sub;

  button.disabled = true;
  button.textContent = "Probing…";
  try {
    const res = await fetch("/api/cameras", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
    form.reset();
    refresh();
  } catch (err) {
    errorEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    button.disabled = false;
    button.textContent = "Add camera";
  }
});

/* ---------------- boot ---------------- */

refresh();
setInterval(refresh, POLL_MS);
