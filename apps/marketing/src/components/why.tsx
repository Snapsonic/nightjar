import type { ComponentType, SVGProps } from "react";
import { Section } from "@/components/section";
import { IconEye, IconHomeDisk, IconSingleLink } from "@/components/icons";

type Reason = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
};

const reasons: readonly Reason[] = [
  {
    icon: IconHomeDisk,
    title: "Your footage stays home",
    body: "Every camera records 24/7 to a disk you own — a NAS, a NUC, a Pi with a big SSD. The cloud only ever receives the event clips you explicitly opt into. Nothing else leaves your network.",
  },
  {
    icon: IconSingleLink,
    title: "Zero port forwarding",
    body: "Your node keeps a single outbound WebRTC link. No open ports, no dynamic DNS, no VPN gymnastics. Remote live view flows peer-to-peer, straight from your house to your phone.",
  },
  {
    icon: IconEye,
    title: "AI without fees",
    body: "Person, vehicle, animal, and package detection runs on your own hardware. No per-camera inference bill, no alerts held hostage behind a subscription. It just watches.",
  },
];

export function Why() {
  return (
    <Section id="features" number="01" eyebrow="why nightjar">
      <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
        Nightjars perch motionless and watch all night. So does this one.
      </h2>
      <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
        {reasons.map((reason) => (
          <article key={reason.title} className="bg-night-900 p-7">
            <reason.icon className="h-7 w-7 text-ember-500" />
            <h3 className="mt-5 text-lg font-medium text-ink-100">
              {reason.title}
            </h3>
            <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-300">
              {reason.body}
            </p>
          </article>
        ))}
      </div>
    </Section>
  );
}
