import type { NextConfig } from "next";

// Vercel adds HSTS. These stop other sites from framing the app (clickjacking on the login and
// settings buttons), MIME sniffing, sending full URLs in Referer, and asking for devices.
// Only frame-ancestors is set in the CSP: a full policy needs nonces and is not done yet.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

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
  // Every route, including the landing page and API responses. Not "/:path*": that skips "/".
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
