"use client";

import { useState } from "react";
import type { Json } from "@nightjar/db";
import { EventKind } from "@nightjar/shared";
import { KIND_LABELS, KindSwitch } from "@/components/settings-forms";
import { getBrowserClient } from "@/lib/supabase/client";

/**
 * Per-camera notification overrides.
 *
 * notification_settings has always been keyed on (user_id, camera_id) and the
 * notifier has always preferred a camera row over the global camera_id IS NULL
 * one — only the UI was missing, so every camera was stuck on one shared list.
 * That is painful on a camera that can see indoors through a window, where a
 * person detection is correct and still not something you want alerted about.
 *
 * Absence of a row is meaningful here: it means "inherit". So the override is
 * modelled as create-row / delete-row rather than a flag on the row, which
 * keeps the UI and the notifier's lookup describing the same thing.
 */
export function CameraNotifications({
  userId,
  cameraId,
  cameraName,
  globalKinds,
  globalChannels,
  initialKinds,
}: {
  userId: string;
  cameraId: string;
  cameraName: string;
  /** Kinds from the global row, shown while inheriting. */
  globalKinds: string[];
  /**
   * Channels from the global row, copied onto a new override row.
   *
   * The notifier reads channels from whichever row wins, so a camera override
   * created without them would silently fall back to the column default and
   * turn email off for that camera alone.
   */
  globalChannels: Json | null;
  /** Kinds on this camera's own row, or null when it has none (inheriting). */
  initialKinds: string[] | null;
}) {
  const [kinds, setKinds] = useState<string[] | null>(initialKinds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overriding = kinds !== null;
  const effective = new Set(kinds ?? globalKinds);

  async function setOverride(on: boolean) {
    const previous = kinds;
    // Seed an override from whatever is in force now, so switching it on never
    // silently changes which alerts you get — it only makes them editable.
    const next = on ? [...globalKinds] : null;
    setKinds(next);
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: err } = on
      ? await supabase.from("notification_settings").insert({
          user_id: userId,
          camera_id: cameraId,
          kinds: next ?? [],
          // Carried over deliberately — see globalChannels.
          ...(globalChannels ? { channels: globalChannels } : {}),
        })
      : await supabase
          .from("notification_settings")
          .delete()
          .eq("user_id", userId)
          .eq("camera_id", cameraId);
    setBusy(false);
    if (err) {
      setKinds(previous);
      setError(`Could not save: ${err.message}`);
    }
  }

  async function toggle(kind: EventKind) {
    if (kinds === null) return;
    const next = new Set(kinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    const previous = kinds;
    setKinds([...next]);
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: err } = await supabase
      .from("notification_settings")
      .update({ kinds: [...next] })
      .eq("user_id", userId)
      .eq("camera_id", cameraId);
    setBusy(false);
    if (err) {
      setKinds(previous);
      setError(`Could not save: ${err.message}`);
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-night-600 bg-night-850 p-5">
      <h2 className="text-sm font-semibold tracking-tight text-fog-100">Notifications</h2>
      <p className="mt-1 text-xs leading-relaxed text-fog-500">
        {overriding
          ? `Only for ${cameraName}. Other cameras keep the settings from the settings page.`
          : "This camera follows your settings for all cameras."}
      </p>

      <label className="mt-4 flex cursor-pointer items-center justify-between rounded-lg border border-night-600 bg-night-800 px-3.5 py-2.5">
        <span className="text-sm text-fog-200">Use different alerts for this camera</span>
        <button
          type="button"
          role="switch"
          aria-checked={overriding}
          aria-label="Use different alerts for this camera"
          disabled={busy}
          onClick={() => void setOverride(!overriding)}
          className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-60 ${
            overriding ? "bg-ember-500" : "bg-night-500"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-night-950 transition-all ${
              overriding ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
      </label>

      <div className={`mt-3 space-y-2.5 ${overriding ? "" : "pointer-events-none opacity-45"}`}>
        {EventKind.options.map((kind) => (
          <KindSwitch
            key={kind}
            kind={kind}
            on={effective.has(kind)}
            disabled={busy || !overriding}
            onToggle={() => void toggle(kind)}
          />
        ))}
      </div>

      {!overriding && (
        <p className="mt-3 text-xs text-fog-500">
          Showing your global alerts:{" "}
          {globalKinds.length > 0
            ? globalKinds.map((k) => KIND_LABELS[k as EventKind] ?? k).join(", ")
            : "none"}
          .
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
