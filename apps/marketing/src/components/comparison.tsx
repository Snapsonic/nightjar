import type { ReactNode } from "react";
import { Section } from "@/components/section";
import { IconCheck, IconDash } from "@/components/icons";

function Yes({ note }: { note?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-100">
      <IconCheck className="h-4 w-4 shrink-0 text-ember-500" />
      <span className="sr-only">Yes</span>
      {note ? <span className="text-ink-300">{note}</span> : null}
    </span>
  );
}

function No() {
  return (
    <span className="inline-flex items-center text-ink-600">
      <IconDash className="h-4 w-4" />
      <span className="sr-only">No</span>
    </span>
  );
}

type Row = {
  label: string;
  free: ReactNode;
  plus: ReactNode;
  pro: ReactNode;
  nest: ReactNode;
  nestPlus: ReactNode;
};

const rows: readonly Row[] = [
  {
    label: "24/7 recording lives on",
    free: <span className="text-ink-100">Your disk</span>,
    plus: <span className="text-ink-100">Your disk</span>,
    pro: <span className="text-ink-100">Your disk</span>,
    nest: "Google's cloud",
    nestPlus: "Google's cloud",
  },
  {
    label: "Event clip history",
    free: "3 days",
    plus: <span className="text-ink-100">30 days</span>,
    pro: <span className="text-ink-100">60 days</span>,
    nest: "30 days",
    nestPlus: "60 days",
  },
  {
    label: "Person · vehicle · animal · package alerts",
    free: <Yes note="free, on your hardware" />,
    plus: <Yes />,
    pro: <Yes />,
    nest: "Paid only",
    nestPlus: "Paid only",
  },
  {
    label: "Works with any camera brand",
    free: <Yes />,
    plus: <Yes />,
    pro: <Yes />,
    nest: "Nest only",
    nestPlus: "Nest only",
  },
  {
    label: "Open source",
    free: <Yes note="AGPL-3.0" />,
    plus: <Yes note="AGPL-3.0" />,
    pro: <Yes note="AGPL-3.0" />,
    nest: <No />,
    nestPlus: <No />,
  },
  {
    label: "Price",
    free: <span className="text-ink-100">$0</span>,
    plus: <span className="text-ink-100">$4.99/mo</span>,
    pro: <span className="text-ink-100">$9.99/mo</span>,
    nest: "$10/mo",
    nestPlus: "$20/mo",
  },
];

export function Comparison() {
  return (
    <Section id="nest-aware" number="03" eyebrow="switching">
      <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
        Leaving Nest Aware?
      </h2>
      <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-ink-300">
        Bring your own cameras and keep your own footage. Here&apos;s how
        Nightjar&apos;s plans line up against Google&apos;s.
      </p>

      <div className="mt-10 overflow-x-auto rounded-2xl border border-line">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <caption className="sr-only">
            Feature comparison of Nightjar Free, Plus, and Pro against Nest
            Aware and Nest Aware Plus
          </caption>
          <thead>
            <tr className="border-b border-line bg-night-900">
              <td aria-hidden="true" className="px-5 py-3" />
              <th
                scope="colgroup"
                colSpan={3}
                className="border-l border-line px-5 py-3 font-mono text-[0.7rem] uppercase tracking-[0.2em] text-ember-500"
              >
                Nightjar
              </th>
              <th
                scope="colgroup"
                colSpan={2}
                className="border-l border-line px-5 py-3 font-mono text-[0.7rem] uppercase tracking-[0.2em] text-ink-500"
              >
                Google
              </th>
            </tr>
            <tr className="border-b border-line bg-night-900">
              <td aria-hidden="true" className="px-5 py-3" />
              <th scope="col" className="border-l border-line px-5 py-3 font-medium text-ink-100">
                Free
              </th>
              <th scope="col" className="px-5 py-3 font-medium text-ink-100">
                Plus
              </th>
              <th scope="col" className="px-5 py-3 font-medium text-ink-100">
                Pro
              </th>
              <th scope="col" className="border-l border-line px-5 py-3 font-medium text-ink-300">
                Nest Aware
              </th>
              <th scope="col" className="px-5 py-3 font-medium text-ink-300">
                Nest Aware Plus
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.label}
                className="border-b border-line last:border-b-0 odd:bg-night-950 even:bg-night-900/50"
              >
                <th
                  scope="row"
                  className="max-w-56 px-5 py-4 font-normal text-ink-300"
                >
                  {row.label}
                </th>
                <td className="border-l border-line px-5 py-4">{row.free}</td>
                <td className="px-5 py-4">{row.plus}</td>
                <td className="px-5 py-4">{row.pro}</td>
                <td className="border-l border-line px-5 py-4 text-ink-500">
                  {row.nest}
                </td>
                <td className="px-5 py-4 text-ink-500">{row.nestPlus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-sm text-ink-500">
        Already own Nest cameras? A Nest camera bridge — via Google&apos;s
        Device Access API — is on the roadmap, so they can join the same wall
        of cameras.
      </p>
    </Section>
  );
}
