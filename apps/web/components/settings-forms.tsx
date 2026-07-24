"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { EventKind } from "@nightjar/shared";
import { getBrowserClient } from "@/lib/supabase/client";

/* ---------- display name ---------- */

export function DisplayNameForm({
  userId,
  initialDisplayName,
}: {
  userId: string;
  initialDisplayName: string;
}) {
  const [name, setName] = useState(initialDisplayName);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    setError(null);
    const supabase = getBrowserClient();
    const { error: err } = await supabase
      .from("profiles")
      .update({ display_name: name.trim() || null })
      .eq("id", userId);
    setBusy(false);
    if (err) setError(err.message);
    else setSaved(true);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <label htmlFor="display-name" className="mb-1.5 block text-xs font-medium text-fog-300">
          Display name
        </label>
        <input
          id="display-name"
          value={name}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          placeholder="How should we greet you?"
          className="w-full rounded-lg border border-night-500 bg-night-900 px-3 py-2 text-sm text-fog-100 placeholder:text-fog-500 outline-none transition-colors focus:border-ember-500"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-ember-500 px-4 py-2 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400 disabled:opacity-60"
      >
        {busy ? "Saving…" : saved ? "Saved" : "Save"}
      </button>
      {error && (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/* ---------- plan ---------- */

const PLAN_STYLES: Record<"free" | "plus" | "pro", string> = {
  free: "border-night-500 bg-night-800 text-fog-300",
  plus: "border-ember-500/40 bg-ember-500/10 text-ember-300",
  pro: "border-ember-400/60 bg-ember-500/20 text-ember-200",
};

export function PlanCard({ plan }: { plan: "free" | "plus" | "pro" }) {
  return (
    <section className="rounded-2xl border border-night-600 bg-night-850 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fog-100">Plan</h2>
          <p className="mt-1 text-xs text-fog-500">
            Cloud clip storage and notification limits depend on your plan.
          </p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${PLAN_STYLES[plan]}`}
        >
          {plan}
        </span>
      </div>
      <button
        type="button"
        disabled
        className="mt-4 cursor-not-allowed rounded-lg border border-night-500 px-4 py-2 text-sm font-medium text-fog-500"
        title="Plan management is coming soon"
      >
        Manage plan — coming soon
      </button>
    </section>
  );
}

/* ---------- notification toggles ---------- */

const KIND_LABELS: Record<EventKind, string> = {
  motion: "Motion",
  person: "Person",
  vehicle: "Vehicle",
  animal: "Animal",
  package: "Package",
};

export function NotificationToggles({
  userId,
  initialKinds,
}: {
  userId: string;
  initialKinds: string[];
}) {
  const [kinds, setKinds] = useState<Set<string>>(new Set(initialKinds));
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(kind: EventKind) {
    const next = new Set(kinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);

    const previous = kinds;
    setKinds(next);
    setBusyKind(kind);
    setError(null);

    // camera_id null = the global (all cameras) settings row. The uniqueness
    // of that row is enforced by a NULL-safe expression index, which PostgREST
    // upserts can't target — so select-then-write instead.
    const supabase = getBrowserClient();
    const { data: existing, error: selectErr } = await supabase
      .from("notification_settings")
      .select("id")
      .eq("user_id", userId)
      .is("camera_id", null)
      .maybeSingle();
    const { error: err } = selectErr
      ? { error: selectErr }
      : existing
        ? await supabase.from("notification_settings").update({ kinds: [...next] }).eq("id", existing.id)
        : await supabase
            .from("notification_settings")
            .insert({ user_id: userId, camera_id: null, kinds: [...next] });
    setBusyKind(null);
    if (err) {
      setKinds(previous); // roll back optimistic update
      setError(`Could not save: ${err.message}`);
    }
  }

  return (
    <div>
      <div className="space-y-2.5">
        {EventKind.options.map((kind) => {
          const on = kinds.has(kind);
          return (
            <label
              key={kind}
              className="flex cursor-pointer items-center justify-between rounded-lg border border-night-600 bg-night-800 px-3.5 py-2.5"
            >
              <span className="text-sm text-fog-200">{KIND_LABELS[kind]}</span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`Notify on ${KIND_LABELS[kind].toLowerCase()}`}
                disabled={busyKind !== null}
                onClick={() => void toggle(kind)}
                className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-60 ${
                  on ? "bg-ember-500" : "bg-night-500"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-night-950 transition-all ${
                    on ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
            </label>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/* ---------- sign out ---------- */

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: err } = await supabase.auth.signOut();
    if (err) {
      setBusy(false);
      setError(err.message);
      return;
    }
    router.push("/login");
    router.refresh();
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void handleSignOut()}
        disabled={busy}
        className="rounded-lg border border-danger/40 px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-60"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
