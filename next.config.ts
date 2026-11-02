import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Without this loader, `@import "tailwindcss"` is not expanded and every page renders unstyled.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // The demo loader (a Server Action under /app/settings) reads anonymized fixtures at runtime.
  outputFileTracingIncludes: {
    "/app/settings": ["./fixtures/demo/**/*.json"],
  },
};

export default nextConfig;
