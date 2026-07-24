import { Section } from "@/components/section";
import { IconCheck } from "@/components/icons";
import { site } from "@/lib/site";

type Plan = {
  name: string;
  price: string;
  cadence: string;
  badge?: string;
  blurb: string;
  features: readonly string[];
  cta: { label: string; href: string };
  featured?: boolean;
};

const plans: readonly Plan[] = [
  {
    name: "Free",
    price: "$0",
    cadence: "forever",
    blurb: "Everything you need to watch your own house from anywhere.",
    features: [
      "Unlimited cameras",
      "24/7 local recording on your disk",
      "Remote live view, zero port forwarding",
      "AI detection on your hardware",
      "3-day cloud event history",
    ],
    cta: { label: "Start free", href: site.appUrl },
  },
  {
    name: "Plus",
    price: "$4.99",
    cadence: "/mo",
    badge: "Early access",
    blurb: "Longer memory and smarter mornings.",
    features: [
      "Everything in Free",
      "30-day cloud event clips",
      "Smart alerts (person, vehicle, animal, package)",
      "AI daily digest of what happened overnight",
    ],
    cta: { label: "Get early access", href: site.appUrl },
    featured: true,
  },
  {
    name: "Pro",
    price: "$9.99",
    cadence: "/mo",
    badge: "Early access",
    blurb: "For big camera walls and long tails of history.",
    features: [
      "Everything in Plus",
      "60-day cloud event clips",
      "Familiar faces — coming",
      "Priority TURN relay for tricky networks",
    ],
    cta: { label: "Get early access", href: site.appUrl },
  },
];

export function Pricing() {
  return (
    <Section id="pricing" number="05" eyebrow="pricing">
      <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
        Half of Nest Aware. None of the lock-in.
      </h2>
      <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-ink-300">
        Self-hosting is free forever. Paid plans add cloud event history and
        alert niceties — and fund the project.
      </p>

      <div className="mt-12 grid gap-5 lg:grid-cols-3">
        {plans.map((plan) => (
          <article
            key={plan.name}
            className={`flex flex-col rounded-2xl border p-7 ${
              plan.featured
                ? "border-ember-600 bg-night-850"
                : "border-line bg-night-900"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-medium text-ink-100">{plan.name}</h3>
              {plan.badge ? (
                <span className="rounded-full border border-ember-600 px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-[0.15em] text-ember-400">
                  {plan.badge}
                </span>
              ) : null}
            </div>
            <p className="mt-4 flex items-baseline gap-1.5">
              <span className="text-4xl font-semibold tracking-tight text-ink-100">
                {plan.price}
              </span>
              <span className="text-sm text-ink-500">{plan.cadence}</span>
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink-300">
              {plan.blurb}
            </p>
            <ul className="mt-6 flex-1 space-y-3">
              {plan.features.map((feature) => (
                <li
                  key={feature}
                  className="flex gap-3 text-[0.9rem] leading-snug text-ink-300"
                >
                  <IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-ember-500" />
                  {feature}
                </li>
              ))}
            </ul>
            <a
              href={plan.cta.href}
              className={`mt-8 rounded-full px-5 py-2.5 text-center text-sm font-medium transition-colors ${
                plan.featured
                  ? "bg-ember-500 text-night-950 hover:bg-ember-400"
                  : "border border-line text-ink-100 hover:border-night-700 hover:bg-night-850"
              }`}
            >
              {plan.cta.label}
            </a>
          </article>
        ))}
      </div>

      <p className="mt-6 text-sm text-ink-500">
        All prices in USD (yes, even though we&apos;re Canadian). Billed
        monthly. Cancel anytime — your recordings are on your disk either way.
      </p>
    </Section>
  );
}
