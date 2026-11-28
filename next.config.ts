import type { NextConfig } from "next";
import { TRACKING_FORM_ORIGINS } from "./src/lib/carriers";

// Vercel adds HSTS. These stop other sites from framing the app (clickjacking on the login and
// settings buttons), MIME sniffing, sending full URLs in Referer, and asking for devices.
//
// The enforced CSP holds only what the app never needs: being framed, plugins, a <base> element, and
// a form posted to a site other than this one and the carriers'. Forms post to this site, except the
// tracking button of Yamato and Seino, whose sites take the number only by POST (src/lib/carriers): a
// form-action without them makes that button do nothing. Links to the other carriers and Gmail are
// plain links. Scripts, connections, frames and images are only watched for now
// (Content-Security-Policy-Report-Only: the browser reports in its console, nothing is blocked); a
// blocking policy for them needs nonces. Turnstile (challenges.cloudflare.com) is allowed in both.
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const formAction = ["form-action 'self'", ...TRACKING_FORM_ORIGINS].join(" ");
const enforcedCsp = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", formAction].join("; ");
const dev = process.env.NODE_ENV === "development";
const watchedCsp = [
  "default-src 'self'",
  // Next.js writes inline scripts (the page data); the dev server also evaluates code and opens a socket for hot reload.
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""} ${TURNSTILE_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self'",
  `connect-src 'self' ${TURNSTILE_ORIGIN}${dev ? " ws: wss:" : ""}`,
  `frame-src ${TURNSTILE_ORIGIN}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  formAction,
].join("; ");
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: enforcedCsp },
  { key: "Content-Security-Policy-Report-Only", value: watchedCsp },
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
  // The demo loader (a Server Action rendered on /app/settings/demo) reads anonymized fixtures at
  // runtime. The key is the page that renders it: a function only holds the files of its own route.
  outputFileTracingIncludes: {
    "/app/settings/demo": ["./fixtures/demo/**/*.json", "./fixtures/demo-history/**/*.json"],
    "/app/settings/trouble": ["./fixtures/demo/**/*.json", "./fixtures/demo-history/**/*.json"],
    "/api/demo/load": ["./fixtures/demo/**/*.json", "./fixtures/demo-history/**/*.json"],
    "/api/mail/read-waiting": ["./fixtures/demo/**/*.json", "./fixtures/demo-history/**/*.json"],
  },
  // Every route, including the landing page and API responses. Not "/:path*": that skips "/".
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
