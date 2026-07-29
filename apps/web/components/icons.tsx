import type { ReactElement } from "react";
import type { EventKind } from "@nightjar/shared";

type IconProps = { className?: string };

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function CameraIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <rect x="2.5" y="6" width="14" height="12" rx="2.5" />
      <path d="M16.5 10.5 21.5 7.5 v9 l-5 -3" />
    </svg>
  );
}

export function EventsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <path d="M3 12 h4 l2.5 -6 3.5 12 2.5 -6 H21" />
    </svg>
  );
}

export function PairIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M6.3 6.3 a8 8 0 0 0 0 11.4 M17.7 6.3 a8 8 0 0 1 0 11.4" />
      <path d="M12 15.2 V21" />
    </svg>
  );
}

export function GearIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.22.51.72.87 1.28.92H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.08Z" />
    </svg>
  );
}

export function LiveIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
      <path d="M7.7 16.3 a6 6 0 0 1 0 -8.6 M16.3 7.7 a6 6 0 0 1 0 8.6" />
      <path d="M4.9 19.1 a10 10 0 0 1 0 -14.2 M19.1 4.9 a10 10 0 0 1 0 14.2" />
    </svg>
  );
}

export function HistoryIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <path d="M4.5 5.5 v4 h4" />
      <path d="M4.9 13.5 a8 8 0 1 0 1 -6.2 l-1.4 2.2" />
      <path d="M12 8.5 V12.5 l2.8 1.8" />
    </svg>
  );
}

/* ---- event kind icons ---- */

function MotionIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <path d="M3 8 c2 -2 4 -2 6 0 s4 2 6 0 s4 -2 6 0 M3 16 c2 -2 4 -2 6 0 s4 2 6 0 s4 -2 6 0" />
    </svg>
  );
}

function PersonIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <circle cx="12" cy="7" r="3.2" />
      <path d="M5.5 20.5 a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}

function VehicleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <path d="M4 16 v-4 l2 -5 h12 l2 5 v4 M4 12 h16" />
      <circle cx="7.5" cy="16.5" r="1.8" />
      <circle cx="16.5" cy="16.5" r="1.8" />
    </svg>
  );
}

function AnimalIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <circle cx="7" cy="8.5" r="1.7" />
      <circle cx="12" cy="6.5" r="1.7" />
      <circle cx="17" cy="8.5" r="1.7" />
      <path d="M8.2 18.5 c0 -2.6 1.6 -4.8 3.8 -4.8 s3.8 2.2 3.8 4.8 c0 1.4 -1.1 2 -2.2 1.6 a4.6 4.6 0 0 0 -3.2 0 c-1.1 .4 -2.2 -.2 -2.2 -1.6 Z" />
    </svg>
  );
}

function CatIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      {/* pointed ears + whiskers — the silhouette that reads "cat" at 16px */}
      <path d="M6 10 L5.2 5.6 L8.8 7.6" />
      <path d="M18 10 L18.8 5.6 L15.2 7.6" />
      <path d="M6 10.6 a6 5.4 0 0 0 12 0" />
      <circle cx="9.6" cy="12.4" r="0.6" />
      <circle cx="14.4" cy="12.4" r="0.6" />
      <path d="M3.6 14.2 h3.4 M17 14.2 h3.4" />
    </svg>
  );
}

function DogIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      {/* floppy ears + muzzle */}
      <path d="M6.4 7.4 a2.4 3.4 0 0 0 -1.8 5.6" />
      <path d="M17.6 7.4 a2.4 3.4 0 0 1 1.8 5.6" />
      <path d="M6.4 10 a5.6 5.2 0 0 0 11.2 0 a5.6 5.2 0 0 0 -11.2 0 Z" />
      <circle cx="9.8" cy="11.4" r="0.6" />
      <circle cx="14.2" cy="11.4" r="0.6" />
      <path d="M12 13.4 v1.4 M10.6 16 a1.8 1.4 0 0 0 2.8 0" />
    </svg>
  );
}

function PackageIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <path d="M12 3 20 7.5 v9 L12 21 4 16.5 v-9 Z" />
      <path d="M4 7.5 12 12 l8 -4.5 M12 12 v9" />
    </svg>
  );
}

function BearIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...stroke}>
      <circle cx="6.5" cy="7" r="2.2" />
      <circle cx="17.5" cy="7" r="2.2" />
      <path d="M12 5.2 c4.2 0 6.8 2.9 6.8 6.6 0 4 -3 7 -6.8 7 s-6.8 -3 -6.8 -7 c0 -3.7 2.6 -6.6 6.8 -6.6 Z" />
      <circle cx="9.5" cy="11.5" r="0.6" />
      <circle cx="14.5" cy="11.5" r="0.6" />
      <path d="M10.8 15 a1.6 1.2 0 0 0 2.4 0" />
    </svg>
  );
}

const KIND_ICONS: Record<EventKind, (props: IconProps) => ReactElement> = {
  motion: MotionIcon,
  person: PersonIcon,
  vehicle: VehicleIcon,
  animal: AnimalIcon,
  cat: CatIcon,
  dog: DogIcon,
  package: PackageIcon,
  bear: BearIcon,
};

export function KindIcon({ kind, className }: { kind: EventKind; className?: string }) {
  const Icon = KIND_ICONS[kind];
  return <Icon className={className} />;
}
