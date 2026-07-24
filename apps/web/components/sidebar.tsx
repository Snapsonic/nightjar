"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";
import { CameraIcon, EventsIcon, GearIcon, PairIcon } from "@/components/icons";
import { Wordmark } from "@/components/wordmark";

interface NavItem {
  href: string;
  label: string;
  icon: (props: { className?: string }) => ReactElement;
  isActive: (pathname: string) => boolean;
}

const NAV: NavItem[] = [
  {
    href: "/",
    label: "Cameras",
    icon: CameraIcon,
    isActive: (p) => p === "/" || p.startsWith("/live"),
  },
  {
    href: "/events",
    label: "Events",
    icon: EventsIcon,
    isActive: (p) => p.startsWith("/events"),
  },
  {
    href: "/pair",
    label: "Pair a node",
    icon: PairIcon,
    isActive: (p) => p.startsWith("/pair"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: GearIcon,
    isActive: (p) => p.startsWith("/settings"),
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop: fixed left rail */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-night-700 bg-night-850/80 backdrop-blur md:flex">
        <div className="px-5 pt-6 pb-8">
          <Link href="/" aria-label="Nightjar home">
            <Wordmark />
          </Link>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3" aria-label="Main">
          {NAV.map((item) => {
            const active = item.isActive(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-night-700 text-ember-300"
                    : "text-fog-300 hover:bg-night-800 hover:text-fog-100"
                }`}
              >
                <Icon
                  className={`h-5 w-5 ${active ? "text-ember-400" : "text-fog-500 group-hover:text-fog-300"}`}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-5 py-5 text-[11px] leading-relaxed text-fog-500">
          Open-source NVR
          <br />
          <a
            href="https://github.com/Snapsonic/nightjar"
            target="_blank"
            rel="noreferrer"
            className="text-fog-400 underline-offset-2 hover:text-ember-300 hover:underline"
          >
            github.com/Snapsonic/nightjar
          </a>
        </div>
      </aside>

      {/* Mobile: bottom tab bar */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-night-700 bg-night-850/95 backdrop-blur md:hidden"
      >
        {NAV.map((item) => {
          const active = item.isActive(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium ${
                active ? "text-ember-300" : "text-fog-400"
              }`}
            >
              <Icon className={`h-5 w-5 ${active ? "text-ember-400" : "text-fog-500"}`} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
