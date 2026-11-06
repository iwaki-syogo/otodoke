import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ACCOUNT_DELETE_CONFIRM, ACCOUNT_DELETED_PATH } from "@/lib/account-deletion";

/**
 * The login form keeps the address this browser typed (and when a mail went out) in a cookie for
 * the login page: otodoke_login, Path=/login, one hour (login-email-cookie.ts). The privacy policy
 * says it is removed when the browser signs in, signs out or deletes its account. Signing in with
 * the code is in login-code-form.test.ts; here are the link (/auth/confirm), /auth/signout and
 * 設定「アカウントを削除」.
 */

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  deletes: [] as unknown[],
  verifyError: null as null | { status: number; code: string; message: string },
  user: { id: "00000000-0000-4000-8000-00000000000a" } as { id: string } | null,
  deleteOutcome: { ok: true } as { ok: true } | { ok: false; reason: string },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: (arg: unknown) => {
      mocks.calls.push("forget login cookie");
      mocks.deletes.push(arg);
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string, type?: string) => {
    mocks.calls.push(`redirect ${url} ${type ?? ""}`.trim());
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => mocks.calls.push(`revalidatePath ${p}`), revalidateTag: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      verifyOtp: async () => {
        mocks.calls.push("verifyOtp");
        return { data: {}, error: mocks.verifyError };
      },
      getUser: async () => ({ data: { user: mocks.user }, error: null }),
      signOut: async (options?: { scope?: string }) => {
        mocks.calls.push(`signOut ${options?.scope ?? "global"}`);
        return { error: null };
      },
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/account-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-deletion")>()),
  deleteAuthUser: async () => {
    mocks.calls.push("deleteAuthUser");
    return mocks.deleteOutcome;
  },
}));

const COOKIE = { name: "otodoke_login", path: "/login" };

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.deletes.length = 0;
  mocks.verifyError = null;
  mocks.user = { id: "00000000-0000-4000-8000-00000000000a" };
  mocks.deleteOutcome = { ok: true };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function confirm(headers: Record<string, string> = { host: "otodoke.app", origin: "https://otodoke.app", "sec-fetch-site": "same-origin" }) {
  const { POST } = await import("@/app/auth/confirm/route");
  const body = new FormData();
  body.set("token_hash", "a-token-hash");
  body.set("type", "email");
  body.set("next", "/app");
  const res = await POST(new NextRequest("https://otodoke.app/auth/confirm", { method: "POST", body, headers }));
  return res.headers.get("location");
}

describe("the address cookie goes when this browser signs in by the link", () => {
  it("is forgotten after the link's token is accepted", async () => {
    expect(await confirm()).toBe("/app");
    expect(mocks.deletes).toEqual([COOKIE]);
    expect(mocks.calls).toEqual(["verifyOtp", "forget login cookie"]);
  });

  it("stays when the link did not sign anyone in (refused token, a limit, another site's form)", async () => {
    mocks.verifyError = { status: 403, code: "otp_expired", message: "Token has expired or is invalid" };
    mocks.user = null;
    await confirm();
    mocks.verifyError = { status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" };
    await confirm();
    mocks.verifyError = null;
    await confirm({ host: "otodoke.app", origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(mocks.deletes).toEqual([]);
  });
});

describe("the address cookie goes when this browser signs out", () => {
  it("is forgotten by /auth/signout, after the session", async () => {
    const { POST } = await import("@/app/auth/signout/route");
    const res = await POST(new NextRequest("https://otodoke.app/auth/signout", { method: "POST" }));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    expect(mocks.deletes).toEqual([COOKIE]);
    expect(mocks.calls).toEqual(["signOut global", "forget login cookie"]);
  });
});

describe("the address cookie goes when the account is deleted", () => {
  async function deleteAccount() {
    const { deleteAccount: action } = await import("@/app/app/settings/account-actions");
    const form = new FormData();
    form.set(ACCOUNT_DELETE_CONFIRM.name, ACCOUNT_DELETE_CONFIRM.value);
    try {
      return await action(null, form);
    } catch (error) {
      return (error as Error).message;
    }
  }

  it("is forgotten after the account and this browser's session, before the page after it", async () => {
    expect(await deleteAccount()).toBe(`REDIRECT:${ACCOUNT_DELETED_PATH}`);
    expect(mocks.deletes).toEqual([COOKIE]);
    expect(mocks.calls).toEqual(["deleteAuthUser", "signOut local", "forget login cookie", "revalidatePath /", `redirect ${ACCOUNT_DELETED_PATH} replace`]);
  });

  it("stays when the account could not be deleted (the person is still signed in)", async () => {
    mocks.deleteOutcome = { ok: false, reason: "Database error deleting user" };
    await deleteAccount();
    expect(mocks.deletes).toEqual([]);
  });
});
