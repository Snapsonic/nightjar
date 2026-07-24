/** Crescent moon with a nightjar slipping across it — the Nightjar glyph. */
export function NightjarGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden="true">
      {/* Crescent moon */}
      <path
        d="M 23.5 4.2 A 13 13 0 1 0 23.5 27.8 A 10.2 10.2 0 1 1 23.5 4.2 Z"
        fill="var(--color-night-500)"
      />
      {/* Nightjar in flight */}
      <path
        d="M 6.5 19.5
           C 10 14.5 14.2 13.6 17.4 15.4
           C 20 16.9 23.4 16.4 26 13.8
           C 25.2 18.8 21.4 21.6 17 21.1
           C 13.4 20.7 9.6 21.4 6.5 23.6
           C 6.9 22.1 7.6 20.9 8.7 19.9
           Z"
        fill="var(--color-ember-400)"
      />
      {/* Eye glint */}
      <circle cx="24.6" cy="15" r="1" fill="var(--color-night-900)" />
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
