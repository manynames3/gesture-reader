import type { NextConfig } from "next";

const isElectron = process.env.VINEXT_TARGET === "electron";

const nextConfig: NextConfig = {
  output: isElectron ? "export" : undefined,
  trailingSlash: isElectron ? true : undefined,
  images: isElectron ? { unoptimized: true } : undefined,
};

export default nextConfig;
