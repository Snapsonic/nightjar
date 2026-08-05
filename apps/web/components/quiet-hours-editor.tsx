"use client";

import { useState } from "react";
import { EventKind, MAX_QUIET_WINDOWS_PER_CAMERA, type QuietWindow } from "@nightjar/shared";
import { KIND_LABELS } from "@/components/settings-forms";
import { NodeChannel, NodeChannelError } from "@/lib/realtime";
import { getBrowserClient } from "@/lib/supabase/client";

/**
 * Per-camera quiet windows.
 *
 * Unlike the notification toggles next to it, this stops the event being
 * created at all — no clip, no upload, no alert — so it is the setting to
 * reach for when a camera is doing real work you simply do not want recorded
 * as events at that time of day. Continuous recording is unaffected, which is
 * worth saying in the UI: the footage is still there to scrub.
 */
export function QuietHoursEditor({
  cameraId,
  nodeId,
  nodeOnline,
  initialQuietHours,
}: {
  cameraId: string;
  nodeId: string;
  nodeOnline: boolean;
  initialQuietHours: QuietWindow[];
}) {
  const [windows, setWindows] = useState<QuietWindow[]>(initialQuietHours);
  const [saved, setSaved] = useState<QuietWindow[]>(initialQuietHours);
  const [state, setState] = useState<
    { status: "idle" | "saving" | "saved" } | { status: "error"; message: string }
  >({ status: "idle" });
  const dirty = JSON.stringify(windows) !== JSON.stringify(saved);

  const addWindow = () =>
    setWindows((w) =>
      w.length >= MAX_QUIET_WINDOWS_PER_CAMERA
        ? w
        : [...w, { kinds: ["cat"], start: "10:00", end: "18:00" }],
    );

  const update = (i: number, patch: Partial<QuietWindow>) =>
    setWindows((w) => w.map((win, j) => (j === i ? { ...win, ...patch } : win)));

  const toggleKind = (i: number, kind: string) =>
    setWindows((w) =>
      w.map((win, j) => {
        if (j !== i) return win;
        const on = win.kinds.includes(kind as QuietWindow["kinds"][number]);
        // At least one kind, or the window means nothing.
        const kinds = on
          ? win.kinds.filter((k) => k !== kind)
          : [...win.kinds, kind as QuietWindow["kinds"][number]];
        return kinds.length === 0 ? win : { ...win, kinds };
      }),
    );

  // Connected on save rather than on mount: this panel is idle almost all the
  // time, and a camera page should not hold a realtime channel open for it.
  const save = async () => {
    setState({ status: "saving" });
    let channel: NodeChannel | null = null;
    try {
      channel = await NodeChannel.connect(getBrowserClient(), nodeId);
      await channel.requestUpdateQuietHours(cameraId, windows);
      setSaved(windows);
      setState({ status: "saved" });
    } catch (err) {
      setState({
        status: "error",
        message:
          err instanceof NodeChannelError ? err.message : "Could not save quiet hours.",
      });
    } finally {
      void channel?.close();
    }
  };

  return (
    <section className="mt-6 rounded-2xl border border-night-600 bg-night-850 p-5">
      <h2 className="text-sm font-semibold tracking-tight text-fog-100">Quiet hours</h2>
      <p className="mt-1 text-xs leading-relaxed text-fog-500">
        Times of day when this camera raises no event for the chosen kinds — no clip, no
        upload, no alert. Recording continues as normal, so the footage is still in the
        timeline. Times are the node&apos;s local time; a window ending before it starts wraps
        past midnight.
      </p>

      {windows.length === 0 && (
        <p className="mt-4 text-xs text-fog-500">
          No quiet hours — this camera raises events around the clock.
        </p>
      )}

      <div className="mt-4 space-y-3">
        {windows.map((win, i) => (
          <div key={i} className="rounded-lg border border-night-600 bg-night-800 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="time"
                value={win.start}
                aria-label="Quiet from"
                onChange={(e) => update(i, { start: e.target.value })}
                className="rounded-md border border-night-600 bg-night-900 px-2 py-1 text-sm text-fog-200"
              />
              <span className="text-xs text-fog-500">to</span>
              <input
                type="time"
                value={win.end}
                aria-label="Quiet until"
                onChange={(e) => update(i, { end: e.target.value })}
                className="rounded-md border border-night-600 bg-night-900 px-2 py-1 text-sm text-fog-200"
              />
              <button
                type="button"
                onClick={() => setWindows((w) => w.filter((_, j) => j !== i))}
                className="ml-auto text-xs text-fog-400 transition-colors hover:text-danger"
              >
                Remove
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {EventKind.options.map((kind) => {
                const on = win.kinds.includes(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleKind(i, kind)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      on
                        ? "border-ember-500 bg-ember-500/15 text-ember-200"
                        : "border-night-600 text-fog-400 hover:text-fog-200"
                    }`}
                  >
                    {KIND_LABELS[kind]}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={addWindow}
          disabled={windows.length >= MAX_QUIET_WINDOWS_PER_CAMERA}
          className="rounded-lg border border-night-600 px-3 py-1.5 text-xs text-fog-200 transition-colors hover:border-night-500 disabled:opacity-50"
        >
          Add quiet hours
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || !nodeOnline || state.status === "saving"}
          className="rounded-lg bg-ember-500 px-3 py-1.5 text-xs font-medium text-night-950 transition-colors disabled:opacity-50"
        >
          {state.status === "saving" ? "Saving…" : "Save quiet hours"}
        </button>
        {!nodeOnline && <span className="text-xs text-fog-500">Node is offline.</span>}
        {state.status === "saved" && !dirty && (
          <span className="text-xs text-fog-400">Saved.</span>
        )}
        {state.status === "error" && (
          <span role="alert" className="text-xs text-danger">
            {state.message}
          </span>
        )}
      </div>
    </section>
  );
}
