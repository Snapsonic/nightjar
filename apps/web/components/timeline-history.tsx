"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NodeChannel, NodeChannelError } from "@/lib/realtime";
import { getBrowserClient } from "@/lib/supabase/client";

interface Span {
  startMs: number;
  endMs: number;
}

/** Clip window around the clicked instant. */
const PRE_MS = 30_000;
const POST_MS = 90_000;
/** Exports of long ranges (ffmpeg concat + storage upload) take a while. */
const EXPORT_TIMEOUT_MS = 60_000;
/** Hover preview: wait this long before asking the node for a frame. */
const PREVIEW_DEBOUNCE_MS = 250;
const PREVIEW_BUCKET_MS = 60_000;

const dayParts = (day: string): [number, number, number] => {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return [y, m, d];
};
const dayStartMs = (day: string): number => {
  const [y, m, d] = dayParts(day);
  return new Date(y, m - 1, d).getTime();
};
const dayEndMs = (day: string): number => {
  const [y, m, d] = dayParts(day);
  return new Date(y, m - 1, d + 1).getTime();
};

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtShort = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function errorMessage(err: unknown): string {
  if (err instanceof NodeChannelError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

type PreviewState =
  | { status: "loading"; bucket: number }
  | { status: "ready"; bucket: number; url: string }
  | { status: "none"; bucket: number };

/**
 * 24/7 recording history for one camera: day chips + a 24h coverage bar.
 * Hovering (or touch-dragging) the bar shows a floating preview frame fetched
 * from the node; clicking a covered instant exports a ~2 minute clip around
 * it and plays the signed URL, with the playing range + playhead drawn on the
 * bar.
 */
export function TimelineHistory({
  cameraId,
  nodeId,
  autoFocus = false,
}: {
  cameraId: string;
  nodeId: string;
  autoFocus?: boolean;
}) {
  const channelRef = useRef<NodeChannel | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const [days, setDays] = useState<string[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [spans, setSpans] = useState<Span[]>([]);
  const [loadingSpans, setLoadingSpans] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [clip, setClip] = useState<{ url: string; fromMs: number; toMs: number } | null>(null);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Hover position over the bar (fraction of the day + instant). */
  const [hover, setHover] = useState<{ frac: number; ms: number; covered: boolean } | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  /** bucketMs -> signed URL, or null when the node has no frame there. */
  const previewCacheRef = useRef(new Map<number, string | null>());
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Monotonic token so only the latest in-flight preview request wins. */
  const previewSeqRef = useRef(0);

  /** Connect once (lazily) and reuse for all timeline requests. */
  const getChannel = useCallback(async (): Promise<NodeChannel> => {
    if (channelRef.current) return channelRef.current;
    const channel = await NodeChannel.connect(getBrowserClient(), nodeId);
    channelRef.current = channel;
    return channel;
  }, [nodeId]);

  useEffect(() => {
    if (!autoFocus) return;
    // Deep link (?tab=history): bring the history section into view.
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [autoFocus]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const channel = await getChannel();
        const list = await channel.requestTimelineDays(cameraId);
        if (cancelled) return;
        setDays(list);
        setDay(list[list.length - 1] ?? null);
      } catch (err) {
        if (!cancelled) {
          setDays([]);
          setError(errorMessage(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      previewSeqRef.current += 1; // orphan any in-flight preview
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [cameraId, getChannel]);

  useEffect(() => {
    if (!day) return;
    let cancelled = false;
    setLoadingSpans(true);
    setNotice(null);
    void (async () => {
      try {
        const channel = await getChannel();
        const coverage = await channel.requestTimelineCoverage(cameraId, day);
        if (!cancelled) {
          setSpans(coverage);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSpans([]);
          setError(errorMessage(err));
        }
      } finally {
        if (!cancelled) setLoadingSpans(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cameraId, day, getChannel]);

  /* ---------- hover preview ---------- */

  const requestPreview = useCallback(
    (bucket: number) => {
      const cached = previewCacheRef.current.get(bucket);
      if (cached !== undefined) {
        setPreview(
          cached === null ? { status: "none", bucket } : { status: "ready", bucket, url: cached },
        );
        return;
      }
      const seq = ++previewSeqRef.current;
      setPreview({ status: "loading", bucket });
      void (async () => {
        try {
          const channel = await getChannel();
          const url = await channel.requestTimelinePreview(cameraId, bucket);
          previewCacheRef.current.set(bucket, url);
          if (previewSeqRef.current === seq) setPreview({ status: "ready", bucket, url });
        } catch {
          // "no recording there" and transient failures both render as none.
          previewCacheRef.current.set(bucket, null);
          if (previewSeqRef.current === seq) setPreview({ status: "none", bucket });
        }
      })();
    },
    [cameraId, getChannel],
  );

  const handleBarHover = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!day) return;
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0) return;
    const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const start = dayStartMs(day);
    const ms = Math.round(start + frac * (dayEndMs(day) - start));
    const covered = spans.some((s) => ms >= s.startMs && ms <= s.endMs);
    setHover({ frac, ms, covered });

    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    if (!covered) {
      previewSeqRef.current += 1; // stale responses must not pop in
      setPreview(null);
      return;
    }
    const bucket = Math.floor(ms / PREVIEW_BUCKET_MS) * PREVIEW_BUCKET_MS;
    if (previewCacheRef.current.has(bucket)) {
      requestPreview(bucket); // cache hit — show instantly, no debounce
      return;
    }
    setPreview((prev) => (prev?.bucket === bucket ? prev : { status: "loading", bucket }));
    previewTimerRef.current = setTimeout(() => requestPreview(bucket), PREVIEW_DEBOUNCE_MS);
  };

  const handleBarLeave = () => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewSeqRef.current += 1;
    setHover(null);
    setPreview(null);
  };

  /* ---------- clip export ---------- */

  const handleBarClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    if (!day || preparing) return;
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const start = dayStartMs(day);
    const clicked = Math.round(start + frac * (dayEndMs(day) - start));

    const covered = spans.some((s) => clicked >= s.startMs && clicked <= s.endMs);
    if (!covered) {
      setNotice("No recording at that time — pick a highlighted stretch.");
      return;
    }

    setNotice(null);
    setError(null);
    setPreparing(true);
    try {
      const channel = await getChannel();
      const fromMs = clicked - PRE_MS;
      const toMs = clicked + POST_MS;
      const url = await channel.requestTimelineExport(cameraId, fromMs, toMs, EXPORT_TIMEOUT_MS);
      setPlayheadMs(fromMs);
      setClip({ url, fromMs, toMs });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPreparing(false);
    }
  };

  const returnToLive = () => {
    setClip(null);
    setPlayheadMs(null);
    document.getElementById("live")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const start = day ? dayStartMs(day) : 0;
  const length = day ? dayEndMs(day) - start : 1;

  /** Clamp a [fromMs, toMs] range into the visible day as left/width %. */
  const rangeToPercent = (fromMs: number, toMs: number): { left: number; width: number } | null => {
    const left = Math.max(0, ((fromMs - start) / length) * 100);
    const right = Math.min(100, ((toMs - start) / length) * 100);
    if (right <= left) return null;
    return { left, width: Math.max(right - left, 0.25) };
  };

  const clipRange = clip ? rangeToPercent(clip.fromMs, clip.toMs) : null;
  const playheadPercent =
    clip && playheadMs !== null && playheadMs >= start && playheadMs <= start + length
      ? ((playheadMs - start) / length) * 100
      : null;

  return (
    <section ref={sectionRef} id="history" className="mt-8 scroll-mt-4">
      <h2 className="text-sm font-semibold tracking-tight text-fog-100">History</h2>
      <p className="mt-1 text-xs text-fog-500">
        Continuous 24/7 recordings stored on the node. Hover the bar to preview a moment; click to
        fetch a two-minute clip.
      </p>

      {days === null ? (
        <div className="mt-4 h-8 w-64 animate-pulse rounded-lg bg-night-800" />
      ) : days.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-night-500 px-4 py-6 text-center text-xs text-fog-500">
          {error ? `Could not load history: ${error}` : "No 24/7 recordings for this camera yet."}
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {days.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDay(d)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  d === day
                    ? "border-ember-500/60 bg-ember-500/15 text-ember-300"
                    : "border-night-500 text-fog-400 hover:border-fog-500 hover:text-fog-200"
                }`}
              >
                {d}
              </button>
            ))}
          </div>

          <div className="mt-3">
            <div className="relative">
              {/* Floating hover preview (thumbnail + timestamp). */}
              {hover && (
                <div
                  className="pointer-events-none absolute bottom-full z-10 mb-2 -translate-x-1/2"
                  style={{ left: `${Math.min(92, Math.max(8, hover.frac * 100))}%` }}
                >
                  <div className="w-44 overflow-hidden rounded-lg border border-night-500 bg-night-950 shadow-lg shadow-night-950/60">
                    {hover.covered ? (
                      preview?.status === "ready" ? (
                        // Signed, short-lived Supabase Storage URL — plain <img> on purpose.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={preview.url}
                          alt={`Preview at ${fmtShort(hover.ms)}`}
                          className="aspect-video w-full bg-night-900 object-cover"
                        />
                      ) : (
                        <div className="flex aspect-video w-full items-center justify-center bg-night-900">
                          {preview?.status === "none" ? (
                            <span className="text-[10px] text-fog-500">No preview</span>
                          ) : (
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-night-500 border-t-ember-400" />
                          )}
                        </div>
                      )
                    ) : (
                      <div className="flex aspect-video w-full items-center justify-center bg-night-900">
                        <span className="text-[10px] text-fog-500">No recording</span>
                      </div>
                    )}
                    <div className="border-t border-night-700 px-2 py-1 text-center text-[10px] tabular-nums text-fog-300">
                      {fmtShort(hover.ms)}
                    </div>
                  </div>
                </div>
              )}

              <div
                ref={barRef}
                onClick={(e) => void handleBarClick(e)}
                onPointerMove={handleBarHover}
                onPointerDown={handleBarHover}
                onPointerLeave={handleBarLeave}
                onPointerCancel={handleBarLeave}
                className={`relative h-8 touch-none overflow-hidden rounded-lg border border-night-600 bg-night-900 ${
                  preparing ? "cursor-wait opacity-70" : "cursor-crosshair"
                }`}
                role="slider"
                aria-label="Recording timeline"
                aria-valuemin={0}
                aria-valuemax={24}
                aria-valuenow={12}
              >
                {loadingSpans ? (
                  <div className="absolute inset-0 animate-pulse bg-night-800" />
                ) : (
                  <>
                    {spans.map((span, i) => {
                      const left = ((span.startMs - start) / length) * 100;
                      const width = ((span.endMs - span.startMs) / length) * 100;
                      return (
                        <div
                          key={i}
                          className="absolute bottom-0 top-0 bg-ember-500/60 hover:bg-ember-400"
                          style={{
                            left: `${Math.max(0, left)}%`,
                            width: `${Math.max(0.15, Math.min(100 - left, width))}%`,
                          }}
                        />
                      );
                    })}
                    {/* Now playing: highlight the clip's range… */}
                    {clipRange && (
                      <div
                        className="pointer-events-none absolute bottom-0 top-0 border-x border-sky-300/80 bg-sky-400/40"
                        style={{ left: `${clipRange.left}%`, width: `${clipRange.width}%` }}
                        aria-hidden="true"
                      />
                    )}
                    {/* …and the moving playhead inside it. */}
                    {playheadPercent !== null && (
                      <div
                        className="pointer-events-none absolute bottom-0 top-0 w-0.5 -translate-x-1/2 bg-fog-100"
                        style={{ left: `${playheadPercent}%` }}
                        aria-hidden="true"
                      />
                    )}
                    {/* Hover cursor line. */}
                    {hover && (
                      <div
                        className="pointer-events-none absolute bottom-0 top-0 w-px bg-fog-300/70"
                        style={{ left: `${hover.frac * 100}%` }}
                        aria-hidden="true"
                      />
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-fog-500">
              <span>00:00</span>
              <span>06:00</span>
              <span>12:00</span>
              <span>18:00</span>
              <span>24:00</span>
            </div>
          </div>

          {preparing && (
            <p className="mt-3 flex items-center gap-2 text-xs text-fog-300">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-night-500 border-t-ember-400" />
              Preparing clip…
            </p>
          )}
          {notice && !preparing && <p className="mt-3 text-xs text-fog-400">{notice}</p>}
          {error && !preparing && days.length > 0 && (
            <p className="mt-3 text-xs text-danger">{error}</p>
          )}

          {clip && (
            <div className="mt-4 overflow-hidden rounded-2xl border border-night-600 bg-night-950">
              <video
                key={clip.url}
                src={clip.url}
                controls
                autoPlay
                playsInline
                onTimeUpdate={(e) =>
                  setPlayheadMs(clip.fromMs + e.currentTarget.currentTime * 1000)
                }
                className="aspect-video w-full bg-night-950 object-contain"
              />
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-night-700 px-4 py-2">
                <span className="flex items-center gap-2 text-xs text-fog-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true" />
                  Viewing {fmtTime(clip.fromMs)} – {fmtTime(clip.toMs)}
                </span>
                <button
                  type="button"
                  onClick={returnToLive}
                  className="rounded-lg border border-ember-500/40 px-2.5 py-1 text-xs font-semibold text-ember-300 transition-colors hover:bg-ember-500/10"
                >
                  Return to live
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
