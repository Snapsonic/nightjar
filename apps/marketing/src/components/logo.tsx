type LogoMarkProps = {
  /** Unique per instance so <mask> ids never collide when the logo appears twice on a page. */
  idPrefix: string;
  className?: string;
};

/**
 * The Nightjar mark: a crescent moon over a nightjar perched lengthwise on a
 * branch — the way real nightjars sit — with a single ember eye.
 */
export function LogoMark({ idPrefix, className }: LogoMarkProps) {
  const maskId = `${idPrefix}-crescent`;
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <mask id={maskId}>
        <rect width="64" height="64" fill="white" />
        {/* offset circle carves the crescent */}
        <circle cx="50" cy="10" r="11" fill="black" />
      </mask>
      {/* crescent moon */}
      <circle
        cx="45"
        cy="14"
        r="10.5"
        fill="currentColor"
        opacity="0.9"
        mask={`url(#${maskId})`}
      />
      {/* nightjar, perched lengthwise: blunt head left, long tapered tail right */}
      <path
        d="M12 45.5
           C12.5 37.5 18 32.5 25 32.5
           C30.5 32.5 35 35.5 36.5 39.5
           L56 43.5 L36.5 47.5
           C33.5 51.5 28.5 53.5 22.5 53.5
           L14 53.5
           C13 50.5 12 48.5 12 45.5 Z"
        fill="currentColor"
      />
      {/* the ember eye */}
      <circle cx="21" cy="40.5" r="2" fill="var(--color-ember-500)" />
      {/* the branch */}
      <path
        d="M4 55.5 c 14 -2.5 42 -2.5 56 0.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

type WordmarkProps = {
  idPrefix: string;
  className?: string;
};

/** Mark + wordmark lockup used in the nav and footer. */
export function Wordmark({ idPrefix, className }: WordmarkProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <LogoMark idPrefix={idPrefix} className="h-7 w-7 text-ink-100" />
      <span className="text-[1.05rem] font-semibold tracking-tight text-ink-100">
        Nightjar
      </span>
    </span>
  );
}
