import Link from "next/link";
import { Wordmark } from "@/components/logo";
import { IconGitHub } from "@/components/icons";
import { site } from "@/lib/site";

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-14 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href="/" className="inline-block rounded-sm" aria-label="Nightjar home">
            <Wordmark idPrefix="footer" />
          </Link>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-500">
            Built by {site.company} in Canada. Watching quietly since the small
            hours.
          </p>
        </div>

        <div className="flex flex-col gap-6 text-sm sm:flex-row sm:gap-14">
          <nav aria-label="Project">
            <h2 className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-ink-600">
              Project
            </h2>
            <ul className="mt-4 space-y-3">
              <li>
                <a
                  href={site.githubUrl}
                  className="inline-flex items-center gap-2 text-ink-300 transition-colors hover:text-ink-100"
                >
                  <IconGitHub className="h-4 w-4" />
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href={`mailto:${site.email}`}
                  className="text-ink-300 transition-colors hover:text-ink-100"
                >
                  {site.email}
                </a>
              </li>
            </ul>
          </nav>
          <nav aria-label="Legal">
            <h2 className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-ink-600">
              Legal
            </h2>
            <ul className="mt-4 space-y-3">
              <li>
                <Link
                  href="/privacy"
                  className="text-ink-300 transition-colors hover:text-ink-100"
                >
                  Privacy
                </Link>
              </li>
              <li>
                <Link
                  href="/terms"
                  className="text-ink-300 transition-colors hover:text-ink-100"
                >
                  Terms
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </div>
      <div className="border-t border-line">
        <p className="mx-auto max-w-6xl px-5 py-6 font-mono text-xs text-ink-600">
          © 2026 {site.company} · Nightjar is AGPL-3.0
        </p>
      </div>
    </footer>
  );
}
