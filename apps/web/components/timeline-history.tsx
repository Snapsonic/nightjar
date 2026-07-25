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

function errorMessage(err: unknown): string {
  if (err instanceof NodeChannelError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * 24/7 recording history for one camera: day chips + a 24h coverage bar.
 * Clicking a covered instant asks the node (over the private Realtime
 * channel) to export a ~2 minute clip around it, then plays the signed URL.
 */
export function TimelineHistory({ cameraId, nodeId }: { cameraId: string; nodeId: string }) {
  const channelRef = useRef<NodeChannel | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const [days, setDays] = useState<string[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [spans, setSpans] = useState<Span[]>([]);
  const [loadingSpans, setLoadingSpans] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [clip, setClip] = useState<{ url: string; fromMs: number; toMs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Connect once (lazily) and reuse for all timeline requests. */
  const getChannel = useCallback(async (): Promise<NodeChannel> => {
    if (channelRef.current) return channelRef.current;
    const channel = await NodeChannel.connect(getBrowserClient(), nodeId);
    channelRef.current = channel;
    return channel;
  }, [nodeId]);

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
      setClip({ url, fromMs, toMs });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPreparing(false);
    }
  };

  const start = day ? dayStartMs(day) : 0;
  const length = day ? dayEndMs(day) - start : 1;

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold tracking-tight text-fog-100">History</h2>
      <p className="mt-1 text-xs text-fog-500">
        Continuous 24/7 recordings stored on the node. Click a highlighted stretch to fetch a
        two-minute clip.
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
            <div
              ref={barRef}
              onClick={(e) => void handleBarClick(e)}
              className={`relative h-8 overflow-hidden rounded-lg border border-night-600 bg-night-900 ${
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
                spans.map((span, i) => {
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
                })
              )}
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
                className="aspect-video w-full bg-night-950 object-contain"
              />
              <div className="flex items-center justify-between border-t border-night-700 px-4 py-2">
                <span className="text-xs text-fog-400">
                  Recorded {fmtTime(clip.fromMs)} – {fmtTime(clip.toMs)}
                </span>
                <button
                  type="button"
                  onClick={() => setClip(null)}
                  className="text-xs font-medium text-fog-400 transition-colors hover:text-fog-200"
                >
                  Close clip
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
