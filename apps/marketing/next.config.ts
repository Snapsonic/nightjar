import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Share links were minted as nightjar.ca/s/<token> before the page moved to
  // the app; keep those (and hand-typed ones) working.
  async redirects() {
    return [
      {
        source: "/s/:token",
        destination: "https://app.nightjar.ca/s/:token",
        permanent: false,
      },
    ];
  },

  // Every route is statically prerendered at build time; Vercel serves it as
  // static output. No images, no rewrites, no server dependencies.
  poweredByHeader: false,
};

export default nextConfig;
