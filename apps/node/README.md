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
| `src/cameras/manager.ts` | real | Camera CRUD + ffprobe capability probing |
| `src/go2rtc/supervisor.ts` | real | Renders `go2rtc.yaml`, pokes `/api/restart`, health/stream checks |
| `src/cloud/link.ts` | real | Register → claim poll → realtime channel; WHEP/snapshot/status handlers, heartbeat, camera sync |
| `src/api/server.ts` | real | Local REST API + WHEP proxy + static UI |
| `src/db.ts` | real | SQLite (segments / events mirror / upload_queue) |
| `src/recorder/recorder.ts` | real | Per-camera ffmpeg segment capture (60s fMP4), SQLite index, retention pruner, `exportRange()` |
| `src/motion/detector.ts` | real | 5 fps substream grayscale frame-diff vs rolling background; motionStart/motionEnd events |
| `src/detect/worker.ts` | scaffold | worker_thread pool-of-1 with transferable-frame messaging; ONNX (YOLOX) inference stubbed to `[]` |
| `src/events/pipeline.ts` | real | motion → event → clip + thumbnail → local row → serial upload queue (offline-safe, bounded) |
| `ui/` | real | Vanilla-JS local admin UI (no build step), camera grid + recent events |

## Notes

- The claim code from `node-register` is persisted in `identity.json`, so an
  unclaimed node keeps showing a valid code across restarts. If the stored
  code has expired, the node re-registers with a fresh identity (the old
  unclaimed row is garbage-collected server-side) so the UI always shows a
  working code.
- Camera RTSP URLs (which may embed credentials) never leave the node — only
  the `CameraPublic` projection is synced to the cloud.
