"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GdriveStatusPayload } from "@nightjar/shared";
import { NodeChannel, NodeChannelError } from "@/lib/realtime";
import { getBrowserClient } from "@/lib/supabase/client";

export interface DriveNode {
  id: string;
  name: string;
  online: boolean;
}

const DOCS_URL = "https://docs.nightjar.ca/guides/recording-and-events#google-drive-backup";
/** How often the browser re-asks the node whether the code was entered yet. */
const POLL_MS = 5_000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof NodeChannelError ? err.message : fallback;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "4m 20s" / "38s" until `iso`, or null once it has passed. */
function countdown(iso: string, now: number): string | null {
  const left = Date.parse(iso) - now;
  if (!Number.isFinite(left) || left <= 0) return null;
  const totalSec = Math.floor(left / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/**
 * "Google Drive backup" card for one node, driven entirely over the node's
 * realtime channel.
 *
 * The OAuth device flow allows the device that APPROVES a code to differ from
 * the one that shows it, which is what lets this live in the cloud dashboard:
 * the node runs the flow and keeps the tokens on its own disk, and only a
 * short user code plus display state ever crosses the channel.
 */
function DriveBackupCard({ node }: { node: DriveNode }) {
  const [status, setStatus] = useState<GdriveStatusPayload | null>(null);
  const [loading, setLoading] = useState(node.online);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [nonce, setNonce] = useState(0);
  const channelRef = useRef<NodeChannel | null>(null);

  const connecting = status?.status === "connecting";

  useEffect(() => {
    if (!node.online) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const run = async () => {
      try {
        const channel = await NodeChannel.connect(getBrowserClient(), node.id);
        if (cancelled) {
          channel.close();
          return;
        }
        channelRef.current = channel;
        const next = await channel.requestGdriveStatus();
        if (!cancelled) setStatus(next);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Could not reach this node."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();

    return () => {
      cancelled = true;
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [node.id, node.online, nonce]);

  // While a code is pending: poll the node until it flips to connected/error,
  // and tick every second so the expiry countdown stays honest.
  useEffect(() => {
    if (!connecting) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const poll = setInterval(() => {
      const channel = channelRef.current;
      if (!channel) return;
      channel
        .requestGdriveStatus()
        .then((next) => {
          setStatus(next);
          setError(null);
        })
        .catch((err: unknown) => setError(errorMessage(err, "Lost contact with the node.")));
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [connecting]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  /** Runs one channel action, surfacing failures instead of silently no-oping. */
  const act = useCallback(
    async (action: (channel: NodeChannel) => Promise<GdriveStatusPayload>) => {
      const channel = channelRef.current;
      if (!channel) {
        setError("Not connected to this node.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        setStatus(await action(channel));
        setNow(Date.now());
      } catch (err) {
        setError(errorMessage(err, "The node did not accept that."));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const retry = () => {
    setError(null);
    setNonce((n) => n + 1);
  };

  const disconnect = () => {
    if (
      !confirm(
        `Disconnect Google Drive from "${node.name}"? Nightjar revokes its access and deletes ` +
          `the token on the node. Clips already in your Drive stay there.`,
      )
    ) {
      return;
    }
    void act((channel) => channel.requestGdriveDisconnect());
  };

  const timeLeft =
    status?.status === "connecting" && status.expiresAt
      ? countdown(status.expiresAt, now)
      : null;

  return (
    <section className="rounded-2xl border border-night-600 bg-night-850 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-fog-100">Google Drive backup</h2>
        <span className="text-xs text-fog-500">{node.name}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-fog-500">
        Copy every event clip and thumbnail into your own Google Drive. Nightjar can only see
        the files it puts there, and your Google account credentials never leave the node.
      </p>

      <div className="mt-4">
        {!node.online ? (
          <p className="rounded-lg border border-dashed border-night-600 px-3.5 py-3 text-xs text-fog-500">
            This node is offline. Drive backup can be set up once it reconnects.
          </p>
        ) : loading ? (
          <p className="text-xs text-fog-500">Asking the node…</p>
        ) : status === null ? (
          <p className="text-xs text-fog-400">No answer from the node yet.</p>
        ) : status.status === "notConfigured" ? (
          <p className="text-xs leading-relaxed text-fog-400">
            This node&apos;s build has no Google client configured, so it cannot run the Drive
            sign-in flow. Self-hosters can supply their own OAuth client —{" "}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-ember-400 underline-offset-2 hover:underline"
            >
              see the docs
            </a>
            .
          </p>
        ) : status.status === "connecting" ? (
          <div className="rounded-lg border border-night-600 bg-night-800 px-3.5 py-3">
            <p className="text-xs leading-relaxed text-fog-400">
              On any device, open{" "}
              <a
                href={status.verificationUrl ?? "https://google.com/device"}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-ember-400 underline-offset-2 hover:underline"
              >
                {(status.verificationUrl ?? "https://google.com/device").replace(
                  /^https?:\/\//,
                  "",
                )}
              </a>{" "}
              and enter this code:
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {/* select-all so it can be highlighted with one click even where
                  the clipboard API is unavailable (http origins). */}
              <p className="select-all font-mono text-2xl font-semibold tracking-[0.2em] text-fog-100">
                {status.userCode ?? "—"}
              </p>
              {status.userCode && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(status.userCode ?? "")
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false));
                  }}
                  className="rounded-lg border border-night-500 px-2.5 py-1 text-xs font-medium text-fog-300 transition-colors hover:border-fog-500 hover:text-fog-100"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-fog-500">
              {timeLeft
                ? `Expires in ${timeLeft}. Checking every ${POLL_MS / 1000}s…`
                : "This code has expired — start again."}
            </p>
            {!timeLeft && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act((channel) => channel.requestGdriveConnect())}
                className="mt-3 rounded-lg bg-ember-500 px-4 py-2 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400 disabled:opacity-60"
              >
                {busy ? "Starting…" : "Get a new code"}
              </button>
            )}
          </div>
        ) : status.status === "connected" ? (
          <div className="space-y-3">
            <dl className="rounded-lg border border-night-600 bg-night-800 px-3.5 py-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-fog-500">Account</dt>
                <dd className="truncate text-fog-200">{status.email ?? "connected"}</dd>
              </div>
              <div className="mt-1.5 flex justify-between gap-3">
                <dt className="text-fog-500">Folder</dt>
                <dd className="truncate text-fog-200">{status.folderName ?? "Nightjar"}</dd>
              </div>
              <div className="mt-1.5 flex justify-between gap-3">
                <dt className="text-fog-500">Drive storage</dt>
                <dd className="text-fog-200">
                  {status.quota
                    ? status.quota.limitBytes === null
                      ? `${formatBytes(status.quota.usageBytes)} used`
                      : `${formatBytes(status.quota.usageBytes)} used, ` +
                        `${formatBytes(Math.max(0, status.quota.limitBytes - status.quota.usageBytes))} free`
                    : "unknown"}
                </dd>
              </div>
              <div className="mt-1.5 flex justify-between gap-3">
                <dt className="text-fog-500">Waiting to upload</dt>
                <dd className="text-fog-200">
                  {status.queued === 1 ? "1 clip" : `${status.queued ?? 0} clips`}
                </dd>
              </div>
            </dl>

            <DriveToggle
              label="Back up event clips"
              hint="New events are copied to your Drive. Already-recorded events are not backfilled."
              checked={status.enabled ?? false}
              disabled={busy}
              onChange={(value) =>
                void act((channel) => channel.requestGdriveToggle({ enabled: value }))
              }
            />
            <DriveToggle
              label="Make backed-up clips link-shareable"
              hint="Gives each newly backed-up clip an “anyone with the link can view” permission in your Drive, so alerts can link straight to it. Anyone holding that URL can watch the clip, and it applies only to clips uploaded from now on."
              checked={status.shareLinks ?? false}
              disabled={busy}
              onChange={(value) =>
                void act((channel) => channel.requestGdriveToggle({ shareLinks: value }))
              }
            />

            <button
              type="button"
              disabled={busy}
              onClick={disconnect}
              className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
            >
              {busy ? "Working…" : "Disconnect"}
            </button>
          </div>
        ) : (
          // disconnected | error — both offer the same next step.
          <div>
            {status.status === "error" && (
              <p className="mb-3 text-xs text-fog-400">
                Last attempt failed: {status.message ?? "unknown error"}.
              </p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void act((channel) => channel.requestGdriveConnect())}
              className="rounded-lg bg-ember-500 px-4 py-2 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400 disabled:opacity-60"
            >
              {busy ? "Starting…" : "Connect Google Drive"}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
            <button
              type="button"
              onClick={retry}
              className="text-xs font-medium text-ember-400 underline-offset-2 hover:underline"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function DriveToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-lg border border-night-600 bg-night-800 px-3.5 py-2.5">
      <span className="pr-4">
        <span className="block text-sm text-fog-200">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-fog-500">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
          checked ? "bg-ember-500" : "bg-night-500"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-night-950 transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </label>
  );
}

/** One card per paired node — Drive is connected per node, not per account. */
export function DriveBackupCards({ nodes }: { nodes: DriveNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <>
      {nodes.map((node) => (
        <DriveBackupCard key={node.id} node={node} />
      ))}
    </>
  );
}
