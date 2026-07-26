# Nightjar node service.
# Build from the REPO ROOT:
#   docker build -f apps/node/Dockerfile -t ghcr.io/snapsonic/nightjar-node:latest .
#
# NOTE: this repo has no root .dockerignore yet (root files are owned by the
# orchestrator). When adding one, include at least:
#   node_modules
#   **/node_modules
#   .git
#   .turbo
#   **/.turbo
#   docker/data
#   apps/web
#   apps/marketing
#   supabase
# to keep the build context small — only pnpm-workspace.yaml, package.json,
# turbo.json, tsconfig.base.json, pnpm-lock.yaml, packages/ and apps/node/ are
# actually needed below.

FROM node:22-slim

# ffmpeg for probe/record/motion; python3/make/g++ so better-sqlite3 can
# compile its native addon when no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Workspace manifests + the packages this app depends on.
COPY pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/node ./apps/node

# Dev deps included on purpose: the app runs TS directly via tsx.
RUN pnpm install --filter @nightjar/node... --prod=false

# YOLOX-tiny ONNX weights (Apache-2.0, official Megvii release) — gitignored,
# so the image must fetch them at build time for the detect worker.
RUN pnpm --filter @nightjar/node fetch-model

# Optional: bake a default Google OAuth client (device flow, drive.file scope)
# into the image so hosted users can connect Drive from app.nightjar.ca with
# nothing to configure. Empty by default — the repo never carries credentials,
# and a build without these args leaves src/backup/default-oauth.ts untouched
# (the feature then reports "not configured" unless env/config supplies one).
ARG NIGHTJAR_GOOGLE_CLIENT_ID=""
ARG NIGHTJAR_GOOGLE_CLIENT_SECRET=""
RUN NIGHTJAR_GOOGLE_CLIENT_ID="$NIGHTJAR_GOOGLE_CLIENT_ID" \
    NIGHTJAR_GOOGLE_CLIENT_SECRET="$NIGHTJAR_GOOGLE_CLIENT_SECRET" \
    pnpm --filter @nightjar/node bake-oauth

ENV NODE_ENV=production
# Local UI/API (compose runs with network_mode: host).
EXPOSE 8080

CMD ["pnpm", "--filter", "@nightjar/node", "start"]
