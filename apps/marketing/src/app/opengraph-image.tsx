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
            {/* crescent drawn as a single two-arc path — Satori has no <mask> support */}
            <path
              d="M46 3.5 A 10.5 10.5 0 1 0 55.5 17 A 8.5 8.5 0 0 1 46 3.5 Z"
              fill="#ece9e1"
              opacity="0.9"
            />
            <path
              d="M12 45.5C12.5 37.5 18 32.5 25 32.5C30.5 32.5 35 35.5 36.5 39.5L56 43.5L36.5 47.5C33.5 51.5 28.5 53.5 22.5 53.5L14 53.5C13 50.5 12 48.5 12 45.5Z"
              fill="#ece9e1"
            />
            <circle cx="21" cy="40.5" r="2" fill="#f0a441" />
            <path
              d="M4 55.5c14-2.5 42-2.5 56 0.5"
              fill="none"
              stroke="#ece9e1"
              strokeWidth="2.5"
              strokeLinecap="round"
              opacity="0.55"
            />
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
