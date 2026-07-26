"use client";

import { useEffect, useState } from "react";
import { EdgeFunctionError, callEdgeFunction } from "@/lib/edge";
import { getBrowserClient } from "@/lib/supabase/client";
import { ShareStatusResponse } from "@nightjar/shared";

const EXPIRY_OPTIONS = [1, 7, 30] as const;

/**
 * Account-level control over public clip sharing. The master switch is
 * enforced by the share-clip function as well as here — turning it off means
 * new links cannot be minted at all, not merely that the button is hidden.
 */
export function SharingSettings({
  userId,
  initialEnabled,
  initialExpiryDays,
}: {
  userId: string;
  initialEnabled: boolean;
  initialExpiryDays: number;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [expiryDays, setExpiryDays] = useState(initialExpiryDays);
  const [activeShares, setActiveShares] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void callEdgeFunction("share-clip", { action: "status" }, ShareStatusResponse)
      .then((status) => {
        if (!cancelled) setActiveShares(status.activeShares);
      })
      .catch(() => {
        /* count is decorative — a failure here shouldn't break the card */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(patch: { sharing_enabled?: boolean; default_share_expiry_days?: number }) {
    setBusy(true);
    setError(null);
    setNote(null);
    const supabase = getBrowserClient();
    const { error: err } = await supabase.from("profiles").update(patch).eq("id", userId);
    setBusy(false);
    if (err) {
      setError(`Could not save: ${err.message}`);
      return false;
    }
    return true;
  }

  async function toggleSharing() {
    const next = !enabled;
    setEnabled(next);
    const ok = await persist({ sharing_enabled: next });
    if (!ok) setEnabled(!next);
  }

  async function chooseExpiry(days: number) {
    const previous = expiryDays;
    setExpiryDays(days);
    const ok = await persist({ default_share_expiry_days: days });
    if (!ok) setExpiryDays(previous);
  }

  async function revokeAll() {
    if (!confirm("Revoke every active share link? Anyone holding one will lose access immediately.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await callEdgeFunction(
        "share-clip",
        { action: "revoke_all" },
        ShareStatusResponse.partial(),
      );
      const revoked = typeof result.revoked === "number" ? result.revoked : 0;
      setActiveShares(0);
      setNote(revoked === 1 ? "1 link revoked." : `${revoked} links revoked.`);
    } catch (err) {
      setError(err instanceof EdgeFunctionError ? err.message : "Could not revoke links.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="flex cursor-pointer items-center justify-between rounded-lg border border-night-600 bg-night-800 px-3.5 py-2.5">
        <span className="pr-4">
          <span className="block text-sm text-fog-200">Allow public share links</span>
          <span className="mt-0.5 block text-xs text-fog-500">
            When off, the Share button disappears and no new links can be created.
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Allow public share links"
          disabled={busy}
          onClick={() => void toggleSharing()}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
            enabled ? "bg-ember-500" : "bg-night-500"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-night-950 transition-all ${
              enabled ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
      </label>

      {enabled && (
        <div className="mt-3 rounded-lg border border-night-600 bg-night-800 px-3.5 py-3">
          <p className="text-xs font-medium text-fog-300">New links expire after</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {EXPIRY_OPTIONS.map((days) => (
              <button
                key={days}
                type="button"
                disabled={busy}
                onClick={() => void chooseExpiry(days)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-60 ${
                  expiryDays === days
                    ? "border-ember-500/60 bg-ember-500/15 text-ember-300"
                    : "border-night-500 text-fog-400 hover:border-fog-500 hover:text-fog-200"
                }`}
              >
                {days === 1 ? "1 day" : `${days} days`}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-fog-500">
          {activeShares === null
            ? "Checking active links…"
            : activeShares === 0
              ? "No active share links."
              : `${activeShares} active share link${activeShares === 1 ? "" : "s"}.`}
        </p>
        <button
          type="button"
          disabled={busy || activeShares === 0}
          onClick={() => void revokeAll()}
          className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
        >
          Revoke all links
        </button>
      </div>

      {note && <p className="mt-2 text-xs text-fog-400">{note}</p>}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
