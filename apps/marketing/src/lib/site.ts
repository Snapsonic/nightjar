export const site = {
  name: "Nightjar",
  tagline: "The night watch for your cameras.",
  description:
    "Nightjar is an open-source NVR that records 24/7 to your own disk, streams live from anywhere with zero port forwarding, and runs AI detection on your own hardware — with an optional cloud that costs half of Nest Aware.",
  url: "https://nightjar.ca",
  appUrl: "https://app.nightjar.ca",
  githubUrl: "https://github.com/Snapsonic/nightjar",
  email: "hello@nightjar.ca",
  company: "Snapsonic",
} as const;

export type NavLink = {
  readonly label: string;
  readonly href: string;
};

export const navLinks: readonly NavLink[] = [
  { label: "Features", href: "/#features" },
  { label: "Open source", href: "/#open-source" },
  { label: "Pricing", href: "/#pricing" },
  { label: "FAQ", href: "/#faq" },
] as const;
