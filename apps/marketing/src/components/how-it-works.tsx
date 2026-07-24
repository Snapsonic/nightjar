import type { ReactNode } from "react";
import { Section } from "@/components/section";

type Step = {
  number: string;
  title: string;
  body: ReactNode;
  diagram: ReactNode;
};

/** Shared style for the little step diagrams. */
const diagramProps = {
  viewBox: "0 0 200 120",
  className: "h-28 w-full",
  fill: "none",
  stroke: "#4b506a",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const steps: readonly Step[] = [
  {
    number: "1",
    title: "Run one docker compose",
    body: (
      <>
        On a NUC, a NAS, or a Pi 5 — any Linux box that runs Docker. One
        command pulls the node, the recorder, and the local UI. You have live
        view on your LAN in minutes.
      </>
    ),
    diagram: (
      <svg {...diagramProps}>
        {/* terminal window */}
        <rect x="30" y="18" width="140" height="84" rx="8" />
        <path d="M30 38h140" />
        <circle cx="44" cy="28" r="2.4" />
        <circle cx="54" cy="28" r="2.4" />
        {/* prompt line */}
        <path d="M44 56l8 6-8 6" stroke="var(--color-ember-500)" />
        <path d="M60 62h64" />
        {/* container blocks appearing */}
        <rect x="44" y="76" width="22" height="14" rx="3" />
        <rect x="72" y="76" width="22" height="14" rx="3" />
        <rect x="100" y="76" width="22" height="14" rx="3" stroke="var(--color-ember-500)" />
      </svg>
    ),
  },
  {
    number: "2",
    title: "Add your RTSP cameras",
    body: (
      <>
        Paste an RTSP URL or let ONVIF discovery find them — Reolink, Amcrest,
        Hikvision, Dahua, Ubiquiti, and anything else that speaks the open
        protocols. If it streams, it works.
      </>
    ),
    diagram: (
      <svg {...diagramProps}>
        {/* camera */}
        <path d="m24 48 44-18 9 21-44 18-9-21Z" />
        <path d="M77 41l12-5v19l-9-2.5" />
        <path d="M46 71 44 86h20" />
        {/* stream waves */}
        <path d="M104 52c6 6 6 14 0 20" />
        <path d="M114 44c10 10 10 26 0 36" opacity="0.7" />
        <path d="M124 36c14 14 14 38 0 52" opacity="0.4" />
        {/* node disk */}
        <rect x="146" y="46" width="34" height="30" rx="6" stroke="var(--color-ember-500)" />
        <circle cx="163" cy="61" r="7" stroke="var(--color-ember-500)" />
        <circle cx="163" cy="61" r="1.4" fill="var(--color-ember-500)" stroke="none" />
      </svg>
    ),
  },
  {
    number: "3",
    title: "Pair with a 6-letter code",
    body: (
      <>
        Create a free account at app.nightjar.ca and type the code shown in
        your local UI. Your cameras are now with you anywhere — still with zero
        ports open, still recording at home.
      </>
    ),
    diagram: (
      <svg {...diagramProps}>
        {/* code cells */}
        {["N", "I", "G", "H", "T", "J"].map((letter, i) => (
          <g key={letter + String(i)}>
            <rect
              x={22 + i * 22}
              y="34"
              width="18"
              height="24"
              rx="4"
              stroke={i < 3 ? "var(--color-ember-500)" : undefined}
            />
            <text
              x={31 + i * 22}
              y="51"
              textAnchor="middle"
              fontFamily="ui-monospace, Menlo, monospace"
              fontSize="12"
              fill={i < 3 ? "var(--color-ember-400)" : "#868a9f"}
              stroke="none"
            >
              {letter}
            </text>
          </g>
        ))}
        {/* arc from house to phone */}
        <path d="M46 92c24-22 84-22 108-2" strokeDasharray="4 5" />
        <path d="m30 92 12-10 12 10v12H30V92Z" />
        <rect x="154" y="84" width="20" height="30" rx="4" />
        <path d="M161 108h6" />
      </svg>
    ),
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works" number="02" eyebrow="how it works">
      <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
        Up and watching in an evening.
      </h2>
      <ol className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-8">
        {steps.map((step) => (
          <li key={step.number}>
            <div className="rounded-2xl border border-line bg-night-900 p-4">
              {step.diagram}
            </div>
            <h3 className="mt-6 flex items-baseline gap-3 text-lg font-medium text-ink-100">
              <span className="font-mono text-sm text-ember-500">
                {step.number}.
              </span>
              {step.title}
            </h3>
            <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-300">
              {step.body}
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-10 rounded-xl border border-line bg-night-900 px-5 py-4 font-mono text-[0.8rem] leading-relaxed text-ink-500">
        <span className="text-ember-500">$</span> curl -fsSLO
        https://raw.githubusercontent.com/Snapsonic/nightjar/main/docker/docker-compose.yml{" "}
        <span className="text-ink-600">&amp;&amp;</span> docker compose up -d
      </p>
    </Section>
  );
}
