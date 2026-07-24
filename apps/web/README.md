# @nightjar/web

The Nightjar cloud dashboard (app.nightjar.ca): live view, event clips, node pairing and
settings for your self-hosted Nightjar nodes. See the [root README](../../README.md) for the
full project overview and node setup.

## Setup

```sh
# from the repo root
pnpm install

# configure Supabase
cp apps/web/.env.example apps/web/.env.local
# fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY

# run
pnpm --filter @nightjar/web dev
```

The app expects the Supabase project to have the schema from
`supabase/migrations/0001_core.sql` applied and the `node-claim` and
`turn-credentials` edge functions deployed (`supabase functions deploy`).

## Scripts

| Script      | What it does            |
| ----------- | ----------------------- |
| `dev`       | Next.js dev server      |
| `build`     | Production build        |
| `start`     | Serve the built app     |
| `typecheck` | `tsc --noEmit` (strict) |

## How it talks to nodes

- **Data** (sites, nodes, cameras, events) is read straight from Postgres through
  Supabase with RLS scoping everything to the signed-in owner.
- **Signaling** (snapshots, WebRTC live view) goes over the private Supabase
  Realtime channel `node:{nodeId}` using the request/reply helper in
  `lib/realtime.ts`.
- **Clips & thumbnails** live in the private `event-clips` storage bucket and are
  rendered via short-lived signed URLs.
