import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: keep it outside the bundler.
  serverExternalPackages: ["better-sqlite3", "pg"],
};

export default nextConfig;
