"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CameraIcon, HistoryIcon, LiveIcon } from "@/components/icons";
import { NodeChannel, NodeChannelError } from "@/lib/realtime";
import { getBrowserClient } from "@/lib/supabase/client";

export interface CameraItem {
  id: string;
  name: string;
  enabled: boolean;
  capLabel: string | null;
}

type SnapshotState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string };

/**
 * Grid of camera cards for one node. Shares a single realtime channel to
 * request a fresh snapshot per camera (30s timeout — cold streams start slow).
 */
export function NodeCameras({
  nodeId,
  online,
  cameras,
}: {
  nodeId: string;
  online: boolean;
  cameras: CameraItem[];
}) {
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotState>>({});
  const [nonce, setNonce] = useState(0);
  const channelRef = useRef<NodeChannel | null>(null);
  /** cameraId -> URL we already auto-refreshed once (signed URLs expire after
   *  ~5 minutes; a broken <img> triggers one transparent re-request). */
  const autoRefreshedRef = useRef(new Map<string, string>());
  const camerasRef = useRef(cameras);
  camerasRef.current = cameras;

  const camerasKey = cameras.map((c) => c.id).join(",");

  useEffect(() => {
    if (!online) return;
    const wanted = camerasRef.current.filter((c) => c.enabled);
    if (wanted.length === 0) return;

    let cancelled = false;

    const setOne = (cameraId: string, state: SnapshotState) => {
      if (!cancelled) setSnapshots((prev) => ({ ...prev, [cameraId]: state }));
    };

    const fetchSnapshot = async (channel: NodeChannel, cameraId: string) => {
      setOne(cameraId, { status: "loading" });
      try {
        const url = await channel.requestSnapshot(cameraId);
        setOne(cameraId, { status: "ready", url });
      } catch (err) {
        setOne(cameraId, {
          status: "error",
          message: err instanceof NodeChannelError ? err.message : "Snapshot failed.",
        });
      }
    };

    const run = async () => {
      for (const camera of wanted) setOne(camera.id, { status: "loading" });
      try {
        const channel = await NodeChannel.connect(getBrowserClient(), nodeId);
        if (cancelled) {
          channel.close();
          return;
        }
        channelRef.current = channel;
        await Promise.all(wanted.map((camera) => fetchSnapshot(channel, camera.id)));
      } catch (err) {
        const message =
          err instanceof NodeChannelError ? err.message : "Could not reach the node.";
        for (const camera of wanted) setOne(camera.id, { status: "error", message });
      }
    };

    void run();

    return () => {
      cancelled = true;
      channelRef.current?.close();
      channelRef.current = null;
    };
    // camerasKey stands in for the cameras array identity.
  }, [nodeId, online, camerasKey, nonce]);

  const retry = (cameraId: string) => {
    const channel = channelRef.current;
    if (!channel) {
      // Channel never connected — re-run the whole effect.
      setNonce((n) => n + 1);
      return;
    }
    setSnapshots((prev) => ({ ...prev, [cameraId]: { status: "loading" } }));
    channel
      .requestSnapshot(cameraId)
      .then((url) => setSnapshots((prev) => ({ ...prev, [cameraId]: { status: "ready", url } })))
      .catch((err: unknown) =>
        setSnapshots((prev) => ({
          ...prev,
          [cameraId]: {
            status: "error",
            message: err instanceof NodeChannelError ? err.message : "Snapshot failed.",
          },
        })),
      );
  };

  /** The signed snapshot URL expired (or broke) — re-request once per URL so a
   *  stale tab heals itself without looping on a persistently bad link. */
  const handleImageError = (cameraId: string, url: string) => {
    if (autoRefreshedRef.current.get(cameraId) === url) {
      setSnapshots((prev) => ({
        ...prev,
        [cameraId]: { status: "error", message: "Snapshot link expired." },
      }));
      return;
    }
    autoRefreshedRef.current.set(cameraId, url);
    retry(cameraId);
  };

  if (cameras.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-night-600 px-4 py-6 text-center text-sm text-fog-500">
        This node has not reported any cameras yet.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {cameras.map((camera) => {
        const snap: SnapshotState = snapshots[camera.id] ?? { status: "idle" };
        return (
          <div
            key={camera.id}
            className="group overflow-hidden rounded-xl border border-night-600 bg-night-800 transition-colors hover:border-night-500"
          >
            <div className="relative aspect-video bg-night-900">
              {snap.status === "ready" ? (
                // Signed, short-lived Supabase Storage URL — plain <img> on purpose.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={snap.url}
                  alt={`Latest snapshot from ${camera.name}`}
                  onError={() => handleImageError(camera.id, snap.url)}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
                  {snap.status === "loading" ? (
                    <>
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-night-500 border-t-ember-400" />
                      <span className="text-xs text-fog-500">Fetching snapshot…</span>
                    </>
                  ) : snap.status === "error" ? (
                    <>
                      <span className="text-xs text-fog-400">{snap.message}</span>
                      <button
                        type="button"
                        onClick={() => retry(camera.id)}
                        className="text-xs font-medium text-ember-400 underline-offset-2 hover:underline"
                      >
                        Retry
                      </button>
                    </>
                  ) : (
                    <>
                      <CameraIcon className="h-7 w-7 text-night-500" />
                      <span className="text-xs text-fog-500">
                        {!camera.enabled
                          ? "Camera disabled"
                          : online
                            ? "No snapshot"
                            : "Node offline"}
                      </span>
                    </>
                  )}
                </div>
              )}
              {!camera.enabled && (
                <span className="absolute left-2 top-2 rounded-full bg-night-950/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-fog-400">
                  Disabled
                </span>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 px-3.5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-fog-100">{camera.name}</p>
                {camera.capLabel && <p className="text-[11px] text-fog-500">{camera.capLabel}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Link
                  href={`/live/${camera.id}?tab=history`}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                    online
                      ? "border-night-500 text-fog-300 hover:border-fog-500 hover:text-fog-100"
                      : "pointer-events-none border-night-600 text-fog-500"
                  }`}
                  aria-disabled={!online}
                >
                  <HistoryIcon className="h-3.5 w-3.5" />
                  History
                </Link>
                <Link
                  href={`/live/${camera.id}`}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                    online && camera.enabled
                      ? "border-ember-500/40 text-ember-300 hover:bg-ember-500/10"
                      : "pointer-events-none border-night-600 text-fog-500"
                  }`}
                  aria-disabled={!online || !camera.enabled}
                >
                  <LiveIcon className="h-3.5 w-3.5" />
                  Live
                </Link>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
