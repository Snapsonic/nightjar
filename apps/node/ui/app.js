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
