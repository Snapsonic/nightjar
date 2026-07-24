import type { Metadata } from "next";
import Link from "next/link";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms",
  description: "Nightjar terms of service (draft).",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-16 sm:py-24">
      <p className="eyebrow">legal · draft</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
        Terms of service
      </h1>
      <p className="mt-3 font-mono text-xs text-ink-600">
        Draft — last updated July 2026. Plain-language placeholder until a
        formal version ships.
      </p>

      <div className="mt-10 space-y-8 leading-relaxed text-ink-300">
        <section>
          <h2 className="text-lg font-medium text-ink-100">The software</h2>
          <p className="mt-3">
            The Nightjar software is licensed under AGPL-3.0 and is provided
            as-is, without warranty, as that license describes. Self-hosting it
            requires no account and no agreement with us beyond the license.
          </p>
        </section>
        <section>
          <h2 className="text-lg font-medium text-ink-100">
            The cloud service
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              The optional cloud at app.nightjar.ca is operated by{" "}
              {site.company}. Paid plans are billed monthly and can be
              cancelled anytime; access to paid features ends at the close of
              the billing period.
            </li>
            <li>
              The service is young and in early access. We aim for it to be
              reliable, but we do not yet promise a formal uptime SLA.
            </li>
            <li>
              Use Nightjar lawfully: record your own property, respect your
              local recording and privacy laws, and don&apos;t point cameras
              where you have no right to.
            </li>
          </ul>
        </section>
        <section>
          <h2 className="text-lg font-medium text-ink-100">Your content</h2>
          <p className="mt-3">
            Your footage is yours. Uploaded event clips are stored solely to
            provide the service to you and are deleted per your plan&apos;s
            retention window or when you delete them or your account.
          </p>
        </section>
        <section>
          <h2 className="text-lg font-medium text-ink-100">Questions</h2>
          <p className="mt-3">
            Email{" "}
            <a
              href={`mailto:${site.email}`}
              className="text-ember-400 underline underline-offset-4 hover:text-ember-300"
            >
              {site.email}
            </a>
            . A formal version of these terms will replace this draft before
            paid plans leave early access.
          </p>
        </section>
      </div>

      <p className="mt-12">
        <Link
          href="/"
          className="text-sm text-ink-500 transition-colors hover:text-ink-100"
        >
          ← Back to nightjar.ca
        </Link>
      </p>
    </div>
  );
}
