import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Hand-drawn minimal line icons, 24×24, 1.6px stroke.
 * All decorative — callers pair them with visible text.
 */

function base(props: IconProps) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...props,
  } as const;
}

/** A house with a spinning disk inside — footage stays home. */
export function IconHomeDisk(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 10.5 12 4l8 6.5V20H4v-9.5Z" />
      <circle cx="12" cy="14" r="3.4" />
      <circle cx="12" cy="14" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** One outbound thread through the wall — zero port forwarding. */
export function IconSingleLink(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 4v16" />
      <path d="M8 4v5.2M8 14.8V20" />
      <path d="M8 12h9" />
      <path d="M14.5 9.5 17 12l-2.5 2.5" />
      <circle cx="20" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** An open eye with an ember pupil — detection that watches locally. */
export function IconEye(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" />
      <circle
        cx="12"
        cy="12"
        r="2.2"
        fill="var(--color-ember-500)"
        stroke="none"
      />
    </svg>
  );
}

/** Stacked layers — one docker compose. */
export function IconStack(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
    </svg>
  );
}

/** A bullet camera on its mount. */
export function IconCamera(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m3 9.5 12-5 2.4 5.7-12 5L3 9.5Z" />
      <path d="M17.4 8.2 20 7v5l-2-.5" />
      <path d="M8.5 14.7 8 18h5" />
      <path d="M6 18h9" />
    </svg>
  );
}

/** Pairing code ticket. */
export function IconPairCode(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M7 11.5v1M10.4 11.5v1M13.8 11.5v1M17.2 11.5v1" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

export function IconDash(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 12h10" />
    </svg>
  );
}

/** Branching fork — open source. */
export function IconFork(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="7" cy="5.5" r="2.2" />
      <circle cx="17" cy="5.5" r="2.2" />
      <circle cx="12" cy="18.5" r="2.2" />
      <path d="M7 7.7v1.3c0 2 1.5 3 3.5 3h3c2 0 3.5-1 3.5-3V7.7" />
      <path d="M12 12v4.3" />
    </svg>
  );
}

/** The GitHub mark (filled, official path). */
export function IconGitHub(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable={false}
      {...props}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 12h15" />
      <path d="m13.5 6.5 5.5 5.5-5.5 5.5" />
    </svg>
  );
}
