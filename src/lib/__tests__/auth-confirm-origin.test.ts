import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fromThisSite } from "@/lib/request-origin";

/**
 * Review A-1 (login CSRF): POST /auth/confirm signs the browser in with a reset link's token_hash
 * (type=recovery). A form on another site holding the attacker's own reset token would leave the
 * visitor signed in to the attacker's account, on its reset page. Only a POST from this site's own
 * page reaches verifyOtp, for every type.
 */

const mocks = vi.hoisted(() => ({ verifyOtp: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp: mocks.verifyOtp } }),
}));

const { POST } = await import("@/app/auth/confirm/route");

const TOKEN = "attacker-or-visitor-token";

async function post(headers: Record<string, string>, url = "https://otodoke.app/auth/confirm") {
  const body = new FormData();
  body.set("token_hash", TOKEN);
  body.set("type", "recovery");
  body.set("next", "/app/settings");
  const res = await POST(new NextRequest(url, { method: "POST", body, headers }));
  return { status: res.status, location: res.headers.get("location") };
}

beforeEach(() => {
  mocks.verifyOtp.mockReset();
  mocks.verifyOtp.mockResolvedValue({ error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /auth/confirm accepts its own page", () => {
  it.each([
    ["the button on /auth/continue", { host: "otodoke.app", origin: "https://otodoke.app", "sec-fetch-site": "same-origin" }],
    ["the Vercel production URL", { host: "otodoke-app.vercel.app", origin: "https://otodoke-app.vercel.app", "sec-fetch-site": "same-origin" }],
    ["the dev branch URL", { host: "otodoke-app-git-dev-syodgo-9062s-projects.vercel.app", origin: "https://otodoke-app-git-dev-syodgo-9062s-projects.vercel.app", "sec-fetch-site": "same-origin" }],
    ["the local dev server (http)", { host: "localhost:3015", origin: "http://localhost:3015", "sec-fetch-site": "same-origin" }],
    ["an older browser that sends Origin only", { host: "otodoke.app", origin: "https://otodoke.app" }],
    ["a browser that sends Sec-Fetch-Site only", { host: "otodoke.app", "sec-fetch-site": "same-origin" }],
    ["neither header (not a browser, which cannot carry a forged login)", { host: "otodoke.app" }],
    ["Origin null from a no-referrer page, with Sec-Fetch-Site same-origin", { host: "otodoke.app", origin: "null", "sec-fetch-site": "same-origin" }],
  ])("verifies the token for %s", async (_name, headers) => {
    const res = await post(headers);
    expect(mocks.verifyOtp).toHaveBeenCalledTimes(1);
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: TOKEN });
    // The reset page, a constant: the link's next is never read.
    expect(res).toEqual({ status: 303, location: "/reset-password" });
  });
});

describe("POST /auth/confirm refuses another site's form and leaves the token unused", () => {
  it.each([
    ["Sec-Fetch-Site cross-site", { host: "otodoke.app", origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site same-site", { host: "otodoke.app", origin: "https://www.otodoke.app", "sec-fetch-site": "same-site" }],
    ["Sec-Fetch-Site none", { host: "otodoke.app", "sec-fetch-site": "none" }],
    ["Sec-Fetch-Site cross-site with no Origin", { host: "otodoke.app", "sec-fetch-site": "cross-site" }],
    ["another Origin with no Sec-Fetch-Site (an older browser)", { host: "otodoke.app", origin: "https://evil.example" }],
    ["Origin null with no Sec-Fetch-Site (sandboxed frame, cross-site redirect)", { host: "otodoke.app", origin: "null" }],
    ["Origin null with Sec-Fetch-Site cross-site", { host: "otodoke.app", origin: "null", "sec-fetch-site": "cross-site" }],
    ["an Origin that only starts with the host", { host: "otodoke.app", origin: "https://otodoke.app.evil.example" }],
    ["another of our own hosts (compared with this request's Host, not a fixed list)", { host: "otodoke-app.vercel.app", origin: "https://otodoke.app" }],
    ["an Origin that disagrees with Sec-Fetch-Site same-origin", { host: "otodoke.app", origin: "https://evil.example", "sec-fetch-site": "same-origin" }],
    ["an Origin when the request has no Host", { origin: "https://otodoke.app" }],
  ])("refuses %s", async (_name, headers) => {
    const res = await post(headers);
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    // The same fixed wording as a link that failed to verify.
    expect(res).toEqual({ status: 303, location: "/login?error=link_invalid" });
    expect(vi.mocked(console.warn).mock.calls.map((c) => c[0])).toEqual(["[auth] refused a POST from another site:"]);
  });
});

describe("fromThisSite", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it("compares the host case-insensitively and needs the whole origin to match", () => {
    expect(fromThisSite(h({ host: "Otodoke.App", origin: "https://otodoke.app" }))).toBe(true);
    expect(fromThisSite(h({ host: "otodoke.app", origin: "https://otodoke.app:8443" }))).toBe(false);
    expect(fromThisSite(h({ host: "otodoke.app", origin: "https://otodoke.app/" }))).toBe(false);
    expect(fromThisSite(h({ host: "otodoke.app", origin: "ftp://otodoke.app" }))).toBe(false);
  });
});
