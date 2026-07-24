# @nightjar/node

The self-hosted Nightjar NVR node service. Manages cameras, keeps go2rtc's
config in sync for local/remote WebRTC live view, links the node to the
Nightjar cloud (Supabase) for pairing, signaling and status, and serves a
minimal local admin UI on port 8080.

Runs TypeScript directly via `tsx` — no build step (workspace packages export
TS source).

## Local development

Requires Node 22+, plus go2rtc and ffmpeg on the host:

```sh
brew install go2rtc ffmpeg
```

Point the node's paths at a local data dir and run both processes:

```sh
mkdir -p data/config data/db data/recordings data/go2rtc

# terminal 1 — go2rtc reading the config this service renders
go2rtc -config data/go2rtc/go2rtc.yaml

# terminal 2 — the node
CONFIG_DIR=./data/config \
DB_DIR=./data/db \
GO2RTC_CONFIG_DIR=./data/go2rtc \
NIGHTJAR_SUPABASE_URL=https://<project>.supabase.co \
NIGHTJAR_SUPABASE_ANON_KEY=<anon key> \
pnpm --filter @nightjar/node dev
```

One-time: download the object-detection model (~20 MB, see below):

```sh
pnpm --filter @nightjar/node fetch-model
```

Local UI: http://localhost:8080 (add cameras, live view, pairing code).
Leave the `NIGHTJAR_SUPABASE_*` vars unset to run local-only (cloud link
disabled). Set `PORT` to change the UI port, `LOG_LEVEL=debug` for verbose
logs. Recordings default to `/recordings` — override via `paths.recordings`
in `config.json` for local dev.

Production runs via `docker/docker-compose.yml` at the repo root.

## Module map

| Path | Status | What it does |
| --- | --- | --- |
| `src/main.ts` | real | Wires everything; graceful shutdown |
| `src/config/store.ts` | real | `config.json` (NodeConfig) with atomic writes + change events |
| `src/config/identity.ts` | real | `identity.json` — node secret (first boot) + nodeId (after register) |
| `src/cameras/manager.ts` | real | Camera CRUD + ffprobe capability probing (skipped for Nest cameras) |
| `src/cameras/streams.ts` | real | Capture-URL selection: direct RTSP, or go2rtc's :8554 restream for Nest cameras |
| `src/nest/sdm.ts` | real | Nest camera bridge: SDM OAuth (paste-back code flow), token refresh, devices.list (see "Nest cameras") |
| `src/go2rtc/supervisor.ts` | real | Renders `go2rtc.yaml`, pokes `/api/restart`, health/stream checks |
| `src/cloud/link.ts` | real | Register → claim poll → realtime channel; WHEP/snapshot/status handlers, heartbeat, camera sync |
| `src/api/server.ts` | real | Local REST API + WHEP proxy + static UI |
| `src/db.ts` | real | SQLite (segments / events mirror / upload_queue) |
| `src/recorder/recorder.ts` | real | Per-camera ffmpeg segment capture (60s fMP4), SQLite index, retention pruner, `exportRange()` |
| `src/motion/detector.ts` | real | 5 fps substream grayscale frame-diff vs rolling background; motionStart/motionEnd events |
| `src/detect/worker.ts` | real | worker_thread pool-of-1 running YOLOX-tiny via onnxruntime-node on go2rtc JPEG snapshots (see "Object detection") |
| `src/events/pipeline.ts` | real | motion → event → clip + thumbnail → local row → serial upload queue (offline-safe, bounded) |
| `src/backup/gdrive.ts` | real | Google Drive "bring your own cloud" backup: device-flow OAuth (drive.file scope), token refresh, resumable uploads, own serial queue (see "Google Drive backup") |
| `ui/` | real | Vanilla-JS local admin UI (no build step), camera grid + recent events |

## Object detection

Motion-triggered events are classified by a YOLOX-tiny ONNX model running in
a worker thread (onnxruntime-node, CPU execution provider, ORT default thread
settings). On motionStart (and once more 10s in, if the event is still open)
the pipeline fetches a full-color JPEG from go2rtc's `/api/frame.jpeg` — the
320x180 grayscale motion-analysis frames are too small/colorless for
detection — and the worker letterboxes it to 416x416 and runs one forward
pass. Detections with score ≥ 0.5 upgrade the event kind by priority
person > package > vehicle > animal > motion; all detections land in the
event's `metadata.detections`. Snapshot or inference failure is non-fatal:
the event simply stays kind `motion`.

**Model weights** (not committed — `models/*.onnx` is gitignored):

- Source: official Megvii YOLOX release —
  <https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx>
- License: **Apache-2.0**
  (<https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE>).
  Deliberately not Ultralytics YOLOv5/YOLOv8 — those weights are AGPL.
- Download: `pnpm --filter @nightjar/node fetch-model`
  (`scripts/fetch-model.mjs`; the Docker image runs it at build time). If the
  model file is missing at runtime the worker logs a clear hint and
  detections are disabled — everything else keeps working.

COCO → event-kind mapping: person → `person`; bicycle/car/motorcycle/bus/
truck → `vehicle`; bird/cat/dog/horse/sheep/cow/bear → `animal`;
backpack/handbag/suitcase → `package`. The `package` mapping via bag-like
COCO classes is an approximation — a dedicated package-detection model comes
later. Thresholds (conf 0.35, NMS IoU 0.45, pipeline min score 0.5) are
constants in `src/detect/inference-worker.ts` / `src/events/pipeline.ts`, not
NodeConfig.

## Google Drive backup

"Bring your own cloud": in addition to the Nightjar cloud upload, the node
can copy every event clip + thumbnail into **your own Google Drive**, under
`<folderName>/<camera name>/<YYYY-MM-DD>/<HHmmss>-<kind>.mp4` (+ `.jpg`).
Configure it from the local UI's "Your cloud backup" card.

How it works:

- **Auth is the OAuth 2.0 Device Flow** ("TV and Limited-Input Device"
  client): the node shows a short code, you enter it at
  <https://google.com/device> on any device, and the node polls Google for
  the grant. No browser, redirect URI or inbound port on the node.
- **Scope is `drive.file` only** — the node can see and manage *only files
  and folders it created itself*. It deliberately cannot read, list or touch
  anything else in your Drive.
- **Tokens never leave the node.** They live in
  `${CONFIG_DIR}/gdrive-token.json` (mode 0600, like `identity.json`) and are
  never logged. "Disconnect" revokes the grant at Google and deletes the
  file; clips already in your Drive stay there.
- Uploads run from their own serial queue (`gdrive_queue` in SQLite —
  survives restarts, exponential backoff 5s→5min, bounded to the newest
  500). Backup is **forward-only**: only events closed while backup is
  enabled and connected are uploaded; nothing is backfilled retroactively.
  Clip files are shared with the cloud upload queue and are deleted only
  once *both* queues are done with the event.

Config (`config.json`, all optional): `backup.gdrive.enabled` (default
false, toggled from the UI), `backup.gdrive.folderName` (default
`"Nightjar"`), `backup.gdrive.clientId` / `backup.gdrive.clientSecret`
(overrides for the env vars below).

**Supplying an OAuth client (self-hosters).** Google requires an OAuth
client to run the device flow; official builds ship credentials via env, and
without any the UI shows the feature as "not configured on this build". To
create your own:

1. In the [Google Cloud Console](https://console.cloud.google.com/), create
   (or pick) a project and enable the **Google Drive API**.
2. **APIs & Services → OAuth consent screen**: user type **External**, fill
   in the app name/email, add the scope
   `https://www.googleapis.com/auth/drive.file`, then **publish** the app
   (while in "Testing", refresh tokens expire after 7 days).
3. **APIs & Services → Credentials → Create credentials → OAuth client
   ID**, application type **"TVs and Limited Input devices"**.
4. Pass the resulting client ID/secret to the node:

```sh
NIGHTJAR_GOOGLE_CLIENT_ID=<client id> \
NIGHTJAR_GOOGLE_CLIENT_SECRET=<client secret> \
pnpm --filter @nightjar/node dev
```

(For device-flow clients the "secret" is not actually confidential — Google
issues it knowing it ships on devices — but treat it with care anyway.)

## Nest cameras (SDM bridge)

**Experimental.** Nest cameras don't speak RTSP, but Google's Smart Device
Management (SDM) API can hand their live stream to go2rtc's native `nest:`
source. Once added, a Nest camera is an ordinary Nightjar camera: recording,
motion detection, AI events, clips and live view all work unchanged — the
recorder and motion detector simply pull the stream back out of go2rtc's RTSP
restream (`:8554`) instead of talking to the camera directly.

Honest caveats up front:

- Works with 2021-and-newer Nest cams (WebRTC live stream) and some older
  models that expose an RTSP live stream through SDM. Battery cameras sleep
  and cannot stream continuously.
- The video still transits Google's servers — this is a bridge, not a local
  stream.
- Google charges a **one-time $5** Device Access registration fee.
- Everything is per-node config — no env vars, no Nightjar-supplied OAuth
  client. You bring your own Google Cloud project (Google requires the
  per-user Device Access registration anyway).

### One-time Google-side setup

1. In the [Google Cloud Console](https://console.cloud.google.com/), create
   (or pick) a project and enable the **Smart Device Management API**
   (`smartdevicemanagement.googleapis.com`).
2. **APIs & Services → OAuth consent screen**: user type **External**, fill in
   app name/email, then **publish** the app (in "Testing", refresh tokens
   expire after 7 days and your cameras would go offline weekly).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **"Web application"**, and add
   `https://www.google.com` as an **authorized redirect URI**. Note the client
   ID and secret. (The node has no public URL, so the flow "redirects" to
   google.com and you paste the resulting URL back — see below.)
4. Register for **Device Access** at
   <https://console.nest.google.com/device-access> ($5 one-time, same Google
   account that owns the cameras), create a Device Access **project** with
   your OAuth client ID from step 3, and copy the Device Access **project
   ID** (a UUID — not the GCP project id).

### Connecting the node

In the local UI's **"Nest cameras"** card:

1. Enter the Device Access project ID + OAuth client ID/secret (persisted to
   `config.json` under `nest.*`).
2. Click **Connect Google account** — the node builds a consent URL
   (scope `sdm.service`, `access_type=offline`, `prompt=consent`). Open it,
   sign in, approve. During consent Google shows the Nest permission screens;
   pick the cameras you want to allow.
3. You land on `https://www.google.com/?code=…`. Copy the **full URL** from
   the address bar and paste it into the card ("just the code" also works).
   The node exchanges it for tokens; the refresh token is stored in
   `${CONFIG_DIR}/nest-token.json` (mode 0600, like `gdrive-token.json`) and
   never leaves the node.
4. The card lists your cameras (SDM `devices.list`, filtered to devices with
   the `CameraLiveStream` trait). **If the list is empty**, you skipped the
   Partner Connections link flow: open
   `https://nestservices.google.com/partnerconnections/<projectId>`, tick your
   cameras, finish, then "Refresh devices". The UI links this for you.
5. **Add as camera** — creates a camera with `source: "nest"` and
   `nest.deviceId`. No ffprobe (the stream only exists once go2rtc pulls it);
   capabilities come from SDM traits (max resolution/codecs) when available.

The rendered `go2rtc.yaml` then contains lines like

```yaml
"cam_<id>": "nest:?client_id=…&client_secret=…&refresh_token=…&project_id=…&device_id=…"
```

which means the go2rtc config file now carries secrets — it is written with
mode 0600. Nest cameras have no substream; `cam_<id>_sub` points at the same
source. "Disconnect" revokes the grant at Google and deletes the token file;
nest cameras stay configured but are skipped in `go2rtc.yaml` (and logged)
until reconnected.

## Notes

- The claim code from `node-register` is persisted in `identity.json`, so an
  unclaimed node keeps showing a valid code across restarts. If the stored
  code has expired, the node re-registers with a fresh identity (the old
  unclaimed row is garbage-collected server-side) so the UI always shows a
  working code.
- Camera RTSP URLs (which may embed credentials) never leave the node — only
  the `CameraPublic` projection is synced to the cloud.
