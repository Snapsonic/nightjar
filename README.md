# Nightjar

**Open-source NVR that watches through the night.** Your cameras, your disk, your rules — with an optional cloud for remote access, event clips, and AI alerts at [nightjar.ca](https://nightjar.ca).

Nightjar is a self-hosted alternative to Google Nest Aware and Blue Iris:

- **Your footage stays home.** 24/7 recording goes to your own disk. Only event clips you opt into ever reach the cloud.
- **Zero port forwarding.** The node keeps a single outbound connection; remote live view flows peer-to-peer over WebRTC.
- **AI on your hardware.** Person / vehicle / animal / package detection runs locally — no per-camera cloud inference fees.
- **Works with open cameras.** Anything that speaks RTSP/ONVIF (Reolink, Amcrest, Hikvision, Dahua, Ubiquiti, …). A Nest camera bridge (Google Smart Device Management API) is on the roadmap.

**Documentation: [night-jar.mintlify.app](https://night-jar.mintlify.app)** — including a step-by-step [Nest → Nightjar migration guide](https://night-jar.mintlify.app/guides/nest-migration).

## Quick start (self-hosted node)

```bash
mkdir nightjar && cd nightjar
curl -fsSLO https://raw.githubusercontent.com/Snapsonic/nightjar/main/docker/docker-compose.yml
mkdir -p data/{config,db,recordings,go2rtc}
docker compose up -d
```

Open `http://<host>:8080`, add a camera by RTSP URL, and you have live view + recording on your LAN. To add remote access and cloud event history, create a free account at [app.nightjar.ca](https://app.nightjar.ca) and enter the pairing code shown in the local UI.

> WebRTC needs `network_mode: host` — use a Linux host (a NUC, a NAS, a Pi 5) for full functionality. Docker Desktop on macOS/Windows will run but remote live view will be degraded.

## Architecture

```
┌─ your network ──────────────────────────┐      ┌─ cloud (optional) ─────────────┐
│  RTSP cams ─► go2rtc ─► WebRTC live     │      │  app.nightjar.ca (Next.js)     │
│                 │                        │      │  Supabase: auth · Postgres ·   │
│  ffmpeg ──► fMP4 segments on your disk  │◄────►│  Realtime (signaling/commands) │
│  motion ─► onnx detect ─► event clips ──┼─────►│  Storage (event clips only)    │
│  nightjar-node (TypeScript)             │      │                                │
└─────────────────────────────────────────┘      └────────────────────────────────┘
```

- `apps/node` — the self-hosted NVR service (config, go2rtc supervision, recording, detection, cloud link, local UI)
- `apps/web` — the cloud dashboard at app.nightjar.ca
- `apps/marketing` — nightjar.ca
- `packages/shared` — zod schemas & the realtime signaling protocol (the contract between everything)
- `packages/db` — generated Supabase types + typed clients
- `supabase/` — migrations & edge functions (pairing, tokens, TURN credentials, signed uploads)

## Development

```bash
pnpm install
pnpm dev          # all apps
pnpm turbo run lint typecheck build
```

The node runs locally with `pnpm --filter @nightjar/node dev` (requires go2rtc and ffmpeg on PATH, or use `docker/compose.dev.yml`).

## Pricing (cloud, optional)

Self-hosting is free forever, including remote live view. Paid plans fund development and add cloud event history: Plus ($4.99/mo) and Pro ($9.99/mo) — see [nightjar.ca](https://nightjar.ca/#pricing).

## License

[AGPL-3.0](./LICENSE). © Snapsonic. The Nightjar cloud service is operated by Snapsonic; you're free to self-host everything in this repo.
