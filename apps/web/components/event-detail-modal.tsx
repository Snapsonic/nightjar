"use client";

import { useEffect, useState } from "react";
import type { EventRow } from "@/components/events-feed";
import { KindIcon } from "@/components/icons";
import { SharePanel } from "@/components/share-panel";
import { getBrowserClient } from "@/lib/supabase/client";
import { formatDateTime, formatScore, toEventKind } from "@/lib/utils";

const SIGNED_URL_TTL_SEC = 3600;

type ClipState =
  | { status: "loading" }
  | { status: "ready"; url: string; durationS: number | null }
  | { status: "unavailable"; reason: string }
  | { status: "error"; message: string };

function unavailableReason(clipStatus: EventRow["clip_status"]): string {
  switch (clipStatus) {
    case "local":
      return "The clip is stored on the node and has not been uploaded to the cloud.";
    case "uploading":
      return "The clip is still uploading — check back in a moment.";
    case "expired":
      return "This clip has expired and was removed from cloud storage.";
    default:
      return "No clip was found for this event.";
  }
}

export function EventDetailModal({
  event,
  cameraName,
  thumbUrl,
  onClose,
}: {
  event: EventRow;
  cameraName: string;
  thumbUrl: string | undefined;
  onClose: () => void;
}) {
  const [clip, setClip] = useState<ClipState>({ status: "loading" });
  const [showShare, setShowShare] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (event.clip_status !== "uploaded") {
        setClip({ status: "unavailable", reason: unavailableReason(event.clip_status) });
        return;
      }
      const supabase = getBrowserClient();
      const { data: clipRow, error: clipError } = await supabase
        .from("event_clips")
        .select("storage_path, duration_s")
        .eq("event_id", event.id)
        .maybeSingle();

      if (cancelled) return;
      if (clipError) {
        setClip({ status: "error", message: clipError.message });
        return;
      }
      if (!clipRow) {
        setClip({ status: "unavailable", reason: unavailableReason("uploaded") });
        return;
      }

      const { data: signed, error: signError } = await supabase.storage
        .from("event-clips")
        .createSignedUrl(clipRow.storage_path, SIGNED_URL_TTL_SEC);

      if (cancelled) return;
      if (signError || !signed) {
        setClip({ status: "error", message: signError?.message ?? "Could not sign the clip URL." });
        return;
      }
      setClip({ status: "ready", url: signed.signedUrl, durationS: clipRow.duration_s });
    };

    setClip({ status: "loading" });
    void run();
    return () => {
      cancelled = true;
    };
  }, [event.id, event.clip_status]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-night-950/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Event detail — ${cameraName}`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-night-600 bg-night-850 shadow-[0_30px_90px_-20px_rgba(0,0,0,0.9)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative aspect-video bg-night-950">
          {clip.status === "ready" ? (
            <video
              src={clip.url}
              autoPlay
              playsInline
              controls
              poster={thumbUrl}
              className="absolute inset-0 h-full w-full object-contain"
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              {thumbUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumbUrl}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover opacity-25"
                />
              )}
              {clip.status === "loading" ? (
                <div className="relative h-7 w-7 animate-spin rounded-full border-2 border-night-500 border-t-ember-400" />
              ) : (
                <p
                  className={`relative max-w-sm text-sm ${
                    clip.status === "error" ? "text-danger" : "text-fog-300"
                  }`}
                >
                  {clip.status === "error" ? `Could not load clip: ${clip.message}` : clip.reason}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-night-700 text-ember-400">
              <KindIcon kind={toEventKind(event.kind)} className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold capitalize text-fog-100">
                {event.kind} · {cameraName}
              </p>
              <p className="text-xs text-fog-500">
                {formatDateTime(event.started_at)} · confidence {formatScore(event.score)}
                {clip.status === "ready" && clip.durationS !== null
                  ? ` · ${Math.round(clip.durationS)}s clip`
                  : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {event.clip_status === "uploaded" && (
              <button
                type="button"
                onClick={() => setShowShare((open) => !open)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  showShare
                    ? "border-ember-500/60 bg-ember-500/15 text-ember-300"
                    : "border-night-500 text-fog-300 hover:border-fog-500 hover:text-fog-100"
                }`}
              >
                Share
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-night-500 px-3 py-1.5 text-xs font-medium text-fog-300 transition-colors hover:border-fog-500 hover:text-fog-100"
            >
              Close
            </button>
          </div>
        </div>

        {showShare && (
          <SharePanel
            eventId={event.id}
            clipUrl={clip.status === "ready" ? clip.url : null}
          />
        )}
      </div>
    </div>
  );
}
