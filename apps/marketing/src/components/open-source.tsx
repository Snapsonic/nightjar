import { Section } from "@/components/section";
import { IconFork, IconGitHub } from "@/components/icons";
import { site } from "@/lib/site";

export function OpenSource() {
  return (
    <Section id="open-source" number="04" eyebrow="open source">
      <div className="grid gap-10 lg:grid-cols-[3fr_2fr] lg:gap-16">
        <div>
          <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
            Security software you can actually read.
          </h2>
          <p className="mt-5 max-w-xl text-pretty leading-relaxed text-ink-300">
            The entire stack — the node, the recorder, the detection pipeline,
            even the cloud dashboard — is AGPL-3.0 on GitHub.{" "}
            <span className="text-ink-100">
              Self-hosting is free forever, including remote live view.
            </span>{" "}
            The paid plans exist to fund development, not to ransom features
            back to you.
          </p>
          <p className="mt-4 max-w-xl text-pretty leading-relaxed text-ink-300">
            If you&apos;ve got opinions about ONVIF quirks, ffmpeg flags, or
            ONNX models, we would genuinely love the company. Issues and pull
            requests are open.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <a
              href={site.githubUrl}
              className="inline-flex items-center gap-2.5 rounded-full border border-line px-6 py-3 text-[0.95rem] font-medium text-ink-100 transition-colors hover:border-night-700 hover:bg-night-850"
            >
              <IconGitHub className="h-4.5 w-4.5" />
              Read the source
            </a>
            <a
              href={`${site.githubUrl}/blob/main/LICENSE`}
              className="inline-flex items-center px-2 py-3 text-[0.95rem] text-ink-500 transition-colors hover:text-ink-100"
            >
              AGPL-3.0 license
            </a>
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-night-900 p-7">
          <IconFork className="h-7 w-7 text-ember-500" />
          <h3 className="mt-5 text-lg font-medium text-ink-100">
            What AGPL means here
          </h3>
          <ul className="mt-4 space-y-3 text-[0.95rem] leading-relaxed text-ink-300">
            <li className="flex gap-3">
              <span aria-hidden="true" className="mt-0.5 text-ember-500">
                ·
              </span>
              You can audit every line that touches your video.
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true" className="mt-0.5 text-ember-500">
                ·
              </span>
              You can run it, modify it, and fork it — no permission needed.
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true" className="mt-0.5 text-ember-500">
                ·
              </span>
              Anyone who runs a modified service for others must share their
              changes back.
            </li>
          </ul>
        </div>
      </div>
    </Section>
  );
}
