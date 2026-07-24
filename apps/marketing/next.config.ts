import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every route is statically prerendered at build time; Vercel serves it as
  // static output. No images, no rewrites, no server dependencies.
  poweredByHeader: false,
};

export default nextConfig;
