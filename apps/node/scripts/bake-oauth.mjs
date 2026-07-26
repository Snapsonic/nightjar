#!/usr/bin/env node
// Bakes the fallback Google OAuth client into src/backup/default-oauth.ts at
// IMAGE BUILD time, from NIGHTJAR_GOOGLE_CLIENT_ID / _SECRET in the
// environment (the Dockerfile turns its build args into those env vars).
//
// Usage: pnpm --filter @nightjar/node bake-oauth
//
// With both variables empty this rewrites the file byte-identically, so a
// plain `docker build` with no build args produces exactly the repo's file
// (empty credentials -> the feature reports "not configured"). Real
// credentials are NEVER committed; only built images carry them.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "backup",
  "default-oauth.ts",
);

/** Only plain client-id/secret characters — nothing that could escape the literal. */
function check(name, value) {
  if (value !== "" && !/^[\w.\-~/+:]+$/.test(value)) {
    console.error(`bake-oauth: ${name} contains characters that are not allowed in a literal`);
    process.exit(1);
  }
  return value;
}

const clientId = check("NIGHTJAR_GOOGLE_CLIENT_ID", process.env.NIGHTJAR_GOOGLE_CLIENT_ID ?? "");
const clientSecret = check(
  "NIGHTJAR_GOOGLE_CLIENT_SECRET",
  process.env.NIGHTJAR_GOOGLE_CLIENT_SECRET ?? "",
);

const source = readFileSync(target, "utf8");
let replaced = 0;
const baked = source
  .replace(/(\n  clientId: )"[^"]*"/, (_m, lead) => (replaced++, `${lead}"${clientId}"`))
  .replace(/(\n  clientSecret: )"[^"]*"/, (_m, lead) => (replaced++, `${lead}"${clientSecret}"`));

if (replaced !== 2) {
  console.error("bake-oauth: could not find both literals in default-oauth.ts — aborting");
  process.exit(1);
}

writeFileSync(target, baked, "utf8");
console.log(
  clientId && clientSecret
    ? "bake-oauth: baked a default Google OAuth client into the image"
    : "bake-oauth: no default Google OAuth client supplied (Drive backup needs env/config)",
);
