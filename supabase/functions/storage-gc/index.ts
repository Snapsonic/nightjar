// Cloud storage garbage collection (roadmap #24, paired with #25's plan-gated
// retention in migration 0014_storage_gc).
//
// Called service-to-service by the `nightjar-storage-gc` pg_cron job via
// pg_net, authenticated with the x-nightjar-hook shared secret — NOT by
// browsers. Deployed with verify_jwt = false (config.toml) because pg_net
// sends no Authorization header. Same shape as the notify hook.
//
// Postgres cannot delete a storage object, so this function is the only place
// bytes actually go away. One invocation makes one bounded pass over five
// categories, newest problem first:
//
//   1. expiredClips        event_clips rows past expires_at (the DB owns that
//                          date now — see 0014). Removes clip.mp4 + thumb.jpg,
//                          deletes the event_clips row, and flips the event to
//                          clip_status='expired', thumbnail_path=null.
//   2. orphans             objects under event-clips/{node}/{event}/ whose
//                          event row is gone. `on delete cascade` cleans up
//                          Postgres when a node or event is deleted; nothing
//                          has ever cleaned up the bytes.
//   3. timelineExports     the whole timeline-exports bucket is a cache;
//                          anything older than 24h goes. The node does this
//                          too (cloud/timeline.ts cleanupTimelineExports) but
//                          only while it is online, so exports from a node
//                          that went away are immortal without this.
//   4. snapshots           ad-hoc snapshots/{node}/snap-*.jpg older than 1h —
//                          they exist to back a 5-minute signed URL.
//   5. previews            snapshots/{node}/previews/* older than 7 days.
//
// SAFETY RAILS
//   * DRY RUN BY DEFAULT. STORAGE_GC_DRY_RUN is treated as true unless it is
//     explicitly "false"/"0"/"no", and ?dry_run=1 / ?dry_run=0 overrides per
//     request. A dry run enumerates exactly the same set and reports it
//     without touching anything.
//   * Batch cap (MAX_OBJECTS_PER_RUN) so one invocation can never run long
//     enough to time out. Whatever is over budget is reported as `pending`
//     and picked up on the next hourly run.
//   * Nothing throws on a single object. Failures accumulate into
//     summary.errors and the run keeps going.
//   * Unrecognised path shapes are SKIPPED, never deleted. If a future
//     feature writes a new layout into these buckets, GC ignores it until
//     someone teaches it the shape.
import { adminClient, json } from "../_shared/util.ts";

/* ---------- tunables ---------- */

/** Objects removed per invocation. 500 * ~1.1 MB is a comfortable pass. */
export const MAX_OBJECTS_PER_RUN = 500;
/** Enumeration ceiling per category — bounds work even when nothing is deletable. */
export const MAX_ENUMERATE_PER_CATEGORY = 5_000;
/** Paths per storage remove() call. */
export const REMOVE_CHUNK = 100;
/** Ids per PostgREST `in.(...)` filter. */
export const ID_CHUNK = 200;
/** Rows per storage list() page. */
export const LIST_PAGE = 1_000;

export const SNAPSHOT_MAX_AGE_MS = 3_600_000; // 1 hour
export const PREVIEW_MAX_AGE_MS = 7 * 86_400_000; // 7 days
export const TIMELINE_EXPORT_MAX_AGE_MS = 24 * 3_600_000; // 24 hours

export const CLIP_BUCKET = "event-clips";
export const SNAPSHOT_BUCKET = "snapshots";
export const TIMELINE_BUCKET = "timeline-exports";

/** Mirrors public.clip_retention_days() in migration 0014 — the DB is the
 *  authority, this is only here so the function can explain itself in logs
 *  and so the mapping is covered by a test on this side too. */
export const RETENTION_DAYS_BY_PLAN: Record<string, number> = {
  free: 3,
  plus: 30,
  pro: 60,
};

export function retentionDaysForPlan(plan: string | null | undefined): number {
  if (plan === null || plan === undefined) return RETENTION_DAYS_BY_PLAN.free;
  return RETENTION_DAYS_BY_PLAN[plan] ?? RETENTION_DAYS_BY_PLAN.free;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------- pure helpers (unit-tested in isolation) ---------- */

/** True when `createdAt` is parseable and strictly older than `maxAgeMs`.
 *  An absent or unparseable timestamp is never old enough to delete. */
export function isOlderThan(
  createdAt: string | null | undefined,
  maxAgeMs: number,
  nowMs: number,
): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  return nowMs - created > maxAgeMs;
}

/**
 * Which rule applies to an object in the snapshots bucket, given its path
 * relative to the bucket root. Anything that is not a recognised Nightjar
 * shape returns "skip" — GC never guesses.
 *
 *   {nodeId}/snap-{cameraId}-{ms}.jpg      -> "adhoc"    (1 hour)
 *   {nodeId}/previews/{cameraId}-{ms}.jpg  -> "preview"  (7 days)
 */
export function classifySnapshotPath(path: string): "adhoc" | "preview" | "skip" {
  const parts = path.split("/");
  if (parts.length === 2 && UUID_RE.test(parts[0]) && /^snap-.*\.jpg$/i.test(parts[1])) {
    return "adhoc";
  }
  if (parts.length === 3 && UUID_RE.test(parts[0]) && parts[1] === "previews") return "preview";
  return "skip";
}

/** Directory of an event-clips object path: "{node}/{event}". */
export function clipDirOf(storagePath: string): string {
  const parts = storagePath.split("/");
  return parts.slice(0, Math.max(0, parts.length - 1)).join("/");
}

/** The two objects an uploaded clip owns, derived from event_clips.storage_path. */
export function clipObjectPaths(storagePath: string): string[] {
  const dir = clipDirOf(storagePath);
  if (dir === "") return [storagePath];
  return [`${dir}/clip.mp4`, `${dir}/thumb.jpg`];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ---------- injectable surfaces (mockable in tests) ---------- */

export interface GcObject {
  /** Path relative to the bucket root. */
  path: string;
  createdAt: string | null;
  bytes: number;
}

export interface GcEntry {
  name: string;
  /** null for a folder placeholder. */
  createdAt: string | null;
  bytes: number;
  isFolder: boolean;
}

export interface GcStorage {
  /** Immediate children of `prefix` ("" = bucket root), fully paginated. */
  list(bucket: string, prefix: string): Promise<GcEntry[]>;
  /** Removes objects. Missing paths are not an error. */
  remove(bucket: string, paths: string[]): Promise<void>;
}

export interface ExpiredClipRow {
  eventId: string;
  storagePath: string;
  bytes: number | null;
}

export interface GcDb {
  /** event_clips rows with expires_at < now, oldest first, capped. */
  expiredClips(nowIso: string, limit: number): Promise<ExpiredClipRow[]>;
  /** Subset of `eventIds` that still have an events row. */
  existingEventIds(eventIds: string[]): Promise<Set<string>>;
  deleteClipRows(eventIds: string[]): Promise<void>;
  markEventsExpired(eventIds: string[]): Promise<void>;
}

export interface GcSummary {
  dryRun: boolean;
  deletedClips: number;
  deletedOrphans: number;
  deletedSnapshots: number;
  deletedPreviews: number;
  deletedTimelineExports: number;
  freedBytes: number;
  /** Enumerated but over the per-run budget — next run picks them up. */
  pending: {
    clips: number;
    orphans: number;
    snapshots: number;
    previews: number;
    timelineExports: number;
    bytes: number;
  };
  /** Objects whose path shape GC does not recognise; never deleted. */
  skippedUnknownPaths: number;
  errors: string[];
  errorCount: number;
  elapsedMs: number;
}

export interface RunOptions {
  storage: GcStorage;
  db: GcDb;
  dryRun: boolean;
  now?: Date;
  maxObjects?: number;
  log?: (message: string) => void;
}

/* ---------- the pass ---------- */

/** Bounded error list — a broken bucket must not produce a megabyte of JSON. */
const MAX_REPORTED_ERRORS = 20;

class Budget {
  private used = 0;
  constructor(readonly max: number) {}
  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
  get exhausted(): boolean {
    return this.remaining === 0;
  }
  spend(n: number): void {
    this.used += n;
  }
}

export async function runStorageGc(opts: RunOptions): Promise<GcSummary> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const log = opts.log ?? ((m: string) => console.log(m));
  const budget = new Budget(opts.maxObjects ?? MAX_OBJECTS_PER_RUN);

  const summary: GcSummary = {
    dryRun: opts.dryRun,
    deletedClips: 0,
    deletedOrphans: 0,
    deletedSnapshots: 0,
    deletedPreviews: 0,
    deletedTimelineExports: 0,
    freedBytes: 0,
    pending: { clips: 0, orphans: 0, snapshots: 0, previews: 0, timelineExports: 0, bytes: 0 },
    skippedUnknownPaths: 0,
    errors: [],
    errorCount: 0,
    elapsedMs: 0,
  };

  const fail = (context: string, err: unknown): void => {
    summary.errorCount += 1;
    const message = `${context}: ${err instanceof Error ? err.message : String(err)}`;
    if (summary.errors.length < MAX_REPORTED_ERRORS) summary.errors.push(message);
    console.error(`storage-gc ${message}`);
  };

  /** Removes a batch of paths unless this is a dry run. Never throws. */
  const removeObjects = async (bucket: string, paths: string[]): Promise<boolean> => {
    if (opts.dryRun || paths.length === 0) return true;
    try {
      await opts.storage.remove(bucket, paths);
      return true;
    } catch (err) {
      fail(`remove ${bucket} (${paths.length} paths)`, err);
      return false;
    }
  };

  /* ---- 1. expired clips ---- */

  try {
    const expired = await opts.db.expiredClips(now.toISOString(), MAX_ENUMERATE_PER_CATEGORY);
    // Each clip owns two objects (clip.mp4 + thumb.jpg), so the object budget
    // buys half as many clips.
    const affordable = Math.floor(budget.remaining / 2);
    const take = expired.slice(0, affordable);
    const over = expired.slice(affordable);
    summary.pending.clips = over.length;
    summary.pending.bytes += over.reduce((sum, c) => sum + (c.bytes ?? 0), 0);

    const settled: ExpiredClipRow[] = [];
    for (const group of chunk(take, Math.floor(REMOVE_CHUNK / 2))) {
      const paths = group.flatMap((c) => clipObjectPaths(c.storagePath));
      if (await removeObjects(CLIP_BUCKET, paths)) {
        settled.push(...group);
        continue;
      }
      // Isolate: one poisoned object must not hold its whole chunk hostage.
      for (const clip of group) {
        if (await removeObjects(CLIP_BUCKET, clipObjectPaths(clip.storagePath))) {
          settled.push(clip);
        }
        // Otherwise leave the row alone — next run retries it. Deleting the
        // row while the bytes survive would strand them: the event still
        // exists, so the orphan sweep would never see them.
      }
    }

    if (settled.length > 0) {
      const eventIds = settled.map((c) => c.eventId);
      if (!opts.dryRun) {
        for (const ids of chunk(eventIds, ID_CHUNK)) {
          try {
            await opts.db.deleteClipRows(ids);
          } catch (err) {
            fail(`delete event_clips rows (${ids.length})`, err);
          }
          try {
            await opts.db.markEventsExpired(ids);
          } catch (err) {
            fail(`mark events expired (${ids.length})`, err);
          }
        }
      }
      summary.deletedClips = settled.length;
      // event_clips.bytes only covers the mp4; the thumbnail is unaccounted
      // for here and shows up as a small under-count in freedBytes.
      summary.freedBytes += settled.reduce((sum, c) => sum + (c.bytes ?? 0), 0);
      budget.spend(settled.length * 2);
    }
    log(`expired clips: ${summary.deletedClips} handled, ${over.length} over budget`);
  } catch (err) {
    fail("expired clip sweep", err);
  }

  /* ---- 2. orphaned event-clips objects ---- */

  try {
    const orphans = await collectOrphanClipObjects(opts.storage, opts.db, summary, fail);
    const take = orphans.slice(0, budget.remaining);
    const over = orphans.slice(budget.remaining);
    summary.pending.orphans = over.length;
    summary.pending.bytes += over.reduce((sum, o) => sum + o.bytes, 0);

    let removed = 0;
    for (const group of chunk(take, REMOVE_CHUNK)) {
      if (await removeObjects(CLIP_BUCKET, group.map((o) => o.path))) {
        removed += group.length;
        summary.freedBytes += group.reduce((sum, o) => sum + o.bytes, 0);
      }
    }
    summary.deletedOrphans = removed;
    budget.spend(removed);
    log(`orphans: ${removed} handled, ${over.length} over budget`);
  } catch (err) {
    fail("orphan sweep", err);
  }

  /* ---- 3. timeline exports older than 24h ---- */

  try {
    const stale = await collectAgedObjects(
      opts.storage,
      TIMELINE_BUCKET,
      2,
      () => TIMELINE_EXPORT_MAX_AGE_MS,
      nowMs,
      summary,
      fail,
    );
    const { removed, over, bytes } = await removeWithBudget(
      TIMELINE_BUCKET,
      stale,
      budget,
      removeObjects,
    );
    summary.deletedTimelineExports = removed;
    summary.freedBytes += bytes;
    summary.pending.timelineExports = over.length;
    summary.pending.bytes += over.reduce((sum, o) => sum + o.bytes, 0);
    budget.spend(removed);
    log(`timeline exports: ${removed} handled, ${over.length} over budget`);
  } catch (err) {
    fail("timeline export sweep", err);
  }

  /* ---- 4 + 5. snapshots (1h) and previews (7d) ---- */

  try {
    const aged = await collectAgedObjects(
      opts.storage,
      SNAPSHOT_BUCKET,
      3,
      (path) => {
        const kind = classifySnapshotPath(path);
        if (kind === "adhoc") return SNAPSHOT_MAX_AGE_MS;
        if (kind === "preview") return PREVIEW_MAX_AGE_MS;
        return null; // unknown shape — leave it alone
      },
      nowMs,
      summary,
      fail,
    );
    const adhoc = aged.filter((o) => classifySnapshotPath(o.path) === "adhoc");
    const previews = aged.filter((o) => classifySnapshotPath(o.path) === "preview");

    const snapResult = await removeWithBudget(SNAPSHOT_BUCKET, adhoc, budget, removeObjects);
    summary.deletedSnapshots = snapResult.removed;
    summary.freedBytes += snapResult.bytes;
    summary.pending.snapshots = snapResult.over.length;
    summary.pending.bytes += snapResult.over.reduce((sum, o) => sum + o.bytes, 0);
    budget.spend(snapResult.removed);

    const previewResult = await removeWithBudget(SNAPSHOT_BUCKET, previews, budget, removeObjects);
    summary.deletedPreviews = previewResult.removed;
    summary.freedBytes += previewResult.bytes;
    summary.pending.previews = previewResult.over.length;
    summary.pending.bytes += previewResult.over.reduce((sum, o) => sum + o.bytes, 0);
    budget.spend(previewResult.removed);

    log(`snapshots: ${snapResult.removed}, previews: ${previewResult.removed}`);
  } catch (err) {
    fail("snapshot sweep", err);
  }

  summary.elapsedMs = Date.now() - startedAt;
  return summary;
}

/** Takes as much of `objects` as the budget allows and removes it in chunks. */
async function removeWithBudget(
  bucket: string,
  objects: GcObject[],
  budget: Budget,
  removeObjects: (bucket: string, paths: string[]) => Promise<boolean>,
): Promise<{ removed: number; over: GcObject[]; bytes: number }> {
  const take = objects.slice(0, budget.remaining);
  const over = objects.slice(budget.remaining);
  let removed = 0;
  let bytes = 0;
  for (const group of chunk(take, REMOVE_CHUNK)) {
    if (await removeObjects(bucket, group.map((o) => o.path))) {
      removed += group.length;
      bytes += group.reduce((sum, o) => sum + o.bytes, 0);
    }
  }
  return { removed, over, bytes };
}

/**
 * Objects under event-clips/{node}/{event}/ whose event row no longer exists.
 *
 * Walks two folder levels to collect candidate event ids, asks PostgREST
 * which of them still exist (chunked `in.(...)`), and only then lists the
 * files inside the ones that are gone — so a healthy bucket costs one list
 * per node plus a couple of id lookups, not one list per event.
 *
 * Folder names that are not UUIDs are counted as skipped and never deleted.
 */
async function collectOrphanClipObjects(
  storage: GcStorage,
  db: GcDb,
  summary: GcSummary,
  fail: (context: string, err: unknown) => void,
): Promise<GcObject[]> {
  const nodeFolders = (await storage.list(CLIP_BUCKET, "")).filter((e) => e.isFolder);
  const candidates: { nodeId: string; eventId: string }[] = [];

  for (const node of nodeFolders) {
    if (!UUID_RE.test(node.name)) {
      summary.skippedUnknownPaths += 1;
      continue;
    }
    let children: GcEntry[];
    try {
      children = await storage.list(CLIP_BUCKET, node.name);
    } catch (err) {
      fail(`list ${CLIP_BUCKET}/${node.name}`, err);
      continue;
    }
    for (const child of children) {
      if (!child.isFolder || !UUID_RE.test(child.name)) {
        summary.skippedUnknownPaths += 1;
        continue;
      }
      candidates.push({ nodeId: node.name, eventId: child.name });
      if (candidates.length >= MAX_ENUMERATE_PER_CATEGORY) break;
    }
    if (candidates.length >= MAX_ENUMERATE_PER_CATEGORY) break;
  }

  const live = new Set<string>();
  for (const ids of chunk([...new Set(candidates.map((c) => c.eventId))], ID_CHUNK)) {
    try {
      for (const id of await db.existingEventIds(ids)) live.add(id);
    } catch (err) {
      // A failed existence probe must NEVER be read as "these events are
      // gone" — treat the whole chunk as live and try again next hour.
      fail(`event existence probe (${ids.length})`, err);
      for (const id of ids) live.add(id);
    }
  }

  const orphans: GcObject[] = [];
  for (const candidate of candidates) {
    if (live.has(candidate.eventId)) continue;
    const prefix = `${candidate.nodeId}/${candidate.eventId}`;
    try {
      for (const file of await storage.list(CLIP_BUCKET, prefix)) {
        if (file.isFolder) continue;
        orphans.push({
          path: `${prefix}/${file.name}`,
          createdAt: file.createdAt,
          bytes: file.bytes,
        });
      }
    } catch (err) {
      fail(`list ${CLIP_BUCKET}/${prefix}`, err);
    }
  }
  return orphans;
}

/**
 * Files up to `maxDepth` levels deep in a bucket that are older than the age
 * `maxAgeFor` gives for their path. Returning null from `maxAgeFor` skips the
 * object (counted, never deleted).
 */
async function collectAgedObjects(
  storage: GcStorage,
  bucket: string,
  maxDepth: number,
  maxAgeFor: (path: string) => number | null,
  nowMs: number,
  summary: GcSummary,
  fail: (context: string, err: unknown) => void,
): Promise<GcObject[]> {
  const out: GcObject[] = [];

  const walk = async (prefix: string, depth: number): Promise<void> => {
    if (out.length >= MAX_ENUMERATE_PER_CATEGORY) return;
    let entries: GcEntry[];
    try {
      entries = await storage.list(bucket, prefix);
    } catch (err) {
      fail(`list ${bucket}/${prefix}`, err);
      return;
    }
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isFolder) {
        if (depth < maxDepth) await walk(path, depth + 1);
        continue;
      }
      const maxAge = maxAgeFor(path);
      if (maxAge === null) {
        summary.skippedUnknownPaths += 1;
        continue;
      }
      if (!isOlderThan(entry.createdAt, maxAge, nowMs)) continue;
      out.push({ path, createdAt: entry.createdAt, bytes: entry.bytes });
      if (out.length >= MAX_ENUMERATE_PER_CATEGORY) return;
    }
  };

  await walk("", 0);
  return out;
}

/* ---------- Supabase-backed implementations ---------- */

type Admin = ReturnType<typeof adminClient>;

export function supabaseStorage(admin: Admin): GcStorage {
  return {
    async list(bucket, prefix) {
      const out: GcEntry[] = [];
      for (let offset = 0; ; offset += LIST_PAGE) {
        const { data, error } = await admin.storage
          .from(bucket)
          .list(prefix, { limit: LIST_PAGE, offset });
        if (error) throw new Error(error.message);
        const page = data ?? [];
        for (const entry of page) {
          // Storage marks folders with a null id and null metadata (the
          // generated FileObject type declares id as non-null; it isn't).
          const isFolder = (entry as { id: string | null }).id === null;
          const size = (entry.metadata as { size?: unknown } | null)?.size;
          out.push({
            name: entry.name,
            createdAt: entry.created_at ?? null,
            bytes: typeof size === "number" ? size : 0,
            isFolder,
          });
        }
        if (page.length < LIST_PAGE) break;
      }
      return out;
    },
    async remove(bucket, paths) {
      const { error } = await admin.storage.from(bucket).remove(paths);
      if (error) throw new Error(error.message);
    },
  };
}

export function supabaseDb(admin: Admin): GcDb {
  return {
    async expiredClips(nowIso, limit) {
      const { data, error } = await admin
        .from("event_clips")
        .select("event_id, storage_path, bytes")
        .lt("expires_at", nowIso)
        .order("expires_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => ({
        eventId: row.event_id as string,
        storagePath: row.storage_path as string,
        bytes: (row.bytes as number | null) ?? null,
      }));
    },
    async existingEventIds(eventIds) {
      const { data, error } = await admin.from("events").select("id").in("id", eventIds);
      if (error) throw new Error(error.message);
      return new Set((data ?? []).map((row) => row.id as string));
    },
    async deleteClipRows(eventIds) {
      const { error } = await admin.from("event_clips").delete().in("event_id", eventIds);
      if (error) throw new Error(error.message);
    },
    async markEventsExpired(eventIds) {
      const { error } = await admin
        .from("events")
        .update({ clip_status: "expired", thumbnail_path: null })
        .in("id", eventIds);
      if (error) throw new Error(error.message);
    },
  };
}

/* ---------- handler ---------- */

/**
 * Dry run unless explicitly turned off. `?dry_run=` on the request wins over
 * the STORAGE_GC_DRY_RUN env default, so the orchestrator can validate
 * against production before arming it — and can force a dry run again later
 * without redeploying.
 */
export function resolveDryRun(url: URL, env: string | undefined): boolean {
  const param = url.searchParams.get("dry_run");
  if (param !== null) return !isFalsey(param);
  if (env === undefined) return true; // unset = safe
  return !isFalsey(env);
}

function isFalsey(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "false" || v === "0" || v === "no" || v === "off";
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Service-to-service auth: shared hook secret only. No Authorization header
  // expected (pg_net does not send one) — verify_jwt is off for this function.
  const hookSecret = Deno.env.get("STORAGE_GC_HOOK_SECRET");
  if (!hookSecret || req.headers.get("x-nightjar-hook") !== hookSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const dryRun = resolveDryRun(new URL(req.url), Deno.env.get("STORAGE_GC_DRY_RUN"));
  const admin = adminClient();

  try {
    const summary = await runStorageGc({
      storage: supabaseStorage(admin),
      db: supabaseDb(admin),
      dryRun,
      log: (m) => console.log(`storage-gc ${m}`),
    });
    console.log(`storage-gc summary ${JSON.stringify(summary)}`);
    return json(summary);
  } catch (err) {
    // runStorageGc swallows per-category failures; this only catches something
    // truly unexpected (e.g. a bad service-role key).
    console.error("storage-gc run failed:", err);
    return json({ error: err instanceof Error ? err.message : String(err), dryRun }, 500);
  }
}

Deno.serve(handleRequest);
