import type { NextConfig } from "next";

const isStatic = ["electron", "pages"].includes(process.env.VINEXT_TARGET ?? "");

const nextConfig: NextConfig = {
  output: isStatic ? "export" : undefined,
  trailingSlash: isStatic ? true : undefined,
  images: isStatic ? { unoptimized: true } : undefined,
};

export default nextConfig;
