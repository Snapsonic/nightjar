import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@nightjar/shared", "@nightjar/db"],
};

export default nextConfig;
