import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The session cookie Supabase writes, through the real @supabase/ssr and supabase-js (only fetch is made up; nothing
 * leaves the process): HttpOnly always, Secure on Vercel and not on a local HTTP server, SameSite=Lax, Path=/.
 * Both server clients are checked: the proxy (refresh on every request) and src/lib/supabase/server.ts (login and
 * logout in Server Actions). Login, refresh and logout keep working: the session is written, read back and removed.
 */

const URL_ = "https://example.supabase.co";
const COOKIE = "sb-example-auth-token";
const USER = { id: "00000000-0000-4000-8000-00000000000a", aud: "authenticated", role: "authenticated", email: "a@example.invalid", app_metadata: {}, user_metadata: {}, created_at: "2026-11-01T00:00:00Z" };

const store = vi.hoisted(() => ({ jar: new Map<string, string>(), sets: [] as Array<{ name: string; value: string; options: Record<string, unknown> }> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...store.jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      store.sets.push({ name, value, options });
      if (options?.maxAge === 0) store.jar.delete(name);
      else store.jar.set(name, value);
    },
  }),
}));

/** A token the SDK accepts: three base64url parts with exp and sub. Made up, never sent anywhere. */
function token(expSeconds: number) {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b({ sub: USER.id, exp: expSeconds, aud: "authenticated", role: "authenticated" })}.c2ln`;
}
function session(expSeconds: number) {
  return { access_token: token(expSeconds), refresh_token: "made-up-refresh", token_type: "bearer", expires_in: expSeconds - Math.floor(Date.now() / 1000), expires_at: expSeconds, user: USER };
}
const cookieValue = (s: object) => "base64-" + Buffer.from(JSON.stringify(s)).toString("base64url");

const requests: string[] = [];
function fakeAuth() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url.replace(URL_, ""));
    const later = Math.floor(Date.now() / 1000) + 3600;
    if (url.includes("/auth/v1/token")) return Response.json(session(later));
    if (url.endsWith("/auth/v1/user")) return Response.json(USER);
    if (url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
    return new Response("not made up", { status: 500 });
  });
}

/** The attributes of one Set-Cookie line, lower-cased names. */
function attributes(line: string) {
  const [, ...parts] = line.split(";").map((p) => p.trim());
  return new Map(parts.map((p) => { const [k, v] = p.split("="); return [k.toLowerCase(), v ?? true] as const; }));
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", URL_);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "made-up-anon");
  store.jar.clear();
  store.sets.length = 0;
  requests.length = 0;
  fakeAuth();
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the proxy's refreshed session cookie", () => {
  async function refreshed(vercel: string | null) {
    if (vercel) vi.stubEnv("VERCEL", vercel);
    else vi.stubEnv("VERCEL", "");
    const { proxy } = await import("@/proxy");
    const past = Math.floor(Date.now() / 1000) - 60;
    const req = new NextRequest("http://localhost:3015/app", { headers: { host: "localhost:3015", cookie: `${COOKIE}=${cookieValue(session(past))}` } });
    const res = await proxy(req);
    return { res, lines: res.headers.getSetCookie().filter((l) => l.startsWith(COOKIE)) };
  }

  it("on Vercel: HttpOnly, Secure, SameSite=Lax, Path=/, and the page still opens", async () => {
    const { res, lines } = await refreshed("1");
    expect(requests.some((r) => r.includes("/token?grant_type=refresh_token"))).toBe(true);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const a = attributes(line);
      expect(a.get("httponly")).toBe(true);
      expect(a.get("secure")).toBe(true);
      expect(String(a.get("samesite")).toLowerCase()).toBe("lax");
      expect(a.get("path")).toBe("/");
    }
  });

  it("on a local HTTP server: HttpOnly but not Secure, so the browser keeps it over plain HTTP", async () => {
    const { res, lines } = await refreshed(null);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const a = attributes(line);
      expect(a.get("httponly")).toBe(true);
      expect(a.has("secure")).toBe(false);
    }
  });

  it("(control) a signed-out visitor of /app still goes to /login, and a public page sets no cookie", async () => {
    vi.stubEnv("VERCEL", "1");
    const { proxy } = await import("@/proxy");
    const toLogin = await proxy(new NextRequest("http://localhost:3015/app", { headers: { host: "localhost:3015" } }));
    expect(toLogin.status).toBe(307);
    expect(toLogin.headers.get("location")).toContain("/login");
    const open = await proxy(new NextRequest("http://localhost:3015/privacy", { headers: { host: "localhost:3015" } }));
    expect(open.headers.getSetCookie().filter((l) => l.startsWith(COOKIE))).toEqual([]);
  });
});

describe("the server client's cookie on login and logout", () => {
  it.each([["1", true], ["", false]])("VERCEL=%j: login writes HttpOnly (Secure %s), the session reads back, logout removes it with the same attributes", async (vercel, secure) => {
    vi.stubEnv("VERCEL", vercel);
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({ email: USER.email, password: "made-up" });
    expect(error).toBeNull();
    const written = store.sets.filter((s) => s.name.startsWith(COOKIE) && s.options.maxAge !== 0);
    expect(written.length).toBeGreaterThan(0);
    for (const s of written) expect(s.options).toMatchObject({ httpOnly: true, secure, sameSite: "lax", path: "/" });

    // A later request reads the same cookie back (the next Server Action or page).
    const again = await (await import("@/lib/supabase/server")).createClient();
    const { data } = await again.auth.getUser();
    expect(data.user?.id).toBe(USER.id);

    store.sets.length = 0;
    await again.auth.signOut();
    const removed = store.sets.filter((s) => s.name.startsWith(COOKIE));
    expect(removed.length).toBeGreaterThan(0);
    for (const s of removed) expect(s.options).toMatchObject({ maxAge: 0, httpOnly: true, secure, path: "/" });
    expect([...store.jar.keys()].filter((n) => n.startsWith(COOKIE))).toEqual([]);
  });
});
