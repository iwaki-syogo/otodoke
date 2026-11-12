import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountChangedPath, actionReturnPath, displayedUserMatches, requireDisplayedUser } from "@/lib/action-identity";
import { KEY_SESSION_STALE } from "@/lib/login-errors";
import type { KeyActivation, KeyRead, KeyRegistration, KeyRewrap, SealedMailRead } from "@/lib/mail-keys";
import type { ChangeSecretInput, FinishResetInput, SignInInput } from "@/lib/login-input";
import { FakeDb } from "./fake-db";

const A = { id: "00000000-0000-4000-8000-00000000000a", email: "a@example.test" };
const B = { id: "00000000-0000-4000-8000-00000000000b", email: "b@example.test" };
const AT = "2026-11-12T01:00:00Z";
const mocks = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  db: null as unknown,
  stale: false,
  unknown: false,
  admin: vi.fn(), signOut: vi.fn(), signIn: vi.fn(), changeSecret: vi.fn(), finish: vi.fn(), revalidate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => mocks.user,
  createClient: async () => Object.assign(mocks.db as FakeDb, { auth: {
    getUser: async () => ({ data: { user: mocks.user }, error: null }), signOut: mocks.signOut,
  } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/auth-session", async (actual) => ({
  ...await actual<typeof import("@/lib/auth-session")>(),
  readCookieSession: async () => mocks.unknown ? { state: "unknown" } : !mocks.user ? { state: "signed_out" } : {
    state: "signed_in", session: { userId: mocks.user.id, email: mocks.user.email, amr: [{ method: "password", at: Date.now() - (mocks.stale ? 16 * 60_000 : 0) }] },
  },
}));
vi.mock("@/lib/login-auth", () => ({ signIn: mocks.signIn, changeSecret: mocks.changeSecret, finishReset: mocks.finish }));
vi.mock("@/lib/seal-later", () => ({ scheduleSealRemaining: vi.fn() }));

const settings = await import("@/app/app/settings/actions");
const keyActions = await import("@/app/app/settings/key-actions");
const { createManualParcel } = await import("@/app/app/parcels/manual-actions");
const { changeLoginSecret, signInForKey } = await import("@/app/app/settings/password-actions");
const { signInWithAuthSecret } = await import("@/app/login/actions");
const { readSignedInAddress } = await import("@/app/login/session-actions");
const { finishReset } = await import("@/app/reset-password/actions");
const { POST: signOut } = await import("@/app/auth/signout/route");
let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = B;
  mocks.stale = false;
  mocks.unknown = false;
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.signIn.mockResolvedValue({ ok: true, userId: A.id });
  mocks.changeSecret.mockResolvedValue({ ok: true });
  mocks.finish.mockResolvedValue({ ok: true });
  db = new FakeDb({
    screen_events: [A, B].map(({ id }) => ({ id: `event-${id}`, user_id: id, from_domain: "shared.example.test", flagged_at: AT })),
    mail_intake_notices: [A, B].map(({ id }) => ({ user_id: id, limited_at: AT })),
  });
  mocks.db = db;
  mocks.admin.mockReturnValue(db);
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function form(expectedUserId: string | undefined, fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  if (expectedUserId !== undefined) data.set("expectedUserId", expectedUserId);
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const redirected = (action: Promise<unknown>, to: string) => expect(action).rejects.toMatchObject({ digest: expect.stringContaining(`;${to};`) });

describe("the common displayed-account precondition", () => {
  it("compares an untrusted expected value only against the verified user", () => {
    expect(displayedUserMatches(A, A.id)).toBe(true);
    for (const expected of [B.id, undefined, null, "", "not-a-user-id", { id: A.id }, new File([A.id], "id")]) expect(displayedUserMatches(A, expected)).toBe(false);
    expect(displayedUserMatches(null, A.id)).toBe(false);
    expect(() => requireDisplayedUser(A, A.id, "/app/settings/delete")).not.toThrow();
    expect(() => requireDisplayedUser(B, A.id, "/app/settings/delete")).toThrow();
  });

  it.each(["https://outside.example", "//outside.example", "/%2Foutside.example", "/auth/confirm", "/AUTH/continue", "/account-changed", "/login", "/reset-password"])("does not recover into an external destination or an auth loop: %s", (next) => {
    expect(actionReturnPath(next)).toBe("/app");
  });

  it("shows current verified B on a GET and discards all old action inputs", async () => {
    const Page = (await import("@/app/account-changed/page")).default;
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ next: "/app/settings/delete?confirm=delete-account&expectedUserId=old#old" }) }));
    expect(html).toContain(B.email);
    expect(html).not.toContain(A.email);
    expect(html).toContain('href="/app/settings/delete"');
    expect(html).not.toMatch(/<form|<input|confirm=|expectedUserId|#old/);
    // A plain anchor starts a new document GET, rather than returning cached A props via Link.
    expect(html).toContain("このアカウントで画面を開き直す</a>");
    expect(actionReturnPath("/app/settings/delete?confirm=yes")).toBe("/app/settings/delete");
  });

  it("keeps an unavailable identity distinct from signed out and retries the same safe GET", async () => {
    mocks.unknown = true;
    const Page = (await import("@/app/account-changed/page")).default;
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ next: "/app/settings/delete?confirm=delete-account" }) }));
    expect(html).toContain("現在のアカウントを確認できませんでした");
    expect(html).not.toContain("現在ログインしていません");
    expect(html).not.toContain(B.email);
    expect(html).not.toContain("/login");
    expect(html).toContain(`href="${accountChangedPath("/app/settings/delete")}"`);
    expect(html).not.toMatch(/<form|<input|confirm=/);
  });

  it("offers the login exit only after the current session was confirmed signed out", async () => {
    mocks.user = null;
    const Page = (await import("@/app/account-changed/page")).default;
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ next: "/app/settings/delete?confirm=delete-account" }) }));
    expect(html).toContain("現在ログインしていません");
    expect(html).not.toContain("現在のアカウントを確認できませんでした");
    expect(html).toContain('href="/login?next=%2Fapp%2Fsettings%2Fdelete"');
    expect(html).not.toMatch(/<form|<input|confirm=/);
  });
});

describe("account-wide actions stop before any current-B effect", () => {
  const calls = [
    ["sample load", () => settings.loadDemo(form(A.id)), "/app/settings/demo"],
    ["waiting paid mail", () => settings.readWaitingMail(form(A.id)), "/app/settings/trouble"],
    ["same sender domain", () => settings.forgetSender(form(A.id, { domain: "shared.example.test" })), "/app/settings/dropped"],
    ["same notice timestamp", () => settings.dismissIntakeNotice(form(A.id, { limited_at: AT })), "/app/settings/trouble"],
    ["new manual parcel", () => createManualParcel({ error: null, values: {} }, form(A.id, { title: "A's old input", shop: "Test" })), "/app/parcels/new"],
  ] as const;
  it.each(calls)("rejects %s from a displayed A screen", async (_name, action, to) => {
    const before = structuredClone({ events: db.rows("screen_events"), notices: db.rows("mail_intake_notices") });
    await redirected(action(), accountChangedPath(to));
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(db.calls.filter((call) => call.op !== "select")).toEqual([]);
    expect(db.rows("screen_events")).toEqual(before.events);
    expect(db.rows("mail_intake_notices")).toEqual(before.notices);
  });
});

describe("the settings sign-in and strict key inputs have a separate Web precondition", () => {
  const input = { email: A.email, authSecret: "a".repeat(64) } satisfies SignInInput;
  it("stops the settings sign-in before it can replace B's cookie", async () => {
    await redirected(signInForKey(input, A.id), accountChangedPath("/app/settings/password"));
    expect(mocks.signIn).not.toHaveBeenCalled();
  });
  it("allows the explicit public login and same-account settings sign-in", async () => {
    expect(await signInWithAuthSecret(input)).toEqual({ ok: true, userId: A.id });
    mocks.user = A;
    expect(await signInForKey(input, A.id)).toEqual({ ok: true, userId: A.id });
    expect(mocks.signIn).toHaveBeenCalledTimes(2);
  });
  it("keeps unavailable authentication as network and sends signed-out settings sign-in to login", async () => {
    mocks.unknown = true;
    expect(await signInForKey(input, A.id)).toEqual({ ok: false, code: "network" });
    mocks.unknown = false;
    mocks.user = null;
    await redirected(signInForKey(input, A.id), "/login");
    expect(mocks.signIn).not.toHaveBeenCalled();
  });
  it("confirms the retained identity before reporting an address to a key flow", async () => {
    await redirected(readSignedInAddress(A.id), accountChangedPath("/app/settings/password"));
    mocks.user = A;
    expect(await readSignedInAddress(A.id)).toEqual({ ok: true, userId: A.id, email: A.email });
  });
  it("stops password changes and reset completion before their shared mutations", async () => {
    await redirected(changeLoginSecret({} as ChangeSecretInput, A.id), accountChangedPath("/app/settings/password"));
    await redirected(finishReset({ expectedUserId: A.id } as FinishResetInput), accountChangedPath("/app/settings/password"));
    expect(mocks.changeSecret).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });
  const writers = [
    ["register", () => keyActions.registerMailKey({} as KeyRegistration, A.id)],
    ["activate", () => keyActions.activateMailKey({} as KeyActivation, A.id)],
    ["rewrap", () => keyActions.rewrapMailKey({} as KeyRewrap, A.id)],
  ] as const;
  it.each(writers)("rejects %s for a different fresh or stale B before any key work", async (_name, action) => {
    for (const stale of [false, true]) {
      mocks.stale = stale;
      await redirected(action(), accountChangedPath("/app/settings/password"));
    }
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });
  it("keeps the existing stale-session refusal for the same account", async () => {
    mocks.user = A;
    mocks.stale = true;
    expect(await keyActions.registerMailKey({} as KeyRegistration, A.id)).toEqual({ ok: false, error: KEY_SESSION_STALE });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("does not return B's key material into an A screen", async () => {
    for (const action of [() => keyActions.readMailKey({ keyId: null } as KeyRead, A.id), () => keyActions.readRetiredMailKeys(A.id), () => keyActions.readSealedMail({ emailId: "old-a-mail" } as SealedMailRead, A.id)]) {
      await expect(action()).rejects.toMatchObject({ digest: expect.stringContaining("/account-changed?") });
    }
    expect(db.calls).toEqual([]);
  });
});

describe("logout POST recovers with a new GET", () => {
  const request = (expected: string | undefined) => new NextRequest("https://otodoke.app/auth/signout", { method: "POST", body: form(expected) });
  it.each([A.id, undefined, "", "not-a-user-id"])("does not sign out B for the old or missing precondition %j", async (expected) => {
    const response = await signOut(request(expected));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`https://otodoke.app${accountChangedPath("/app/settings")}`);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it("still signs out the same displayed account with a 303", async () => {
    const response = await signOut(request(B.id));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://otodoke.app/");
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });
});

describe("framework recovery survives the client crypto catches", () => {
  it.each(["login", "unlock", "change", "reset"])("keeps the Next redirect from the %s flow", async (flow) => {
    // This is the real digest Next uses to navigate after a Server Action redirect.
    let recovery: unknown;
    try { requireDisplayedUser(B, A.id, "/app/settings/password"); } catch (error) { recovery = error; }
    const { changePassword, finishPasswordReset, openKeyAgain, signInAndOpenKey } = await import("@/lib/crypto/password-flows");
    const fail = vi.fn().mockRejectedValue(recovery);
    const ports = { readMailKey: fail, signInWithAuthSecret: async () => ({ ok: true as const, userId: A.id }), readSignedInAddress: async () => ({ ok: true as const, userId: A.id, email: A.email }), registerMailKey: fail, activateMailKey: fail, rewrapMailKey: fail, changeLoginSecret: fail, finishReset: fail };
    const operation = flow === "login" ? signInAndOpenKey({ email: A.email, password: "password" }, ports)
      : flow === "unlock" ? openKeyAgain({ email: A.email, password: "password", userId: A.id }, ports)
      : flow === "change" ? changePassword({ email: A.email, userId: A.id, current: "current-password", next: "next-password" }, ports)
      : finishPasswordReset({ email: A.email, userId: A.id, password: "next-password" }, ports);
    await expect(operation).rejects.toBe(recovery);
    expect(fail).toHaveBeenCalledWith({ keyId: null }, A.id);
  });

  it("takes the expected identity for first-key work from the successful public login", async () => {
    const { signInAndOpenKey } = await import("@/lib/crypto/password-flows");
    const readMailKey = vi.fn().mockResolvedValue({ ok: false, error: "network" });
    const unused = vi.fn();
    await signInAndOpenKey({ email: A.email, password: "password" }, { signInWithAuthSecret: async () => ({ ok: true, userId: A.id }), readSignedInAddress: unused, readMailKey, registerMailKey: unused, activateMailKey: unused, rewrapMailKey: unused });
    expect(readMailKey).toHaveBeenCalledExactlyOnceWith({ keyId: null }, A.id);
  });

  it("carries the same retained identity into the real address action before first-key work", async () => {
    const { signInAndOpenKey } = await import("@/lib/crypto/password-flows");
    const who = vi.fn(readSignedInAddress);
    const unused = vi.fn();
    await redirected(signInAndOpenKey({ email: A.email, password: "password" }, { signInWithAuthSecret: async () => ({ ok: true, userId: A.id }), readSignedInAddress: who, readMailKey: async () => ({ ok: true, key: null }), registerMailKey: unused, activateMailKey: unused, rewrapMailKey: unused }), accountChangedPath("/app/settings/password"));
    expect(who).toHaveBeenCalledExactlyOnceWith(A.id);
    expect(unused).not.toHaveBeenCalled();
  });
});
