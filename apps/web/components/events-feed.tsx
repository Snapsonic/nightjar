"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { EventKind, Zone } from "@nightjar/shared";
import type { Database } from "@nightjar/db";
import { KindIcon } from "@/components/icons";
import { EventDetailModal } from "@/components/event-detail-modal";
import { getBrowserClient } from "@/lib/supabase/client";
import { formatScore, relativeTime, toEventKind } from "@/lib/utils";

export type EventRow = Database["public"]["Tables"]["events"]["Row"];

const PAGE_SIZE = 50;
const SIGNED_URL_TTL_SEC = 3600;

const KIND_LABELS: Record<EventKind, string> = {
  motion: "Motion",
  person: "Person",
  vehicle: "Vehicle",
  animal: "Animal",
  package: "Package",
};

interface CameraRef {
  id: string;
  name: string;
  /** zones jsonb synced from the node — used to resolve metadata.zoneIds. */
  zones?: unknown;
}

/** metadata.zoneIds written by the node's event pipeline. */
const ZoneIdsMeta = z.object({ zoneIds: z.array(z.string()) });

function eventZoneNames(
  metadata: unknown,
  zoneNames: Map<string, string> | undefined,
): string[] {
  const parsed = ZoneIdsMeta.safeParse(metadata);
  if (!parsed.success) return [];
  // Resolve ids against the camera's current zones; fall back to the id so a
  // renamed/deleted zone still shows something.
  return parsed.data.zoneIds.map((id) => zoneNames?.get(id) ?? id);
}

export function EventsFeed({ cameras }: { cameras: CameraRef[] }) {
  const [kind, setKind] = useState<EventKind | null>(null);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<EventRow | null>(null);

  const cameraNames = new Map(cameras.map((c) => [c.id, c.name]));
  const cameraZoneNames = new Map<string, Map<string, string>>();
  for (const camera of cameras) {
    const parsed = z.array(Zone).safeParse(camera.zones ?? []);
    if (parsed.success && parsed.data.length > 0) {
      cameraZoneNames.set(camera.id, new Map(parsed.data.map((zone) => [zone.id, zone.name])));
    }
  }

  const signThumbnails = useCallback(async (rows: EventRow[]) => {
    const paths = rows
      .filter((row) => row.clip_status === "uploaded" && row.thumbnail_path)
      .map((row) => row.thumbnail_path)
      .filter((path): path is string => path !== null);
    if (paths.length === 0) return;

    const supabase = getBrowserClient();
    const { data, error: signError } = await supabase.storage
      .from("event-clips")
      .createSignedUrls(paths, SIGNED_URL_TTL_SEC);
    if (signError || !data) return; // thumbnails are decorative — fail quietly

    const next: Record<string, string> = {};
    for (const item of data) {
      if (!item.error && item.path && item.signedUrl) next[item.path] = item.signedUrl;
    }
    setThumbs((prev) => ({ ...prev, ...next }));
  }, []);

  const load = useCallback(
    async (offset: number) => {
      const supabase = getBrowserClient();
      let query = supabase
        .from("events")
        .select("*")
        .order("started_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (kind) query = query.eq("kind", kind);
      if (cameraId) query = query.eq("camera_id", cameraId);

      const { data, error: queryError } = await query;
      if (queryError) {
        setError(queryError.message);
        return;
      }
      const rows = data ?? [];
      setError(null);
      setHasMore(rows.length === PAGE_SIZE);
      setEvents((prev) => (offset === 0 ? rows : [...prev, ...rows]));
      void signThumbnails(rows);
    },
    [kind, cameraId, signThumbnails],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEvents([]);
    void load(0).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const loadMore = () => {
    setLoadingMore(true);
    void load(events.length).finally(() => setLoadingMore(false));
  };

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
      active
        ? "border-ember-500/60 bg-ember-500/15 text-ember-300"
        : "border-night-500 text-fog-400 hover:border-fog-500 hover:text-fog-200"
    }`;

  return (
    <div>
      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setKind(null)} className={chip(kind === null)}>
          All kinds
        </button>
        {EventKind.options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setKind(kind === option ? null : option)}
            className={chip(kind === option)}
          >
            {KIND_LABELS[option]}
          </button>
        ))}
      </div>
      {cameras.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setCameraId(null)}
            className={chip(cameraId === null)}
          >
            All cameras
          </button>
          {cameras.map((camera) => (
            <button
              key={camera.id}
              type="button"
              onClick={() => setCameraId(cameraId === camera.id ? null : camera.id)}
              className={chip(cameraId === camera.id)}
            >
              {camera.name}
            </button>
          ))}
        </div>
      )}

      {/* Feed */}
      <div className="mt-5">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-[74px] animate-pulse rounded-xl bg-night-800" />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            Could not load events: {error}
          </div>
        ) : events.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-night-500 px-6 py-14 text-center">
            <p className="text-sm font-medium text-fog-300">No events yet</p>
            <p className="mt-1 text-xs text-fog-500">
              {kind || cameraId
                ? "Nothing matches these filters."
                : "When your cameras detect motion, people, vehicles, animals or packages, events show up here."}
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {events.map((event) => {
              const thumbUrl =
                event.clip_status === "uploaded" && event.thumbnail_path
                  ? thumbs[event.thumbnail_path]
                  : undefined;
              const zoneNames = eventZoneNames(
                event.metadata,
                cameraZoneNames.get(event.camera_id),
              );
              return (
                <li key={event.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(event)}
                    className="flex w-full items-center gap-4 rounded-xl border border-night-600 bg-night-800 px-3 py-2.5 text-left transition-colors hover:border-night-500 hover:bg-night-700"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-night-700 text-ember-400">
                      <KindIcon kind={toEventKind(event.kind)} className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fog-100">
                        {KIND_LABELS[toEventKind(event.kind)]}
                        <span className="text-fog-500"> · </span>
                        <span className="text-fog-300">
                          {cameraNames.get(event.camera_id) ?? "Unknown camera"}
                        </span>
                        {zoneNames.map((name) => (
                          <span
                            key={name}
                            className="ml-1.5 inline-block rounded-full border border-night-500 bg-night-700/60 px-2 py-px align-middle text-[10px] font-medium text-fog-300"
                          >
                            {name}
                          </span>
                        ))}
                      </span>
                      <span className="mt-0.5 block text-xs text-fog-500">
                        {relativeTime(event.started_at)} · confidence {formatScore(event.score)}
                        {event.clip_status !== "uploaded" && (
                          <span className="text-fog-500"> · clip {event.clip_status}</span>
                        )}
                      </span>
                    </span>
                    <span className="hidden h-[54px] w-24 shrink-0 overflow-hidden rounded-lg bg-night-900 sm:block">
                      {thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumbUrl}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-[10px] text-night-500">
                          no thumb
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {!loading && !error && hasMore && (
          <div className="mt-5 text-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="rounded-lg border border-night-500 px-4 py-2 text-sm font-medium text-fog-200 transition-colors hover:border-ember-500/50 disabled:opacity-60"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {selected && (
        <EventDetailModal
          event={selected}
          cameraName={cameraNames.get(selected.camera_id) ?? "Unknown camera"}
          thumbUrl={
            selected.clip_status === "uploaded" && selected.thumbnail_path
              ? thumbs[selected.thumbnail_path]
              : undefined
          }
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
