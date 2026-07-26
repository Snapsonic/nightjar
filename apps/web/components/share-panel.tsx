"use client";

// Share panel inside the event detail modal (roadmap #17 extended):
// AI caption generation (caption-clip), share-link creation with expiry
// (share-clip create), platform buttons, and a manage/revoke list.
//
// Instagram has no web share intent. Where the Web Share API can share files
// (mostly mobile), we fetch the clip and share the actual video — Instagram
// shows up in that sheet. Everywhere else we offer a download + copy-caption
// fallback with a one-line explanation.
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { callEdgeFunction } from "@/lib/edge";
import { relativeTime } from "@/lib/utils";

const CaptionResponse = z.object({
  caption: z.string(),
  safe_to_share: z.boolean(),
  reason: z.string().nullable(),
  fallback: z.boolean(),
});

const CreateResponse = z.object({
  token: z.string(),
  url: z.string(),
  expiresAt: z.string(),
});

const ShareRow = z.object({
  token: z.string(),
  url: z.string(),
  caption: z.string().nullable(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  viewCount: z.number(),
  createdAt: z.string().nullable(),
});
const ListResponse = z.object({ shares: z.array(ShareRow) });
const RevokeResponse = z.object({ revoked: z.boolean() });

type Share = z.infer<typeof ShareRow>;

const EXPIRY_OPTIONS = [1, 7, 30] as const;
type ExpiryDays = (typeof EXPIRY_OPTIONS)[number];

function shareStatus(share: Share): "active" | "revoked" | "expired" {
  if (share.revokedAt) return "revoked";
  if (Date.parse(share.expiresAt) <= Date.now()) return "expired";
  return "active";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function SharePanel({
  eventId,
  clipUrl,
}: {
  eventId: string;
  /** Signed clip URL from the modal player — used for native file sharing / download. */
  clipUrl: string | null;
}) {
  const [caption, setCaption] = useState("");
  const [captionWarning, setCaptionWarning] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [expiryDays, setExpiryDays] = useState<ExpiryDays>(7);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ url: string; token: string } | null>(null);
  const [copied, setCopied] = useState<"url" | "caption" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [canShareFiles, setCanShareFiles] = useState(false);
  const [nativeSharing, setNativeSharing] = useState(false);

  useEffect(() => {
    // Feature-detect file sharing (surfaces Instagram in the native sheet).
    try {
      const probe = new File([""], "probe.mp4", { type: "video/mp4" });
      setCanShareFiles(
        typeof navigator.share === "function" && navigator.canShare?.({ files: [probe] }) === true,
      );
    } catch {
      setCanShareFiles(false);
    }
  }, []);

  const loadShares = useCallback(async () => {
    try {
      const { shares: rows } = await callEdgeFunction("share-clip", { action: "list", eventId }, ListResponse);
      setShares(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load share links.");
    }
  }, [eventId]);

  const generateCaption = async () => {
    setGenerating(true);
    setError(null);
    setCaptionWarning(null);
    try {
      const result = await callEdgeFunction("caption-clip", { eventId }, CaptionResponse);
      setCaption(result.caption);
      if (!result.safe_to_share) {
        setCaptionWarning(
          result.reason ??
            "A person may be identifiable in this clip — double-check before sharing publicly.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate a caption.");
    } finally {
      setGenerating(false);
    }
  };

  const createLink = async () => {
    setCreating(true);
    setError(null);
    try {
      const result = await callEdgeFunction(
        "share-clip",
        {
          action: "create",
          eventId,
          expiresInDays: expiryDays,
          caption: caption.trim() === "" ? undefined : caption.trim(),
        },
        CreateResponse,
      );
      setCreated({ url: result.url, token: result.token });
      if (manageOpen) void loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the share link.");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: string) => {
    setError(null);
    try {
      await callEdgeFunction("share-clip", { action: "revoke", token }, RevokeResponse);
      if (created?.token === token) setCreated(null);
      void loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke the link.");
    }
  };

  const copy = async (kind: "url" | "caption", text: string) => {
    if (await copyText(text)) {
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    }
  };

  const shareVideoFile = async () => {
    if (!clipUrl) return;
    setNativeSharing(true);
    setError(null);
    try {
      const res = await fetch(clipUrl);
      if (!res.ok) throw new Error("Could not download the clip.");
      const blob = await res.blob();
      const file = new File([blob], "nightjar-clip.mp4", { type: "video/mp4" });
      await navigator.share({
        files: [file],
        text: caption.trim() === "" ? undefined : caption.trim(),
      });
    } catch (err) {
      // AbortError = user dismissed the sheet — not an error.
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Could not share the clip.");
      }
    } finally {
      setNativeSharing(false);
    }
  };

  const smallButton =
    "rounded-lg border border-night-500 px-3 py-1.5 text-xs font-medium text-fog-300 transition-colors hover:border-fog-500 hover:text-fog-100 disabled:opacity-50";

  const tweetUrl = created
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(caption.trim())}&url=${encodeURIComponent(created.url)}`
    : null;
  const facebookUrl = created
    ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(created.url)}`
    : null;

  return (
    <div className="border-t border-night-600 px-5 py-4">
      {/* Caption */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-fog-400">Share this clip</p>
        <button type="button" onClick={generateCaption} disabled={generating} className={smallButton}>
          {generating ? "Generating…" : "Generate AI caption"}
        </button>
      </div>
      <textarea
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder="Write a caption, or generate one with AI…"
        rows={2}
        maxLength={500}
        className="mt-2 w-full resize-none rounded-lg border border-night-500 bg-night-900 px-3 py-2 text-sm text-fog-100 placeholder:text-fog-500 focus:border-ember-500/60 focus:outline-none"
      />
      {captionWarning && (
        <p className="mt-1 rounded-lg border border-ember-500/30 bg-ember-500/10 px-3 py-2 text-xs text-ember-300">
          {captionWarning}
        </p>
      )}

      {/* Expiry + create */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-fog-500">Link expires in</span>
        {EXPIRY_OPTIONS.map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => setExpiryDays(days)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              expiryDays === days
                ? "border-ember-500/60 bg-ember-500/15 text-ember-300"
                : "border-night-500 text-fog-400 hover:border-fog-500 hover:text-fog-200"
            }`}
          >
            {days === 1 ? "1 day" : `${days} days`}
          </button>
        ))}
        <button
          type="button"
          onClick={createLink}
          disabled={creating}
          className="ml-auto rounded-lg bg-ember-500 px-3.5 py-1.5 text-xs font-semibold text-night-950 transition-colors hover:bg-ember-400 disabled:opacity-60"
        >
          {creating ? "Creating…" : "Create link"}
        </button>
      </div>

      {/* Created link + platforms */}
      {created && (
        <div className="mt-3 rounded-xl border border-night-600 bg-night-900 p-3">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-xs text-fog-200">{created.url}</code>
            <button type="button" onClick={() => copy("url", created.url)} className={smallButton}>
              {copied === "url" ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {tweetUrl && (
              <a href={tweetUrl} target="_blank" rel="noopener noreferrer" className={smallButton}>
                Share on X
              </a>
            )}
            {facebookUrl && (
              <a href={facebookUrl} target="_blank" rel="noopener noreferrer" className={smallButton}>
                Share on Facebook
              </a>
            )}
            {canShareFiles && clipUrl ? (
              <button type="button" onClick={shareVideoFile} disabled={nativeSharing} className={smallButton}>
                {nativeSharing ? "Preparing…" : "Share video (Instagram…)"}
              </button>
            ) : (
              <>
                {clipUrl && (
                  <a href={clipUrl} download="nightjar-clip.mp4" className={smallButton}>
                    Download clip for Instagram
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => copy("caption", caption)}
                  disabled={caption.trim() === ""}
                  className={smallButton}
                >
                  {copied === "caption" ? "Copied!" : "Copy caption"}
                </button>
              </>
            )}
          </div>
          {!canShareFiles && (
            <p className="mt-2 text-[11px] leading-relaxed text-fog-500">
              Instagram has no web share link — download the clip and post it from the
              Instagram app, caption and all.
            </p>
          )}
        </div>
      )}

      {/* Manage links */}
      <button
        type="button"
        onClick={() => {
          const next = !manageOpen;
          setManageOpen(next);
          if (next && shares === null) void loadShares();
        }}
        className="mt-3 text-xs font-medium text-fog-400 underline decoration-night-500 underline-offset-2 transition-colors hover:text-fog-200"
      >
        {manageOpen ? "Hide links" : "Manage links"}
      </button>
      {manageOpen && (
        <div className="mt-2 space-y-1.5">
          {shares === null ? (
            <p className="text-xs text-fog-500">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="text-xs text-fog-500">No share links for this event yet.</p>
          ) : (
            shares.map((share) => {
              const status = shareStatus(share);
              return (
                <div
                  key={share.token}
                  className="flex items-center gap-3 rounded-lg border border-night-600 bg-night-900 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-fog-200">{share.url}</p>
                    <p className="mt-0.5 text-[11px] text-fog-500">
                      {status === "active"
                        ? `expires ${new Date(share.expiresAt).toLocaleDateString()}`
                        : status}
                      {" · "}
                      {share.viewCount} view{share.viewCount === 1 ? "" : "s"}
                      {share.createdAt ? ` · created ${relativeTime(share.createdAt)}` : ""}
                    </p>
                  </div>
                  {status === "active" && (
                    <button
                      type="button"
                      onClick={() => revoke(share.token)}
                      className="rounded-lg border border-danger/40 px-2.5 py-1 text-[11px] font-medium text-danger transition-colors hover:border-danger hover:bg-danger/10"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
