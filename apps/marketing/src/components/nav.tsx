"use client";

import { useState } from "react";
import Link from "next/link";
import { Wordmark } from "@/components/logo";
import { IconGitHub } from "@/components/icons";
import { navLinks, site } from "@/lib/site";

export function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-night-950/85 backdrop-blur-md">
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5"
      >
        <Link
          href="/"
          className="shrink-0 rounded-sm"
          aria-label="Nightjar home"
          onClick={() => setOpen(false)}
        >
          <Wordmark idPrefix="nav" />
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-ink-300 transition-colors hover:text-ink-100"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-4 md:flex">
          <a
            href={site.githubUrl}
            className="text-ink-500 transition-colors hover:text-ink-100"
            aria-label="Nightjar on GitHub"
          >
            <IconGitHub className="h-5 w-5" />
          </a>
          <a
            href={site.appUrl}
            className="rounded-full bg-ember-500 px-4 py-2 text-sm font-medium text-night-950 transition-colors hover:bg-ember-400"
          >
            Open the app
          </a>
        </div>

        {/* Mobile controls */}
        <div className="flex items-center gap-4 md:hidden">
          <a
            href={site.githubUrl}
            className="text-ink-500 transition-colors hover:text-ink-100"
            aria-label="Nightjar on GitHub"
          >
            <IconGitHub className="h-5 w-5" />
          </a>
          <button
            type="button"
            className="-mr-1 flex h-10 w-10 items-center justify-center rounded-md text-ink-100"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              aria-hidden="true"
            >
              {open ? (
                <path d="m6 6 12 12M18 6 6 18" />
              ) : (
                <path d="M4 7.5h16M4 12h16M4 16.5h16" />
              )}
            </svg>
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      <div
        id="mobile-menu"
        hidden={!open}
        className="border-t border-line bg-night-950 md:hidden"
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-4">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-2 py-2.5 text-[0.95rem] text-ink-300 hover:bg-night-850 hover:text-ink-100"
              onClick={() => setOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <a
            href={site.appUrl}
            className="mt-2 rounded-full bg-ember-500 px-4 py-2.5 text-center text-sm font-medium text-night-950 hover:bg-ember-400"
          >
            Open the app
          </a>
        </div>
      </div>
    </header>
  );
}
