type LogoMarkProps = {
  /** Kept for call-site compatibility; the mark no longer uses <mask> ids. */
  idPrefix?: string;
  className?: string;
};

/**
 * The Nightjar mark: a nightjar perched in silhouette against a full amber
 * moon, with a single ember eye. Canonical across the marketing site, the app,
 * the docs, and every favicon — the bird is cut from the night background, so
 * the mark only needs one accent color and stays legible at 16px.
 *
 * The crescent is a plain path (not a masked circle) so it also renders in
 * Satori for OpenGraph images, which has no <mask> support.
 */
export function LogoMark({ className }: LogoMarkProps) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <circle cx="32" cy="32" r="32" fill="var(--color-ember-500)" />
      <g fill="var(--color-night-950)" transform="translate(-8,2)">
        <path d="M30 50 L12.5 44 L28 38 Z" />
        <path d="M27 50 Q27 30 45 27 Q55.5 25.5 56 34 Q56.5 42.5 45 47.5 Q36.5 50.5 27 50 Z" />
        <circle cx="50.5" cy="21.5" r="7" />
        <path d="M56 19 L63.5 21.5 L56 24 Z" />
      </g>
      <circle cx="44" cy="22" r="2.1" fill="var(--color-ember-500)" />
    </svg>
  );
}

type WordmarkProps = {
  /** Kept for call-site compatibility. */
  idPrefix?: string;
  className?: string;
};

/** Mark + wordmark lockup used in the nav and footer. */
export function Wordmark({ className }: WordmarkProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <LogoMark className="h-7 w-7" />
      <span className="text-[1.05rem] font-semibold tracking-tight text-ink-100">
        Nightjar
      </span>
    </span>
  );
}
