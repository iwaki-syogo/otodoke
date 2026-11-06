import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fromThisSite, hostName, servedOverHttp } from "@/lib/request-origin";

/**
 * Review R2-8: POST /auth/confirm took an http Origin for any Host. Plain http now passes only for
 * the hosts a developer serves the app from over http: the own machine and the tailnet. A public
 * host over http (otodoke.app, the Vercel URLs) is a page someone on the network could have
 * written, so its POST is refused like another site's.
 *
 * Refused although someone might use it, and what to use instead: a LAN address such as
 * http://192.168.1.5:3015 (the Tailscale address or localhost), a Tailscale MagicDNS name or IPv6
 * address over http (the 100.x address), "localhost." with the trailing dot (localhost).
 */

const mocks = vi.hoisted(() => ({ verifyOtp: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp: mocks.verifyOtp } }),
}));

const { POST } = await import("@/app/auth/confirm/route");

const h = (init: Record<string, string>) => new Headers(init);
/** What a browser sends with a form POST from its own page on `origin`. */
const ownPage = (origin: string, extra: Record<string, string> = {}) =>
  h({ host: new URL(origin).host, origin, "sec-fetch-site": "same-origin", ...extra });

const PASSES: Array<[string, Headers]> = [
  ["https://otodoke.app", ownPage("https://otodoke.app")],
  ["the Vercel preview of dev over https", ownPage("https://otodoke-app-git-dev-syodgo-9062s-projects.vercel.app")],
  ["a per-deployment Vercel URL over https", ownPage("https://otodoke-app-k3j9x2a1b-syodgo-9062s-projects.vercel.app")],
  ["http://otodoke.localhost:3015", ownPage("http://otodoke.localhost:3015")],
  ["http://localhost:3015", ownPage("http://localhost:3015")],
  ["http://localhost without a port", ownPage("http://localhost")],
  ["https://localhost:3015", ownPage("https://localhost:3015")],
  ["http://127.0.0.1:3015", ownPage("http://127.0.0.1:3015")],
  ["http://[::1]:3015", ownPage("http://[::1]:3015")],
  ["a phone on the tailnet, http://100.111.61.12:3015", ownPage("http://100.111.61.12:3015")],
  ["the first Tailscale address", ownPage("http://100.64.0.0:3015")],
  ["the last Tailscale address", ownPage("http://100.127.255.255:3015")],
  ["a Host in capitals", h({ host: "LOCALHOST:3015", origin: "http://localhost:3015", "sec-fetch-site": "same-origin" })],
  ["no Origin", h({ host: "otodoke.app", "sec-fetch-site": "same-origin" })],
  ["Sec-Fetch-Site only, over http on the tailnet", h({ host: "100.111.61.12:3015", "sec-fetch-site": "same-origin" })],
  ["neither header", h({ host: "otodoke.app" })],
  ["Origin null from a no-referrer page, with Sec-Fetch-Site same-origin", h({ host: "otodoke.app", origin: "null", "sec-fetch-site": "same-origin" })],
];

const REFUSED: Array<[string, Headers]> = [
  ["http://otodoke.app (review R2-8)", ownPage("http://otodoke.app")],
  ["http://otodoke.app from an older browser that sends Origin only", h({ host: "otodoke.app", origin: "http://otodoke.app" })],
  ["http://otodoke-app.vercel.app", ownPage("http://otodoke-app.vercel.app")],
  ["the Vercel preview of dev over http", ownPage("http://otodoke-app-git-dev-syodgo-9062s-projects.vercel.app")],
  ["just below the Tailscale range", ownPage("http://100.63.255.255:3015")],
  ["just above the Tailscale range", ownPage("http://100.128.0.0:3015")],
  ["a LAN address", ownPage("http://192.168.1.5:3015")],
  ["another private address", ownPage("http://10.0.0.5:3015")],
  ["a name that only starts with localhost", ownPage("http://localhost.evil.example:3015")],
  ["a name that only ends like localhost", ownPage("http://evillocalhost:3015")],
  ["a name that only starts with a loopback address", ownPage("http://127.0.0.1.nip.io:3015")],
  ["a name that only starts with a Tailscale address", ownPage("http://100.111.61.12.nip.io:3015")],
];

beforeEach(() => {
  mocks.verifyOtp.mockReset();
  mocks.verifyOtp.mockResolvedValue({ error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("fromThisSite over https and http", () => {
  it.each(PASSES)("lets %s through", (_what, headers) => {
    expect(fromThisSite(headers)).toBe(true);
  });

  it.each(REFUSED)("refuses %s", (_what, headers) => {
    expect(fromThisSite(headers)).toBe(false);
  });
});

describe("POST /auth/confirm", () => {
  async function post(headers: Headers) {
    const body = new FormData();
    body.set("token_hash", "token");
    body.set("type", "recovery");
    body.set("next", "/app");
    const res = await POST(new NextRequest(`https://${headers.get("host")}/auth/confirm`, { method: "POST", body, headers }));
    return res.headers.get("location");
  }

  it.each(PASSES)("signs in with a reset link from %s", async (_what, headers) => {
    expect(await post(headers)).toBe("/reset-password");
    expect(mocks.verifyOtp).toHaveBeenCalledTimes(1);
  });

  it.each(REFUSED)("leaves the token unused for %s", async (_what, headers) => {
    expect(await post(headers)).toBe("/login?error=link_invalid");
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });
});

describe("servedOverHttp", () => {
  it.each(["localhost", "localhost:3015", "otodoke.localhost:3015", "a.b.localhost", "127.0.0.1:3015", "127.8.9.10", "[::1]:3015", "[::1]", "100.64.0.1:3015", "100.111.61.12:3015", "100.127.255.255"])(
    "is true for %s",
    (host) => {
      expect(servedOverHttp(host)).toBe(true);
    },
  );

  it.each([
    "otodoke.app",
    "otodoke-app.vercel.app",
    "192.168.1.5:3015",
    "100.63.255.255",
    "100.128.0.0",
    "101.64.0.1",
    "100.64.0",
    "100.64.0.1.2",
    "100.064.0.1",
    "100.64.0.256",
    "localhost.:3015",
    "localhost.evil.example",
    "[::2]:3015",
    "[fd7a:115c:a1e0::1]:3015",
    "user@localhost:3015",
    "",
  ])("is false for %s", (host) => {
    expect(servedOverHttp(host)).toBe(false);
  });

  it("reads the name without the port", () => {
    expect(hostName("[::1]:3015")).toBe("[::1]");
    expect(hostName("localhost:3015")).toBe("localhost");
    expect(hostName("otodoke.app")).toBe("otodoke.app");
    expect(hostName("localhost:")).toBe("");
    expect(hostName("a:b:c")).toBe("");
  });
});
