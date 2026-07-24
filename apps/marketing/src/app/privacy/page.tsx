import type { Metadata } from "next";
import Link from "next/link";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy",
  description: "Nightjar privacy policy (draft).",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-16 sm:py-24">
      <p className="eyebrow">legal · draft</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
        Privacy policy
      </h1>
      <p className="mt-3 font-mono text-xs text-ink-600">
        Draft — last updated July 2026. A lawyer has not read this yet; a
        human wrote it and means it.
      </p>

      <div className="mt-10 space-y-8 leading-relaxed text-ink-300">
        <section>
          <h2 className="text-lg font-medium text-ink-100">The short version</h2>
          <p className="mt-3">
            Nightjar is built so that we hold as little of your data as
            possible. Your 24/7 footage is recorded to your own disk by
            software you can audit, and it never reaches us.
          </p>
        </section>
        <section>
          <h2 className="text-lg font-medium text-ink-100">
            What the cloud stores, if you use it
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>Your account email and authentication data.</li>
            <li>
              Camera names and node pairing metadata, so remote access works.
            </li>
            <li>
              Event clips — only if you opt into cloud event history. They are
              encrypted in transit and stored in a private bucket scoped to
              your account. We do not watch them, sell them, or train on them.
            </li>
          </ul>
        </section>
        <section>
          <h2 className="text-lg font-medium text-ink-100">
            What we don&apos;t do
          </h2>
          <p className="mt-3">
            No advertising, no selling data, no third-party analytics on this
            site, no access to your continuous recordings — we couldn&apos;t
            look at those even if asked, because they never leave your
            hardware.
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
            </a>{" "}
            and a person will answer. A full, formal policy will replace this
            draft before paid plans leave early access.
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
