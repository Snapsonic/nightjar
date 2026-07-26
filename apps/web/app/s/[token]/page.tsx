// Public clip-share page: https://nightjar.ca/s/<token>
//
// Unauthenticated (middleware allowlists /s/). The token is resolved
// server-side through the share-view edge function, which enforces expiry and
// revocation with the service role — this page only ever sees the allowlisted
// public fields (caption, kind, camera name, time, signed clip/thumb URLs).
import type { Metadata } from "next";
import { cache } from "react";
import { NightjarGlyph } from "@/components/wordmark";
import { getSupabaseEnv } from "@/lib/env";
import { formatDateTime, relativeTime } from "@/lib/utils";

interface ShareView {
  caption: string | null;
  kind: string;
  cameraName: string;
  startedAt: string;
  clipUrl: string;
  thumbnailUrl: string | null;
  durationS: number | null;
}

/** cache() dedupes the fetch between generateMetadata and the page render. */
const fetchShare = cache(async (token: string): Promise<ShareView | null> => {
  const { url, anonKey } = getSupabaseEnv();
  try {
    const res = await fetch(
      `${url}/functions/v1/share-view?token=${encodeURIComponent(token)}`,
      { headers: { apikey: anonKey }, cache: "no-store" },
    );
    if (!res.ok) return null;
    return (await res.json()) as ShareView;
  } catch {
    return null;
  }
});

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const share = await fetchShare(token);
  if (!share) {
    return { title: "Clip unavailable — Nightjar", robots: { index: false } };
  }

  const title = `${capitalize(share.kind)} at ${share.cameraName} — Nightjar`;
  const description =
    share.caption ?? `A ${share.kind} event captured by Nightjar, the open-source NVR.`;
  return {
    title,
    description,
    robots: { index: false },
    openGraph: {
      title,
      description,
      type: "video.other",
      siteName: "Nightjar",
      images: share.thumbnailUrl ? [{ url: share.thumbnailUrl }] : undefined,
      videos: [
        {
          url: share.clipUrl,
          type: "video/mp4",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: share.thumbnailUrl ? [share.thumbnailUrl] : undefined,
    },
  };
}

function SharedFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-5 flex items-center gap-2.5">
          <NightjarGlyph className="h-7 w-7 shrink-0" />
          <span className="text-[17px] font-semibold tracking-tight text-fog-100">
            nightjar<span className="text-ember-400">.</span>
          </span>
        </div>
        {children}
        <p className="mt-6 text-center text-xs text-fog-500">
          Recorded with{" "}
          <a
            href="https://nightjar.ca"
            className="text-fog-300 underline decoration-night-500 underline-offset-2 transition-colors hover:text-ember-300"
          >
            Nightjar
          </a>{" "}
          — open-source home security
        </p>
      </div>
    </main>
  );
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const share = await fetchShare(token);

  if (!share) {
    return (
      <SharedFrame>
        <div className="rounded-2xl border border-night-600 bg-night-850 px-6 py-14 text-center">
          <p className="text-lg font-semibold text-fog-100">This clip is no longer available</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-fog-400">
            The link may have expired or been revoked by its owner. Share links keep
            clips private by default — they only live for a limited time.
          </p>
        </div>
      </SharedFrame>
    );
  }

  return (
    <SharedFrame>
      <div className="overflow-hidden rounded-2xl border border-night-600 bg-night-850 shadow-[0_30px_90px_-20px_rgba(0,0,0,0.9)]">
        <div className="relative aspect-video bg-night-950">
          <video
            src={share.clipUrl}
            controls
            playsInline
            preload="metadata"
            poster={share.thumbnailUrl ?? undefined}
            className="absolute inset-0 h-full w-full object-contain"
          />
        </div>
        <div className="px-5 py-4">
          {share.caption && (
            <p className="text-[15px] leading-relaxed text-fog-100">{share.caption}</p>
          )}
          <p className={`text-xs text-fog-500 ${share.caption ? "mt-2" : ""}`}>
            <span className="font-medium capitalize text-fog-300">{share.kind}</span>
            {" · "}
            {share.cameraName}
            {" · "}
            <time dateTime={share.startedAt} title={formatDateTime(share.startedAt)}>
              {relativeTime(share.startedAt)}
            </time>
            {share.durationS !== null ? ` · ${Math.round(share.durationS)}s clip` : ""}
          </p>
        </div>
      </div>
    </SharedFrame>
  );
}
