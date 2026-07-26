import { ImageResponse } from "next/og";
import { site } from "@/lib/site";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = `${site.name} — ${site.tagline}`;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          backgroundColor: "#0a0c13",
          backgroundImage:
            "radial-gradient(circle at 82% 18%, #171c2e 0%, #0a0c13 55%)",
          color: "#ece9e1",
          fontFamily: "sans-serif",
        }}
      >
        {/* mark + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <svg width="88" height="88" viewBox="0 0 64 64">
            {/* canonical mark — plain shapes only (Satori has no <mask>) */}
            <circle cx="32" cy="32" r="32" fill="#f0a441" />
            <g transform="translate(-8,2)">
              <path d="M30 50 L12.5 44 L28 38 Z" fill="#0a0c13" />
              <path
                d="M27 50 Q27 30 45 27 Q55.5 25.5 56 34 Q56.5 42.5 45 47.5 Q36.5 50.5 27 50 Z"
                fill="#0a0c13"
              />
              <circle cx="50.5" cy="21.5" r="7" fill="#0a0c13" />
              <path d="M56 19 L63.5 21.5 L56 24 Z" fill="#0a0c13" />
            </g>
            <circle cx="44" cy="22" r="2.1" fill="#f0a441" />
          </svg>
          <div style={{ fontSize: 54, fontWeight: 600, letterSpacing: -1.5 }}>
            Nightjar
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              fontSize: 76,
              fontWeight: 600,
              letterSpacing: -2.5,
              lineHeight: 1.05,
              maxWidth: 900,
            }}
          >
            The night watch for your cameras.
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 18,
              fontSize: 28,
              color: "#868a9f",
            }}
          >
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 999,
                backgroundColor: "#f0a441",
              }}
            />
            <div>
              Open-source NVR · your disk, your rules · half of Nest Aware
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 26,
            color: "#676b80",
          }}
        >
          <div>nightjar.ca</div>
          <div>AGPL-3.0 · RTSP/ONVIF</div>
        </div>
      </div>
    ),
    size,
  );
}
