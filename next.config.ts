import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The badge sits on top of the entry rail.
  devIndicators: false,
  // Bound on 0.0.0.0, the dev server calls itself localhost. Opening
  // 127.0.0.1 then blocks the HMR socket, and hydration waits on it.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
