"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_ZONES_PER_CAMERA, type Zone } from "@nightjar/shared";
import { NodeChannel, NodeChannelError } from "@/lib/realtime";
import { getBrowserClient } from "@/lib/supabase/client";

/**
 * Activity-zone editor for one camera. Opens over a fresh snapshot (requested
 * through the shared node channel), lets the user draw include-polygons by
 * clicking points (click the first point again to close), drag vertices,
 * rename/delete zones, and saves with the update_zones realtime command.
 * Escape cancels an in-progress polygon. Zones are stored as normalized
 * 0..1 [x, y] points, so they are resolution-independent.
 */

const ZONE_COLORS = [
  "#f59e0b", // amber
  "#38bdf8", // sky
  "#a78bfa", // violet
  "#34d399", // emerald
  "#f472b6", // pink
  "#fb923c", // orange
  "#60a5fa", // blue
  "#facc15", // yellow
];

/** Hit radius for grabbing a vertex / closing the polygon, in CSS pixels. */
const HANDLE_RADIUS_PX = 14;
const MAX_POINTS = 20;
const MIN_POINTS = 3;

type SnapState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string };

type SaveState = { status: "idle" | "saving" | "saved" } | { status: "error"; message: string };

const zoneColor = (index: number) => ZONE_COLORS[index % ZONE_COLORS.length] as string;

const shortId = () => Math.random().toString(36).slice(2, 10);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function ZoneEditor({
  cameraId,
  nodeId,
  nodeOnline,
  initialZones,
}: {
  cameraId: string;
  nodeId: string;
  nodeOnline: boolean;
  initialZones: Zone[];
}) {
  const [open, setOpen] = useState(false);
  const [zones, setZones] = useState<Zone[]>(initialZones);
  const [savedZones, setSavedZones] = useState<Zone[]>(initialZones);
  const [draft, setDraft] = useState<[number, number][] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [snap, setSnap] = useState<SnapState>({ status: "loading" });
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [snapNonce, setSnapNonce] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const channelRef = useRef<NodeChannel | null>(null);
  const dragRef = useRef<{ zone: number; point: number; moved: boolean } | null>(null);

  const dirty = JSON.stringify(zones) !== JSON.stringify(savedZones);

  /* ---------- snapshot + channel lifecycle (while open) ---------- */

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSnap({ status: "loading" });
    const run = async () => {
      try {
        const channel = await NodeChannel.connect(getBrowserClient(), nodeId);
        if (cancelled) {
          channel.close();
          return;
        }
        channelRef.current = channel;
        const url = await channel.requestSnapshot(cameraId);
        if (!cancelled) setSnap({ status: "ready", url });
      } catch (err) {
        if (!cancelled) {
          setSnap({
            status: "error",
            message:
              err instanceof NodeChannelError ? err.message : "Could not fetch a snapshot.",
          });
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [open, cameraId, nodeId, snapNonce]);

  /* ---------- canvas drawing ---------- */

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * dpr)) canvas.width = Math.round(rect.width * dpr);
    if (canvas.height !== Math.round(rect.height * dpr)) {
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const toPx = ([nx, ny]: [number, number]): [number, number] => [
      nx * rect.width,
      ny * rect.height,
    ];

    zones.forEach((zone, index) => {
      const color = zoneColor(index);
      ctx.beginPath();
      zone.points.forEach((point, i) => {
        const [x, y] = toPx(point);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = `${color}${selected === index ? "55" : "33"}`;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = selected === index ? 2.5 : 1.5;
      ctx.stroke();
      // Vertex handles on the selected zone.
      if (selected === index) {
        for (const point of zone.points) {
          const [x, y] = toPx(point);
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fillStyle = "#0b1120";
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      // Label at the polygon centroid-ish (vertex average).
      const cx = zone.points.reduce((sum, p) => sum + p[0], 0) / zone.points.length;
      const cy = zone.points.reduce((sum, p) => sum + p[1], 0) / zone.points.length;
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.fillText(zone.name, cx * rect.width, cy * rect.height);
    });

    if (draft) {
      const color = zoneColor(zones.length);
      ctx.beginPath();
      draft.forEach((point, i) => {
        const [x, y] = toPx(point);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      draft.forEach((point, i) => {
        const [x, y] = toPx(point);
        ctx.beginPath();
        ctx.arc(x, y, i === 0 ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 && draft.length >= MIN_POINTS ? color : "#0b1120";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }
  }, [zones, draft, selected]);

  useEffect(() => {
    if (!open) return;
    redraw();
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, [open, redraw, snap]);

  /* ---------- pointer interaction ---------- */

  const eventNorm = (event: React.PointerEvent): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return [
      clamp01((event.clientX - rect.left) / rect.width),
      clamp01((event.clientY - rect.top) / rect.height),
    ];
  };

  const nearPx = (a: [number, number], b: [number, number]): boolean => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const dx = (a[0] - b[0]) * rect.width;
    const dy = (a[1] - b[1]) * rect.height;
    return dx * dx + dy * dy <= HANDLE_RADIUS_PX * HANDLE_RADIUS_PX;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    const at = eventNorm(event);
    if (!at) return;
    event.preventDefault();

    if (draft) {
      // Close the polygon by clicking the first point again.
      if (draft.length >= MIN_POINTS && nearPx(at, draft[0] as [number, number])) {
        const zone: Zone = {
          id: shortId(),
          name: `Zone ${zones.length + 1}`,
          points: draft,
          mode: "include",
        };
        setZones((prev) => [...prev, zone]);
        setSelected(zones.length);
        setDraft(null);
        return;
      }
      if (draft.length >= MAX_POINTS) return;
      setDraft((prev) => (prev ? [...prev, at] : [at]));
      return;
    }

    // Grab a vertex of the selected zone first, then of any zone.
    const order =
      selected !== null
        ? [selected, ...zones.map((_, i) => i).filter((i) => i !== selected)]
        : zones.map((_, i) => i);
    for (const zi of order) {
      const zone = zones[zi];
      if (!zone) continue;
      const pi = zone.points.findIndex((point) => nearPx(at, point as [number, number]));
      if (pi >= 0) {
        dragRef.current = { zone: zi, point: pi, moved: false };
        setSelected(zi);
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }

    // Otherwise select whichever zone was clicked (top-most last drawn).
    for (let zi = zones.length - 1; zi >= 0; zi--) {
      const zone = zones[zi];
      if (zone && pointInPolygonLocal(at[0], at[1], zone.points)) {
        setSelected(zi);
        return;
      }
    }
    setSelected(null);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const at = eventNorm(event);
    if (!at) return;
    drag.moved = true;
    setZones((prev) =>
      prev.map((zone, zi) =>
        zi === drag.zone
          ? { ...zone, points: zone.points.map((point, pi) => (pi === drag.point ? at : point)) }
          : zone,
      ),
    );
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && draft) {
        event.stopPropagation();
        setDraft(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, draft]);

  /* ---------- actions ---------- */

  const startDrawing = () => {
    if (zones.length >= MAX_ZONES_PER_CAMERA) return;
    setSelected(null);
    setDraft([]);
  };

  const removeZone = (index: number) => {
    setZones((prev) => prev.filter((_, i) => i !== index));
    setSelected(null);
  };

  const renameZone = (index: number, name: string) => {
    setZones((prev) => prev.map((zone, i) => (i === index ? { ...zone, name } : zone)));
  };

  const saveZones = async () => {
    const channel = channelRef.current;
    if (!channel) {
      setSave({ status: "error", message: "Not connected to the node." });
      return;
    }
    // Names: trim, never empty (schema requires 1..40 chars).
    const cleaned = zones.map((zone, i) => ({
      ...zone,
      name: zone.name.trim().slice(0, 40) || `Zone ${i + 1}`,
    }));
    setSave({ status: "saving" });
    try {
      await channel.requestUpdateZones(cameraId, cleaned);
      setZones(cleaned);
      setSavedZones(cleaned);
      setSave({ status: "saved" });
    } catch (err) {
      setSave({
        status: "error",
        message: err instanceof NodeChannelError ? err.message : "Could not save zones.",
      });
    }
  };

  const closeEditor = () => {
    setZones(savedZones);
    setDraft(null);
    setSelected(null);
    setSave({ status: "idle" });
    setOpen(false);
  };

  /* ---------- render ---------- */

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-fog-100">Activity zones</h2>
          <p className="mt-0.5 text-xs text-fog-500">
            {savedZones.length === 0
              ? "No zones — the whole frame triggers motion and detections."
              : `${savedZones.length} zone${savedZones.length === 1 ? "" : "s"} — only motion and detections inside them count.`}
          </p>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={!nodeOnline}
            className="rounded-lg border border-night-500 px-3.5 py-2 text-sm font-medium text-fog-200 transition-colors hover:border-ember-500/50 hover:text-fog-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Edit zones
          </button>
        )}
      </div>

      {open && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-night-600 bg-night-850">
          <div className="relative aspect-video w-full bg-night-950">
            {snap.status === "ready" ? (
              <>
                {/* Signed, short-lived Supabase Storage URL — plain <img> on purpose. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={snap.url}
                  alt="Camera snapshot for zone editing"
                  onLoad={redraw}
                  className="absolute inset-0 h-full w-full object-fill"
                  draggable={false}
                />
                <canvas
                  ref={canvasRef}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  className={`absolute inset-0 h-full w-full touch-none ${
                    draft ? "cursor-crosshair" : "cursor-pointer"
                  }`}
                />
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
                {snap.status === "loading" ? (
                  <>
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-night-500 border-t-ember-400" />
                    <span className="text-xs text-fog-500">Fetching a fresh snapshot…</span>
                  </>
                ) : (
                  <>
                    <span className="text-xs text-fog-400">{snap.message}</span>
                    <button
                      type="button"
                      onClick={() => setSnapNonce((n) => n + 1)}
                      className="text-xs font-medium text-ember-400 underline-offset-2 hover:underline"
                    >
                      Retry
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-night-700 px-4 py-3">
            <p className="text-xs text-fog-500">
              {draft
                ? draft.length < MIN_POINTS
                  ? `Tap the image to add points (${draft.length}/${MIN_POINTS} minimum). Esc cancels.`
                  : "Tap more points, or tap the first point to close the polygon. Esc cancels."
                : "Add a zone and outline the area that should trigger events. Drag points to adjust."}
            </p>

            {zones.length > 0 && (
              <ul className="mt-3 space-y-2">
                {zones.map((zone, index) => (
                  <li key={zone.id} className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setSelected(selected === index ? null : index)}
                      aria-label={`Select ${zone.name}`}
                      className={`h-4 w-4 shrink-0 rounded-sm border-2 ${
                        selected === index ? "ring-2 ring-fog-300/60" : ""
                      }`}
                      style={{ backgroundColor: `${zoneColor(index)}55`, borderColor: zoneColor(index) }}
                    />
                    <input
                      type="text"
                      value={zone.name}
                      maxLength={40}
                      onChange={(event) => renameZone(index, event.target.value)}
                      onFocus={() => setSelected(index)}
                      className="w-40 rounded-md border border-night-600 bg-night-900 px-2 py-1 text-xs text-fog-100 outline-none focus:border-ember-500/60"
                    />
                    <span className="text-[11px] text-fog-500">{zone.points.length} points</span>
                    <button
                      type="button"
                      onClick={() => removeZone(index)}
                      className="ml-auto rounded-md border border-night-600 px-2 py-1 text-[11px] font-medium text-fog-400 transition-colors hover:border-danger/50 hover:text-danger"
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {draft ? (
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className="rounded-lg border border-night-500 px-3 py-1.5 text-xs font-medium text-fog-300 transition-colors hover:border-fog-500"
                >
                  Cancel polygon
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startDrawing}
                  disabled={snap.status !== "ready" || zones.length >= MAX_ZONES_PER_CAMERA}
                  className="rounded-lg border border-night-500 px-3 py-1.5 text-xs font-medium text-fog-200 transition-colors hover:border-ember-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  + Add zone
                </button>
              )}
              <button
                type="button"
                onClick={() => void saveZones()}
                disabled={!dirty || draft !== null || save.status === "saving"}
                className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-xs font-semibold text-night-950 transition-colors hover:bg-ember-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {save.status === "saving" ? "Saving…" : "Save zones"}
              </button>
              <button
                type="button"
                onClick={closeEditor}
                className="rounded-lg border border-night-600 px-3 py-1.5 text-xs font-medium text-fog-400 transition-colors hover:border-night-500 hover:text-fog-200"
              >
                {dirty ? "Discard & close" : "Close"}
              </button>
              {save.status === "saved" && !dirty && (
                <span className="text-xs text-online">Saved.</span>
              )}
              {save.status === "error" && (
                <span className="text-xs text-danger">{save.message}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Ray-casting point-in-polygon (mirror of the node's zone geometry). */
function pointInPolygonLocal(
  x: number,
  y: number,
  points: readonly [number, number][],
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i] as [number, number];
    const [xj, yj] = points[j] as [number, number];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}
