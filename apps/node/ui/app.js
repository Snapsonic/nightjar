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

/** True when getUserMedia exists — requires a secure context (HTTPS or
 *  localhost). Over plain http://LAN-IP it is undefined and talkback
 *  degrades to listen-only with a hint. */
function micSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

async function startPlayer(camera, video) {
  const cameraId = camera.id;
  const existing = players.get(cameraId);
  if (existing && (existing.starting || existing.pc.connectionState === "connected")) return;
  stopPlayer(cameraId);

  const pc = new RTCPeerConnection();
  const stream = new MediaStream();
  const entry = { pc, video, starting: true, micStream: null, micTrack: null };
  players.set(cameraId, entry);

  // Talkback (push-to-talk): the mic track must be part of the offer —
  // go2rtc's SDP exchange is one-shot, there is no renegotiation later.
  const caps = camera.capabilities || {};
  if (caps.talkback === "backchannel" && micSupported()) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = mic.getAudioTracks()[0] || null;
      if (track) {
        track.enabled = false; // hold-to-talk enables it
        entry.micStream = mic;
        entry.micTrack = track;
      }
    } catch (err) {
      console.warn(`microphone unavailable for ${cameraId}:`, err);
    }
    if (players.get(cameraId) !== entry) {
      // stopped while the mic permission prompt was open
      if (entry.micStream) for (const t of entry.micStream.getTracks()) t.stop();
      return;
    }
  }

  pc.addTransceiver("video", { direction: "recvonly" });
  if (entry.micTrack) {
    pc.addTransceiver(entry.micTrack, { direction: "sendrecv" });
  } else {
    pc.addTransceiver("audio", { direction: "recvonly" });
  }
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
  if (entry.micStream) for (const t of entry.micStream.getTracks()) t.stop();
  if (entry.video) entry.video.srcObject = null;
}

/* ---------------- history timeline ---------------- */

const HISTORY_PRE_MS = 30_000;
const HISTORY_POST_MS = 90_000;
/** Hover preview: wait this long before asking the node for a frame. */
const PREVIEW_DEBOUNCE_MS = 250;
const PREVIEW_BUCKET_MS = 60_000;
/** Revoke + drop cached preview object URLs beyond this many buckets. */
const PREVIEW_CACHE_MAX = 200;

function historyDayStartMs(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function historyDayEndMs(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + 1).getTime();
}

function setHistoryStatus(entry, text, isError) {
  entry.historyStatus.textContent = text;
  entry.historyStatus.classList.toggle("error", !!isError);
}

function renderHistorySpans(entry) {
  const bar = entry.historyBar;
  for (const old of bar.querySelectorAll(".timeline-span")) old.remove();
  const dayStart = historyDayStartMs(entry.historyDay);
  const dayLen = historyDayEndMs(entry.historyDay) - dayStart;
  for (const span of entry.historySpans) {
    const div = document.createElement("div");
    div.className = "timeline-span";
    const left = ((span.startMs - dayStart) / dayLen) * 100;
    const width = ((span.endMs - span.startMs) / dayLen) * 100;
    div.style.left = `${Math.max(0, left)}%`;
    div.style.width = `${Math.max(0.15, Math.min(100 - left, width))}%`;
    bar.append(div);
  }
  positionHistoryIndicator(entry);
}

/* ----- now-playing indicator (range highlight + moving playhead) ----- */

function positionHistoryIndicator(entry) {
  const active = entry.historyActive;
  const playhead = entry.historyPlayhead;
  if (!active || !playhead) return;
  const range = entry.historyRange;
  if (!range || range.day !== entry.historyDay) {
    active.classList.add("hidden");
    playhead.classList.add("hidden");
    return;
  }
  const dayStart = historyDayStartMs(range.day);
  const dayLen = historyDayEndMs(range.day) - dayStart;
  const left = Math.max(0, ((range.fromMs - dayStart) / dayLen) * 100);
  const right = Math.min(100, ((range.toMs - dayStart) / dayLen) * 100);
  if (right <= left) {
    active.classList.add("hidden");
    playhead.classList.add("hidden");
    return;
  }
  active.style.left = `${left}%`;
  active.style.width = `${Math.max(right - left, 0.25)}%`;
  active.classList.remove("hidden");
  updateHistoryPlayhead(entry);
}

/** Sync the playhead line to the clip video: clipStartMs + currentTime. */
function updateHistoryPlayhead(entry) {
  const playhead = entry.historyPlayhead;
  const range = entry.historyRange;
  if (!playhead) return;
  if (!range || range.day !== entry.historyDay) {
    playhead.classList.add("hidden");
    return;
  }
  const ms = range.fromMs + (entry.video.currentTime || 0) * 1000;
  const dayStart = historyDayStartMs(range.day);
  const pct = ((ms - dayStart) / (historyDayEndMs(range.day) - dayStart)) * 100;
  if (pct < 0 || pct > 100) {
    playhead.classList.add("hidden");
    return;
  }
  playhead.style.left = `${pct}%`;
  playhead.classList.remove("hidden");
}

async function loadHistoryCoverage(cameraId, entry) {
  setHistoryStatus(entry, "Loading coverage…");
  try {
    const res = await fetch(
      `/api/recordings/${encodeURIComponent(cameraId)}/coverage?day=${encodeURIComponent(entry.historyDay)}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    entry.historySpans = await res.json();
    setHistoryStatus(
      entry,
      entry.historySpans.length ? "Click a recorded stretch to play it." : "No recordings this day.",
    );
  } catch (err) {
    console.warn("coverage load failed:", err);
    entry.historySpans = [];
    setHistoryStatus(entry, "Could not load coverage.", true);
  }
  renderHistorySpans(entry);
}

function playHistoryClip(cameraId, entry, fromMs, toMs) {
  stopPlayer(cameraId);
  entry.historyPlaying = true;
  entry.historyRange = { fromMs, toMs, day: entry.historyDay };
  entry.video.srcObject = null;
  entry.video.controls = true;
  entry.video.src = `/api/recordings/${encodeURIComponent(cameraId)}/export?fromMs=${fromMs}&toMs=${toMs}`;
  entry.video.play().catch(() => {});
  entry.overlay.classList.add("hidden");
  entry.historyBack.classList.remove("hidden");
  positionHistoryIndicator(entry);
  const fmt = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  setHistoryStatus(entry, `Viewing ${fmt(fromMs)} – ${fmt(toMs)}`);
}

function backToLive(cameraId, entry) {
  if (!entry.historyPlaying) return;
  entry.historyPlaying = false;
  entry.historyRange = null;
  positionHistoryIndicator(entry);
  entry.video.controls = false;
  entry.video.removeAttribute("src");
  entry.video.load();
  entry.historyBack.classList.add("hidden");
  setHistoryStatus(entry, entry.historySpans.length ? "Click a recorded stretch to play it." : "");
  refresh(); // restarts the WHEP player on the next render
}

function buildHistoryUi(cameraId, entry) {
  const t = entry.timeline;
  t.textContent = "";

  if (entry.historyDays.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No 24/7 recordings for this camera yet.";
    t.append(p);
    return;
  }

  const row = document.createElement("div");
  row.className = "timeline-row";

  const select = document.createElement("select");
  select.className = "timeline-day";
  for (const day of entry.historyDays) {
    const option = document.createElement("option");
    option.value = day;
    option.textContent = day;
    select.append(option);
  }
  select.value = entry.historyDay;
  select.addEventListener("change", () => {
    entry.historyDay = select.value;
    loadHistoryCoverage(cameraId, entry);
  });

  const back = document.createElement("button");
  back.type = "button";
  back.className = "timeline-back hidden";
  back.textContent = "Back to live";
  back.addEventListener("click", () => backToLive(cameraId, entry));
  entry.historyBack = back;

  const status = document.createElement("span");
  status.className = "timeline-status muted";
  entry.historyStatus = status;

  row.append(select, back, status);

  const barWrap = document.createElement("div");
  barWrap.className = "timeline-bar-wrap";

  const bar = document.createElement("div");
  bar.className = "timeline-bar";
  entry.historyBar = bar;

  const cursor = document.createElement("div");
  cursor.className = "timeline-cursor hidden";
  bar.append(cursor);

  // Now-playing indicator: highlighted clip range + moving playhead.
  const active = document.createElement("div");
  active.className = "timeline-active hidden";
  const playhead = document.createElement("div");
  playhead.className = "timeline-playhead hidden";
  bar.append(active, playhead);
  entry.historyActive = active;
  entry.historyPlayhead = playhead;

  // Floating hover preview (thumbnail + timestamp) above the bar.
  const preview = document.createElement("div");
  preview.className = "timeline-preview hidden";
  const previewImg = document.createElement("img");
  previewImg.alt = "";
  const previewMsg = document.createElement("div");
  previewMsg.className = "timeline-preview-msg hidden";
  const previewSpin = document.createElement("div");
  previewSpin.className = "timeline-preview-spin hidden";
  const previewTime = document.createElement("div");
  previewTime.className = "timeline-preview-time";
  preview.append(previewImg, previewMsg, previewSpin, previewTime);
  barWrap.append(bar, preview);

  const setPreviewContent = (url, msg) => {
    previewImg.classList.toggle("hidden", !url);
    previewMsg.classList.toggle("hidden", !!url || msg === null);
    previewSpin.classList.toggle("hidden", !!url || msg !== null);
    if (url) previewImg.src = url;
    else if (msg !== null) previewMsg.textContent = msg;
  };

  const applyCachedPreview = (bucket) => {
    const url = entry.previewCache.get(bucket);
    setPreviewContent(url, url === null ? "no preview" : null);
  };

  const fetchPreview = async (bucket) => {
    const seq = ++entry.previewSeq;
    try {
      const res = await fetch(
        `/api/recordings/${encodeURIComponent(cameraId)}/preview?atMs=${bucket}`,
      );
      if (res.status === 404) {
        entry.previewCache.set(bucket, null);
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      } else {
        if (entry.previewCache.size >= PREVIEW_CACHE_MAX) {
          for (const url of entry.previewCache.values()) {
            if (url) URL.revokeObjectURL(url);
          }
          entry.previewCache.clear();
        }
        entry.previewCache.set(bucket, URL.createObjectURL(await res.blob()));
      }
    } catch (err) {
      console.warn("preview failed:", err);
      entry.previewCache.set(bucket, null);
    }
    // Only the latest request may update the tooltip (stale ones just cache).
    if (entry.previewSeq === seq && !preview.classList.contains("hidden")) {
      applyCachedPreview(bucket);
    }
  };

  const timeAtEvent = (ev) => {
    const rect = bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const dayStart = historyDayStartMs(entry.historyDay);
    return dayStart + frac * (historyDayEndMs(entry.historyDay) - dayStart);
  };
  const hidePreview = () => {
    entry.previewSeq++; // orphan any in-flight request
    if (entry.previewTimer) clearTimeout(entry.previewTimer);
    entry.previewTimer = null;
    preview.classList.add("hidden");
    cursor.classList.add("hidden");
  };
  const moveHandler = (ev) => {
    const rect = bar.getBoundingClientRect();
    if (!rect.width) return;
    const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    cursor.classList.remove("hidden");
    cursor.style.left = `${frac * 100}%`;
    const ms = timeAtEvent(ev);
    bar.title = "";
    preview.classList.remove("hidden");
    preview.style.left = `${Math.min(92, Math.max(8, frac * 100))}%`;
    previewTime.textContent = new Date(ms).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    entry.previewSeq++; // whatever was in flight no longer wins
    if (entry.previewTimer) clearTimeout(entry.previewTimer);
    entry.previewTimer = null;
    const covered = entry.historySpans.some((s) => ms >= s.startMs && ms <= s.endMs);
    if (!covered) {
      setPreviewContent(null, "no recording");
      return;
    }
    const bucket = Math.floor(ms / PREVIEW_BUCKET_MS) * PREVIEW_BUCKET_MS;
    if (entry.previewCache.has(bucket)) {
      applyCachedPreview(bucket); // warm — show instantly, no debounce
      return;
    }
    setPreviewContent(null, null); // spinner while debouncing/fetching
    entry.previewTimer = setTimeout(() => fetchPreview(bucket), PREVIEW_DEBOUNCE_MS);
  };
  bar.addEventListener("pointermove", moveHandler);
  bar.addEventListener("pointerdown", moveHandler); // touch-drag scrubbing
  bar.addEventListener("pointerleave", hidePreview);
  bar.addEventListener("pointercancel", hidePreview);
  bar.addEventListener("click", (ev) => {
    const clicked = Math.round(timeAtEvent(ev));
    const span = entry.historySpans.find((s) => clicked >= s.startMs && clicked <= s.endMs);
    if (!span) {
      setHistoryStatus(entry, "No recording at that time.");
      return;
    }
    playHistoryClip(cameraId, entry, clicked - HISTORY_PRE_MS, clicked + HISTORY_POST_MS);
  });

  const hours = document.createElement("div");
  hours.className = "timeline-hours";
  for (const h of ["00:00", "06:00", "12:00", "18:00", "24:00"]) {
    const label = document.createElement("span");
    label.textContent = h;
    hours.append(label);
  }

  t.append(row, barWrap, hours);
  positionHistoryIndicator(entry);
}

async function toggleHistory(cameraId, entry) {
  if (entry.historyOpen) {
    entry.historyOpen = false;
    entry.historyBtn.textContent = "History";
    entry.timeline.classList.add("hidden");
    backToLive(cameraId, entry);
    return;
  }
  entry.historyOpen = true;
  entry.historyBtn.textContent = "Hide history";
  entry.timeline.classList.remove("hidden");
  entry.timeline.textContent = "Loading…";
  try {
    const res = await fetch(`/api/recordings/${encodeURIComponent(cameraId)}/days`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    entry.historyDays = await res.json();
  } catch (err) {
    console.warn("days load failed:", err);
    entry.historyDays = [];
  }
  entry.historyDay = entry.historyDays[entry.historyDays.length - 1] || null;
  buildHistoryUi(cameraId, entry);
  if (entry.historyDay) await loadHistoryCoverage(cameraId, entry);
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

  const muteBtn = document.createElement("button");
  muteBtn.type = "button";
  muteBtn.className = "audio-toggle";
  muteBtn.textContent = "Unmute";
  muteBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? "Unmute" : "Mute";
  });

  const talkBtn = document.createElement("button");
  talkBtn.type = "button";
  talkBtn.className = "talk-button hidden";
  talkBtn.textContent = "Hold to talk";
  const setTalking = (on) => {
    const player = players.get(camera.id);
    const track = player && player.micTrack;
    if (!track) return;
    track.enabled = on;
    talkBtn.textContent = on ? "Talking…" : "Hold to talk";
    talkBtn.classList.toggle("talking", on);
  };
  talkBtn.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    setTalking(true);
  });
  for (const evName of ["pointerup", "pointerleave", "pointercancel"]) {
    talkBtn.addEventListener(evName, () => setTalking(false));
  }
  talkBtn.addEventListener("contextmenu", (ev) => ev.preventDefault());

  const talkHint = document.createElement("span");
  talkHint.className = "talk-hint muted hidden";

  const historyBtn = document.createElement("button");
  historyBtn.type = "button";
  historyBtn.className = "history-toggle";
  historyBtn.textContent = "History";

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

  const actions = document.createElement("div");
  actions.className = "camera-actions";
  actions.append(talkHint, muteBtn, talkBtn, historyBtn, del);
  meta.append(nameWrap, actions);

  const timeline = document.createElement("div");
  timeline.className = "timeline hidden";

  card.append(videoWrap, meta, timeline);
  const entry = {
    card,
    video,
    overlay,
    dot,
    name,
    caps,
    timeline,
    muteBtn,
    talkBtn,
    talkHint,
    historyBtn,
    historyOpen: false,
    historyPlaying: false,
    historyDay: null,
    historyDays: [],
    historySpans: [],
    historyBar: null,
    historyStatus: null,
    historyBack: null,
    historyRange: null,
    historyActive: null,
    historyPlayhead: null,
    previewCache: new Map(),
    previewTimer: null,
    previewSeq: 0,
  };
  historyBtn.addEventListener("click", () => toggleHistory(camera.id, entry));
  video.addEventListener("error", () => {
    if (entry.historyPlaying) setHistoryStatus(entry, "Could not load that clip.", true);
  });
  video.addEventListener("timeupdate", () => {
    if (entry.historyPlaying) updateHistoryPlayhead(entry);
  });
  return entry;
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
    // Older configs lack hasAudio — fall back to audioCodec presence.
    const hasAudio = c.hasAudio !== undefined ? c.hasAudio : !!c.audioCodec;
    entry.caps.textContent = [
      c.width && c.height ? `${c.width}×${c.height}` : null,
      c.videoCodec || null,
      hasAudio ? "audio" : null,
      camera.hasSubstream ? "sub" : null,
    ]
      .filter(Boolean)
      .join(" · ");

    // Talkback controls: hold-to-talk when the camera has a backchannel and
    // the page can use the mic; hints otherwise. getUserMedia needs a secure
    // context — http://LAN-IP has no navigator.mediaDevices.
    const talkback = c.talkback === "backchannel";
    entry.talkBtn.classList.toggle("hidden", !(talkback && micSupported()));
    if (talkback && !micSupported()) {
      entry.talkHint.textContent = "talkback needs https or localhost";
      entry.talkHint.classList.remove("hidden");
    } else if (!talkback && hasAudio) {
      entry.talkHint.textContent = "camera can't receive audio";
      entry.talkHint.classList.remove("hidden");
    } else {
      entry.talkHint.classList.add("hidden");
    }

    if (entry.historyPlaying) {
      // Viewing recorded history — leave the <video> alone until "Back to live".
      entry.overlay.classList.add("hidden");
    } else if (camera.online && camera.enabled) {
      entry.overlay.classList.add("hidden");
      startPlayer(camera, entry.video);
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

/* ---------------- Nest cameras (SDM bridge) ---------------- */

/** True while a nest action is in flight or the connect flow is showing —
 *  keeps the poller from rebuilding the card mid-interaction. */
let nestBusy = false;
let nestFlowActive = false;
/** Devices response cache so re-renders between polls stay stable. */
let nestDevicesResult = null;

function nestHint(text) {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}

function nestLink(href, label) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.textContent = label || href.replace(/^https?:\/\//, "");
  return a;
}

async function nestFetchJson(url, body) {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error((payload && payload.error) || `HTTP ${res.status}`);
  return payload;
}

/** The compact checklist of Google-side prerequisites, with links. */
function nestPrereqList() {
  const ol = document.createElement("ol");
  ol.className = "nest-prereqs";
  const items = [
    [
      "In the ",
      nestLink("https://console.cloud.google.com/", "Google Cloud Console"),
      ", create a project, enable the Smart Device Management API, and publish an External OAuth consent screen.",
    ],
    [
      "Create an OAuth client of type “Web application” with ",
      (() => { const s = document.createElement("strong"); s.textContent = "https://www.google.com"; return s; })(),
      " as an authorized redirect URI.",
    ],
    [
      "Register for Device Access at ",
      nestLink("https://console.nest.google.com/device-access", "console.nest.google.com/device-access"),
      " ($5 one-time), create a Device Access project with that OAuth client ID, and copy its project ID.",
    ],
  ];
  for (const parts of items) {
    const li = document.createElement("li");
    li.append(...parts);
    ol.append(li);
  }
  return ol;
}

function nestCaveats() {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent =
    "Experimental. Works with 2021-and-newer Nest cams (WebRTC) and some older models via RTSP; " +
    "battery cameras that sleep will not stream continuously. Video still transits Google's " +
    "servers, and Google charges a one-time $5 Device Access fee.";
  return p;
}

function renderNestCredentialsForm(card, isEdit) {
  const form = document.createElement("form");
  form.autocomplete = "off";
  const fields = [
    ["projectId", "Device Access project ID", "e.g. 32c4c2bc-fe0d-461b-b51c-…"],
    ["clientId", "OAuth client ID", "…apps.googleusercontent.com"],
    ["clientSecret", "OAuth client secret", "GOCSPX-…"],
  ];
  for (const [name, label, placeholder] of fields) {
    const wrap = document.createElement("label");
    wrap.append(label);
    const input = document.createElement("input");
    input.name = name;
    input.type = name === "clientSecret" ? "password" : "text";
    input.required = true;
    input.placeholder = placeholder;
    wrap.append(input);
    form.append(wrap);
  }
  const row = document.createElement("div");
  row.className = "form-row";
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save credentials";
  const error = document.createElement("span");
  error.className = "error";
  row.append(save, error);
  form.append(row);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    save.disabled = true;
    nestBusy = true;
    const data = new FormData(form);
    try {
      const status = await nestFetchJson("/api/nest/credentials", {
        projectId: String(data.get("projectId") || "").trim(),
        clientId: String(data.get("clientId") || "").trim(),
        clientSecret: String(data.get("clientSecret") || "").trim(),
      });
      nestFlowActive = false;
      renderNest(status);
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
      save.disabled = false;
    } finally {
      nestBusy = false;
    }
  });
  if (isEdit) {
    card.append(nestHint("Enter new SDM credentials (replaces the saved ones):"));
  } else {
    card.append(
      nestHint(
        "Bring your Nest cameras into Nightjar via Google's Smart Device Management API. " +
          "One-time Google-side setup first:",
      ),
      nestPrereqList(),
    );
  }
  card.append(form, nestCaveats());
}

function renderNestConnectFlow(card, authUrl) {
  card.append(nestHint("1. Open the Google consent page and sign in with the account that owns your Nest cameras:"));
  const linkRow = document.createElement("p");
  linkRow.className = "hint";
  linkRow.append(nestLink(authUrl, "Open Google sign-in"));
  card.append(linkRow);
  card.append(
    nestHint(
      "2. After approving, you land on google.com — the address bar holds ?code=… . " +
        "Copy the FULL URL from the address bar and paste it here:",
    ),
  );
  const form = document.createElement("form");
  form.autocomplete = "off";
  const label = document.createElement("label");
  label.append("Pasted URL (or just the code)");
  const input = document.createElement("input");
  input.name = "codeOrUrl";
  input.type = "text";
  input.required = true;
  input.placeholder = "https://www.google.com/?code=4/0A…";
  label.append(input);
  const row = document.createElement("div");
  row.className = "form-row";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Finish connection";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "danger";
  cancel.textContent = "Cancel";
  const error = document.createElement("span");
  error.className = "error";
  row.append(submit, cancel, error);
  form.append(label, row);
  cancel.addEventListener("click", () => {
    nestFlowActive = false;
    refreshNest();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    nestBusy = true;
    try {
      const status = await nestFetchJson("/api/nest/code", {
        codeOrUrl: String(new FormData(form).get("codeOrUrl") || "").trim(),
      });
      nestFlowActive = false;
      renderNest(status);
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
      submit.disabled = false;
    } finally {
      nestBusy = false;
    }
  });
  card.append(form);
}

function renderNestDevices(card, result) {
  if (result.needsPartnerLink) {
    const p = document.createElement("p");
    p.className = "hint";
    p.append(
      "Google returned no devices. You still need to link your Nest devices to your Device " +
        "Access project in the Partner Connections Manager: ",
      nestLink(result.partnerConnectionsUrl),
      " — tick your cameras, finish the flow, then refresh here.",
    );
    card.append(p);
    return;
  }
  const added = new Set(result.addedDeviceIds || []);
  const list = document.createElement("ul");
  list.className = "nest-device-list";
  for (const device of result.devices) {
    const item = document.createElement("li");
    item.className = "nest-device";
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "nest-device-name";
    name.textContent = device.name + (device.room && device.room !== device.name ? ` — ${device.room}` : "");
    const meta = document.createElement("div");
    meta.className = "nest-device-meta";
    meta.textContent = [
      device.type ? device.type.replace(/^sdm\.devices\.types\./, "").toLowerCase() : null,
      device.protocols.length ? device.protocols.join("/") : null,
      device.maxVideoResolution ? `${device.maxVideoResolution.width}×${device.maxVideoResolution.height}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    info.append(name, meta);
    const button = document.createElement("button");
    button.type = "button";
    if (added.has(device.deviceId)) {
      button.textContent = "Added";
      button.disabled = true;
    } else {
      button.textContent = "Add as camera";
      button.addEventListener("click", async () => {
        button.disabled = true;
        nestBusy = true;
        try {
          await nestFetchJson("/api/cameras", {
            name: device.name,
            source: "nest",
            nestDeviceId: device.deviceId,
            make: "Google Nest",
          });
        } catch (err) {
          console.warn("add nest camera failed:", err);
          button.disabled = false;
        } finally {
          nestBusy = false;
        }
        refresh();
        refreshNest();
      });
    }
    item.append(info, button);
    list.append(item);
  }
  card.append(list);
}

function renderNest(status, devicesResult) {
  const card = el("nestCard");
  card.textContent = "";

  if (status.status === "notConfigured") {
    renderNestCredentialsForm(card, false);
    return;
  }

  if (status.status === "disconnected" || status.status === "error") {
    if (status.status === "error") {
      const err = document.createElement("p");
      err.className = "error";
      err.textContent = `Nest: ${status.message || "unknown error"}`;
      card.append(err);
    }
    card.append(
      nestHint(
        "Credentials saved. Connect the Google account that owns your Nest cameras to list " +
          "and add them.",
      ),
    );
    const row = document.createElement("div");
    row.className = "form-row";
    const connect = document.createElement("button");
    connect.type = "button";
    connect.textContent = "Connect Google account";
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      nestBusy = true;
      try {
        const { url } = await nestFetchJson("/api/nest/auth-url");
        nestFlowActive = true;
        card.textContent = "";
        renderNestConnectFlow(card, url);
      } catch (err) {
        console.warn("nest auth-url failed:", err);
        connect.disabled = false;
      } finally {
        nestBusy = false;
      }
    });
    const editCreds = document.createElement("button");
    editCreds.type = "button";
    editCreds.className = "danger";
    editCreds.textContent = "Edit credentials";
    editCreds.addEventListener("click", () => {
      nestFlowActive = true;
      card.textContent = "";
      renderNestCredentialsForm(card, true);
    });
    row.append(connect, editCreds);
    card.append(row, nestCaveats());
    return;
  }

  if (status.status === "connected") {
    const head = document.createElement("p");
    head.className = "hint";
    head.append("Connected to Device Access project ");
    const strong = document.createElement("strong");
    strong.textContent = status.projectId;
    head.append(strong, ".");
    card.append(head);
    if (devicesResult) {
      renderNestDevices(card, devicesResult);
    } else {
      card.append(nestHint("Loading devices…"));
    }
    const row = document.createElement("div");
    row.className = "form-row";
    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.textContent = "Refresh devices";
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      nestBusy = true;
      try {
        nestDevicesResult = await nestFetchJson("/api/nest/devices?refresh=1");
      } catch (err) {
        console.warn("nest devices refresh failed:", err);
      } finally {
        nestBusy = false;
      }
      refreshNest();
    });
    const disconnect = document.createElement("button");
    disconnect.type = "button";
    disconnect.className = "danger";
    disconnect.textContent = "Disconnect";
    disconnect.addEventListener("click", async () => {
      if (!confirm("Disconnect the Nest bridge? Nest cameras will stop streaming until reconnected.")) return;
      disconnect.disabled = true;
      nestBusy = true;
      try {
        const next = await nestFetchJson("/api/nest/disconnect");
        nestDevicesResult = null;
        renderNest(next);
      } catch (err) {
        console.warn("nest disconnect failed:", err);
        disconnect.disabled = false;
      } finally {
        nestBusy = false;
      }
    });
    row.append(refreshBtn, disconnect);
    card.append(row, nestCaveats());
  }
}

async function refreshNest() {
  if (nestBusy || nestFlowActive) return;
  let status;
  try {
    const res = await fetch("/api/nest");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status = await res.json();
  } catch {
    return; // keep the previous card on transient errors
  }
  if (status.status === "connected") {
    try {
      nestDevicesResult = await fetch("/api/nest/devices").then((r) => (r.ok ? r.json() : null));
    } catch {
      // keep whatever we had
    }
  }
  if (!nestBusy && !nestFlowActive) renderNest(status, nestDevicesResult);
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
  refreshNest();
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
