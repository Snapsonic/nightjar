/**
 * The Nightjar mark: a nightjar in silhouette against a full amber moon.
 * Canonical across marketing, app, docs, and favicons.
 */
export function NightjarGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <circle cx="32" cy="32" r="27" fill="var(--color-ember-500)" />
      <g fill="var(--color-night-950)">
        <path d="M30 50 L12.5 44 L28 38 Z" />
        <path d="M27 50 Q27 30 45 27 Q55.5 25.5 56 34 Q56.5 42.5 45 47.5 Q36.5 50.5 27 50 Z" />
        <circle cx="50.5" cy="21.5" r="7" />
        <path d="M56 19 L63.5 21.5 L56 24 Z" />
      </g>
      <circle cx="52" cy="20" r="2.1" fill="var(--color-ember-500)" />
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <NightjarGlyph className="h-7 w-7 shrink-0" />
      {!compact && (
        <span className="text-[17px] font-semibold tracking-tight text-fog-100">
          nightjar
          <span className="text-ember-400">.</span>
        </span>
      )}
    </span>
  );
}
