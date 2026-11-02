import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The demo loader (a Server Action under /app/settings) reads anonymized fixtures at runtime.
  outputFileTracingIncludes: {
    "/app/settings": ["./fixtures/demo/**/*.json"],
  },
};

export default nextConfig;
