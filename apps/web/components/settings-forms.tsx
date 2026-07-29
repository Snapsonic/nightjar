"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { EventKind } from "@nightjar/shared";
import { getBrowserClient } from "@/lib/supabase/client";
import { parseChannels, type ChannelPrefs, type LinkSource } from "@/lib/utils";

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
  cat: "Cat",
  dog: "Dog",
  package: "Package",
  bear: "Bear",
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

/* ---------- notification channels ---------- */

const E164_RE = /^\+[1-9]\d{7,14}$/;

function ChannelSwitch({
  on,
  disabled,
  label,
  onToggle,
}: {
  on: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
        on ? "bg-ember-500" : "bg-night-500"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-night-950 transition-all ${
          on ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

const LINK_SOURCE_OPTIONS: {
  value: LinkSource;
  label: string;
  hint: string;
  unavailableHint: string;
}[] = [
  {
    value: "nightjar",
    label: "Nightjar link",
    hint: "Expires in 7 days, and you can revoke it any time from the event.",
    unavailableHint: "Expires in 7 days, and you can revoke it any time from the event.",
    },
  {
    value: "drive",
    label: "Google Drive link",
    hint: "Uses your own Drive copy. Anyone with the link can view it, and it does not expire.",
    unavailableHint:
      "Needs Google Drive backup with link sharing turned on in your node's settings — no Drive-backed clips yet.",
  },
];

export function NotificationChannels({
  userId,
  initialChannels,
  initialNotifyEmail,
  initialNotifyPhone,
  accountEmail,
  hasDriveClips,
}: {
  userId: string;
  initialChannels: ChannelPrefs;
  initialNotifyEmail: string;
  initialNotifyPhone: string;
  accountEmail: string;
  /** True when any of this user's clips already has a Drive share URL. */
  hasDriveClips: boolean;
}) {
  const [channels, setChannels] = useState<ChannelPrefs>(initialChannels);
  const [busyChannel, setBusyChannel] = useState<"email" | "sms" | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);

  const [email, setEmail] = useState(initialNotifyEmail);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [phone, setPhone] = useState(initialNotifyPhone);
  const [savedPhone, setSavedPhone] = useState(initialNotifyPhone);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneSaved, setPhoneSaved] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  /**
   * Merge a patch into the global (camera_id null) settings row's channels
   * jsonb. That row's uniqueness is enforced by a NULL-safe expression index
   * which PostgREST upserts can't target — so select-then-write, and re-read
   * the stored jsonb first so we never clobber keys we aren't changing.
   */
  async function writeChannels(patch: Partial<ChannelPrefs>): Promise<string | null> {
    const supabase = getBrowserClient();
    const { data: existing, error: selectErr } = await supabase
      .from("notification_settings")
      .select("id, channels")
      .eq("user_id", userId)
      .is("camera_id", null)
      .maybeSingle();
    if (selectErr) return selectErr.message;
    const merged: ChannelPrefs = { ...parseChannels(existing?.channels), ...patch };
    const { error: err } = existing
      ? await supabase
          .from("notification_settings")
          .update({ channels: merged })
          .eq("id", existing.id)
      : await supabase
          .from("notification_settings")
          .insert({ user_id: userId, camera_id: null, channels: merged });
    return err ? err.message : null;
  }

  async function toggleChannel(channel: "email" | "sms") {
    const next = { ...channels, [channel]: !channels[channel] };
    if (channel === "sms" && next.sms && !savedPhone) {
      setChannelError("Add and save your phone number below before turning on SMS.");
      return;
    }

    const previous = channels;
    setChannels(next);
    setBusyChannel(channel);
    setChannelError(null);

    const message = await writeChannels({ [channel]: next[channel] });
    setBusyChannel(null);
    if (message) {
      setChannels(previous); // roll back optimistic update
      setChannelError(`Could not save: ${message}`);
    }
  }

  /** Clip-link prefs: the on/off switch and the Nightjar-vs-Drive choice. */
  async function saveLinkPrefs(patch: Partial<ChannelPrefs>) {
    const previous = channels;
    setChannels({ ...channels, ...patch });
    setLinkBusy(true);
    setChannelError(null);

    const message = await writeChannels(patch);
    setLinkBusy(false);
    if (message) {
      setChannels(previous);
      setChannelError(`Could not save: ${message}`);
    }
  }

  async function saveEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError("Enter a valid email address, or leave blank to use your account email.");
      return;
    }
    setEmailBusy(true);
    setEmailSaved(false);
    setEmailError(null);
    const supabase = getBrowserClient();
    const { error: err } = await supabase
      .from("profiles")
      .update({ notify_email: trimmed || null })
      .eq("id", userId);
    setEmailBusy(false);
    if (err) setEmailError(err.message);
    else setEmailSaved(true);
  }

  async function savePhone(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = phone.replace(/[\s()-]/g, "");
    if (trimmed && !E164_RE.test(trimmed)) {
      setPhoneError("Enter your number in international format, e.g. +16045551234.");
      return;
    }
    setPhoneBusy(true);
    setPhoneSaved(false);
    setPhoneError(null);
    const supabase = getBrowserClient();
    const { error: err } = await supabase
      .from("profiles")
      .update({ notify_phone: trimmed || null })
      .eq("id", userId);
    setPhoneBusy(false);
    if (err) {
      setPhoneError(err.message);
      return;
    }
    setPhone(trimmed);
    setSavedPhone(trimmed);
    setPhoneSaved(true);
  }

  const rowClass = "rounded-lg border border-night-600 bg-night-800 px-3.5 py-3";
  const inputClass =
    "w-full rounded-lg border border-night-500 bg-night-900 px-3 py-2 text-sm text-fog-100 placeholder:text-fog-500 outline-none transition-colors focus:border-ember-500";
  const saveButtonClass =
    "rounded-lg border border-night-500 px-3.5 py-2 text-sm font-medium text-fog-300 transition-colors hover:bg-night-800 disabled:opacity-60";

  return (
    <div className="space-y-2.5">
      {/* Push: configured per device in its own card below. */}
      <div className={`${rowClass} flex items-center justify-between gap-3`}>
        <div>
          <p className="text-sm text-fog-200">Push</p>
          <p className="mt-0.5 text-xs text-fog-500">Enabled per device.</p>
        </div>
        <a
          href="#push-devices"
          className="text-xs font-medium text-ember-300 transition-colors hover:text-ember-200"
        >
          Manage devices
        </a>
      </div>

      {/* Email */}
      <div className={rowClass}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-fog-200">Email</p>
          <ChannelSwitch
            on={channels.email}
            disabled={busyChannel !== null}
            label="Email alerts"
            onToggle={() => void toggleChannel("email")}
          />
        </div>
        <form onSubmit={saveEmail} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="notify-email" className="mb-1.5 block text-xs font-medium text-fog-300">
              Send to
            </label>
            <input
              id="notify-email"
              type="email"
              value={email}
              maxLength={254}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailSaved(false);
              }}
              placeholder={accountEmail}
              className={inputClass}
            />
          </div>
          <button type="submit" disabled={emailBusy} className={saveButtonClass}>
            {emailBusy ? "Saving…" : emailSaved ? "Saved" : "Save"}
          </button>
          <p className="w-full text-xs text-fog-500">Leave blank to use your account email.</p>
          {emailError && (
            <p role="alert" className="w-full text-xs text-danger">
              {emailError}
            </p>
          )}
        </form>
      </div>

      {/* SMS */}
      <div className={rowClass}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-fog-200">SMS</p>
          <ChannelSwitch
            on={channels.sms}
            disabled={busyChannel !== null}
            label="SMS alerts"
            onToggle={() => void toggleChannel("sms")}
          />
        </div>
        <form onSubmit={savePhone} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="notify-phone" className="mb-1.5 block text-xs font-medium text-fog-300">
              Phone number
            </label>
            <input
              id="notify-phone"
              type="tel"
              value={phone}
              maxLength={20}
              required={channels.sms}
              onChange={(e) => {
                setPhone(e.target.value);
                setPhoneSaved(false);
              }}
              placeholder="+16045551234"
              className={inputClass}
            />
          </div>
          <button type="submit" disabled={phoneBusy} className={saveButtonClass}>
            {phoneBusy ? "Saving…" : phoneSaved ? "Saved" : "Save"}
          </button>
          <p className="w-full text-xs text-fog-500">Text alerts from +1 604 239 6146.</p>
          {phoneError && (
            <p role="alert" className="w-full text-xs text-danger">
              {phoneError}
            </p>
          )}
        </form>
      </div>

      {/* Clip links: what the alert actually points at. */}
      <div className={rowClass}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-fog-200">Include clip links in alerts</p>
            <p className="mt-0.5 text-xs text-fog-500">
              Texts and emails link straight to the clip instead of the events page.
            </p>
          </div>
          <ChannelSwitch
            on={channels.clip_links}
            disabled={linkBusy}
            label="Include clip links in alerts"
            onToggle={() => void saveLinkPrefs({ clip_links: !channels.clip_links })}
          />
        </div>

        {channels.clip_links && (
          <fieldset className="mt-3 space-y-2" disabled={linkBusy}>
            <legend className="sr-only">Which link to send</legend>
            {LINK_SOURCE_OPTIONS.map((option) => {
              // The Drive option needs a Drive-backed clip to point at — the
              // node only writes drive_url when Drive backup AND its
              // link-sharing checkbox are both on.
              const unavailable = option.value === "drive" && !hasDriveClips;
              const selected = channels.link_source === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex gap-2.5 rounded-lg border px-3 py-2.5 ${
                    selected ? "border-ember-500/50 bg-ember-500/5" : "border-night-600 bg-night-850"
                  } ${unavailable ? "opacity-60" : "cursor-pointer"}`}
                >
                  <input
                    type="radio"
                    name="link-source"
                    value={option.value}
                    checked={selected}
                    disabled={unavailable}
                    onChange={() => void saveLinkPrefs({ link_source: option.value })}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-ember-500"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-fog-200">{option.label}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-fog-500">
                      {unavailable ? option.unavailableHint : option.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
      </div>

      {channelError && (
        <p role="alert" className="text-xs text-danger">
          {channelError}
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
