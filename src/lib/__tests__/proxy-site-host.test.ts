import { NextRequest } from "next/server";
import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Vercel's production URL, otodoke-app.vercel.app, answered 200 with the whole app. Once Supabase's
 * CAPTCHA is on, Turnstile refuses a login there (its host list has otodoke.app only). The proxy
 * now sends that host to the same path and query on https://otodoke.app (308), before anything
 * else. Not sent: other methods than GET and HEAD, /api/, and every other host (previews too).
 * The proxy's own work (the session cookie, /app for signed-in visitors only) is unchanged.
 */

const auth = vi.hoisted(() => ({
  user: null as null | { id: string },
  calls: 0,
  refresh: false,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    { cookies }: { cookies: { setAll: (c: Array<{ name: string; value: string; options: Record<string, unknown> }>) => void } },
  ) => ({
    auth: {
      getUser: async () => {
        auth.calls++;
        if (auth.refresh) cookies.setAll([{ name: "sb-session", value: "refreshed", options: { path: "/", httpOnly: true } }]);
        return { data: { user: auth.user } };
      },
    },
  }),
}));

const { proxy, config } = await import("@/proxy");

const VERCEL = "otodoke-app.vercel.app";

function request(url: string, { method = "GET", host }: { method?: string; host?: string } = {}) {
  return new NextRequest(url, { method, headers: { host: host ?? new URL(url).host } });
}

/** Whether the proxy let the request go on to the page (NextResponse.next()). */
const wentOn = (res: Response) => res.headers.get("x-middleware-next") === "1";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  auth.user = null;
  auth.calls = 0;
  auth.refresh = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Vercel's production URL goes to otodoke.app", () => {
  it.each([
    ["the top page", "/", "https://otodoke.app/"],
    ["an app page with its query", "/app/calendar?m=2026-11", "https://otodoke.app/app/calendar?m=2026-11"],
    ["the login page", "/login?next=%2Fapp%2Fsettings", "https://otodoke.app/login?next=%2Fapp%2Fsettings"],
    ["a login link, unused (only its page is opened)", "/auth/continue?token_hash=t&type=email&next=%2Fapp", "https://otodoke.app/auth/continue?token_hash=t&type=email&next=%2Fapp"],
    ["the mail link itself", "/auth/confirm?next=%2Fapp&token_hash=t&type=email", "https://otodoke.app/auth/confirm?next=%2Fapp&token_hash=t&type=email"],
    ["the page the iOS app may open for Turnstile", "/auth/turnstile-app", "https://otodoke.app/auth/turnstile-app"],
    ["an encoded Japanese query", "/app/spend?c=%E9%A3%9F%E5%93%81", "https://otodoke.app/app/spend?c=%E9%A3%9F%E5%93%81"],
    ["a path that starts with two slashes, kept on otodoke.app", "//x.example/app", "https://otodoke.app//x.example/app"],
  ])("sends %s with 308, path and query kept", async (_what, path, location) => {
    const res = await proxy(request(`https://${VERCEL}${path}`));
    expect(res.status).toBe(308);
    expect(getRedirectUrl(res as never)).toBe(location);
    expect(new URL(location).origin).toBe("https://otodoke.app");
    // Sent before the session is looked at.
    expect(auth.calls).toBe(0);
  });

  it("sends HEAD as well, and the host in any case or with its port", async () => {
    for (const [method, host] of [["HEAD", VERCEL], ["GET", "Otodoke-App.Vercel.App"], ["GET", `${VERCEL}:443`]]) {
      const res = await proxy(request(`https://${VERCEL}/app`, { method, host }));
      expect(res.status, `${method} ${host}`).toBe(308);
      expect(getRedirectUrl(res as never)).toBe("https://otodoke.app/app");
    }
  });

  it("sends a signed-out visitor of /app to otodoke.app first, not to this host's login", async () => {
    const res = await proxy(request(`https://${VERCEL}/app/settings`));
    expect(getRedirectUrl(res as never)).toBe("https://otodoke.app/app/settings");
  });
});

describe("what is not sent", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("leaves %s on Vercel's production URL as it was", async (method) => {
    const res = await proxy(request(`https://${VERCEL}/auth/confirm`, { method }));
    expect(wentOn(res)).toBe(true);
    expect(auth.calls).toBe(1);
  });

  it.each(["/api/inbound", "/api/other", "/api"])("leaves %s alone (a webhook may be set to either host)", async (path) => {
    for (const method of ["GET", "POST"]) {
      const res = await proxy(request(`https://${VERCEL}${path}`, { method }));
      expect(wentOn(res), `${method} ${path}`).toBe(true);
    }
  });

  it.each([
    "otodoke.app",
    "otodoke-app-git-dev-syodgo-9062s-projects.vercel.app",
    "otodoke-app-k3j9x2a1b-syodgo-9062s-projects.vercel.app",
    "otodoke-app.vercel.app.evil.example",
    "xotodoke-app.vercel.app",
    "localhost:3015",
    "otodoke.localhost:3015",
    "100.111.61.12:3015",
  ])("leaves %s where it is", async (host) => {
    auth.user = { id: "u1" };
    for (const path of ["/", "/app", "/auth/continue?token_hash=t&type=email", "/auth/turnstile-app"]) {
      const res = await proxy(request(`https://otodoke.app${path}`, { host }));
      expect(wentOn(res), `${host}${path}`).toBe(true);
    }
  });

  it("leaves a request without a Host where it is", async () => {
    const req = new NextRequest(`https://${VERCEL}/`);
    req.headers.delete("host");
    expect(wentOn(await proxy(req))).toBe(true);
  });
});

describe("the proxy's own work is unchanged", () => {
  it("sends a signed-out visitor of an app page to /login with the page as next", async () => {
    const res = await proxy(request("https://otodoke.app/app/settings"));
    expect(res.status).toBe(307);
    expect(getRedirectUrl(res as never)).toBe("https://otodoke.app/login?next=%2Fapp%2Fsettings");
  });

  it("lets a signed-in visitor through and passes a refreshed session cookie on", async () => {
    auth.user = { id: "u1" };
    auth.refresh = true;
    const res = await proxy(request("https://otodoke.app/app"));
    expect(wentOn(res)).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("sb-session=refreshed");
  });

  it("lets anyone open the public pages and the login link's page", async () => {
    for (const path of ["/", "/login", "/auth/continue?token_hash=t&type=email", "/auth/turnstile-app"]) {
      expect(wentOn(await proxy(request(`https://otodoke.app${path}`))), path).toBe(true);
    }
  });
});

describe("the matcher", () => {
  const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it("runs the proxy for pages, auth and other API routes", () => {
    for (const url of ["/", "/app", "/app/calendar?m=2026-11", "/login", "/auth/confirm", "/auth/continue", "/auth/turnstile-app", "/api/other"]) {
      expect(runs(url), url).toBe(true);
    }
  });

  it("skips static files and the inbound webhook, which then stay on any host (nothing breaks: pages are sent on)", () => {
    for (const url of ["/_next/static/chunks/main.js", "/_next/image?url=%2Fa.png&w=64&q=75", "/favicon.ico", "/icon.svg", "/apple-icon.png", "/robots.txt", "/sitemap.xml", "/api/inbound"]) {
      expect(runs(url), url).toBe(false);
    }
  });
});
