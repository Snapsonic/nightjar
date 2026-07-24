import { NightScene } from "@/components/night-scene";
import { IconGitHub } from "@/components/icons";
import { site } from "@/lib/site";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* faint star field behind the hero, pure CSS */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(1px 1px at 12% 22%, #565b76 50%, transparent 51%)," +
            "radial-gradient(1.5px 1.5px at 78% 12%, #464b64 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 55% 38%, #565b76 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 32% 8%, #464b64 50%, transparent 51%)," +
            "radial-gradient(1.5px 1.5px at 92% 42%, #464b64 50%, transparent 51%)",
        }}
      />

      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-16 sm:pt-24 lg:grid-cols-[7fr_5fr] lg:gap-10 lg:pb-28">
        <div>
          <p className="eyebrow animate-rise">
            open-source nvr · optional cloud
          </p>
          <h1 className="animate-rise-1 mt-5 max-w-xl text-balance text-4xl font-semibold leading-[1.06] tracking-tight text-ink-100 sm:text-5xl lg:text-6xl">
            The night watch for your cameras.
          </h1>
          <p className="animate-rise-2 mt-6 max-w-xl text-pretty text-lg leading-relaxed text-ink-300">
            Nightjar is an open-source NVR that records to{" "}
            <em className="not-italic text-ink-100">your</em> disk, streams live
            from anywhere with zero port forwarding, and runs AI detection on
            your own hardware — with an optional cloud that costs half of Nest
            Aware.
          </p>
          <div className="animate-rise-2 mt-9 flex flex-wrap items-center gap-4">
            <a
              href={site.appUrl}
              className="rounded-full bg-ember-500 px-6 py-3 text-[0.95rem] font-medium text-night-950 transition-colors hover:bg-ember-400"
            >
              Start free
            </a>
            <a
              href={site.githubUrl}
              className="inline-flex items-center gap-2.5 rounded-full border border-line px-6 py-3 text-[0.95rem] font-medium text-ink-100 transition-colors hover:border-night-700 hover:bg-night-850"
            >
              <IconGitHub className="h-4.5 w-4.5" />
              Self-host it
            </a>
          </div>
          <p className="mt-6 font-mono text-xs tracking-wide text-ink-500">
            AGPL-3.0 · Works with any RTSP/ONVIF camera
          </p>
        </div>

        <div className="animate-rise-2 lg:justify-self-end">
          <NightScene className="mx-auto w-full max-w-[520px] lg:mx-0" />
        </div>
      </div>
    </section>
  );
}
