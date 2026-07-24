"use client";

import { useState, type ReactNode } from "react";

type FaqItem = {
  question: string;
  answer: ReactNode;
};

const items: readonly FaqItem[] = [
  {
    question: "Do I need the cloud?",
    answer: (
      <>
        No. The node runs entirely on your LAN: 24/7 recording, local live
        view, and AI detection all work without any account. A free cloud
        account adds remote access from anywhere — still $0 — and paid plans
        only add cloud event history and alert extras on top.
      </>
    ),
  },
  {
    question: "Which cameras work?",
    answer: (
      <>
        Anything that speaks RTSP or ONVIF — which is most of the IP camera
        world: Reolink, Amcrest, Hikvision, Dahua, Ubiquiti, Annke, TP-Link
        Vigi, and plenty of no-name PoE cameras. If your camera can hand over
        an RTSP URL, Nightjar can record it.
      </>
    ),
  },
  {
    question: "What hardware do I need for the node?",
    answer: (
      <>
        A small Linux box with Docker: an Intel NUC, a Raspberry Pi 5, or a NAS
        that runs containers. A Pi 5 comfortably handles a handful of cameras;
        a NUC handles a wall of them. WebRTC works best with{" "}
        <code className="rounded bg-night-850 px-1.5 py-0.5 font-mono text-[0.85em]">
          network_mode: host
        </code>
        , so a Linux host is recommended — Docker Desktop on macOS/Windows runs
        but remote live view will be degraded.
      </>
    ),
  },
  {
    question: "Is my video private?",
    answer: (
      <>
        Your 24/7 footage never leaves your disk. If you enable cloud event
        history, only those short event clips are uploaded — encrypted in
        transit and stored in your account&apos;s private bucket, readable only
        by you. And because the whole stack is AGPL-3.0, you don&apos;t have to
        take our word for any of this: the code that touches your video is
        public and auditable.
      </>
    ),
  },
  {
    question: "What about my Nest cameras?",
    answer: (
      <>
        A Nest camera bridge is on the roadmap, built on Google&apos;s Device
        Access (Smart Device Management) API, so existing Nest cameras can sit
        on the same wall as your RTSP ones. Until it ships, Nightjar is for
        cameras that speak open protocols.
      </>
    ),
  },
  {
    question: "Can I cancel anytime?",
    answer: (
      <>
        Yes — paid plans are monthly with no contract. If you cancel, remote
        live view keeps working on the free tier, and your 24/7 recordings are
        untouched because they were never ours to begin with. Cloud event clips
        simply age out on the free tier&apos;s 3-day window.
      </>
    ),
  },
];

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="divide-y divide-line rounded-2xl border border-line bg-night-900">
      {items.map((item, index) => {
        const isOpen = openIndex === index;
        const buttonId = `faq-button-${index}`;
        const panelId = `faq-panel-${index}`;
        return (
          <div key={item.question}>
            <h3>
              <button
                type="button"
                id={buttonId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenIndex(isOpen ? null : index)}
                className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left text-[1.02rem] font-medium text-ink-100 transition-colors hover:text-ember-300"
              >
                {item.question}
                <svg
                  viewBox="0 0 16 16"
                  className={`h-4 w-4 shrink-0 text-ember-500 transition-transform duration-200 ${
                    isOpen ? "rotate-45" : ""
                  }`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M8 2.5v11M2.5 8h11" />
                </svg>
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              data-open={isOpen}
              className="faq-panel"
            >
              <div>
                <p className="px-6 pb-6 text-[0.95rem] leading-relaxed text-ink-300">
                  {item.answer}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
