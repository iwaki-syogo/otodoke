import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountChangedPath } from "@/lib/action-identity";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const EVENT = "11111111-1111-4111-8111-111111111111";

type AuthAnswer = { data: { user: { id: string; email: string } | null }; error: { status: number } | null };
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
  admin: vi.fn(),
  revalidate: vi.fn(),
  runLoadDemo: vi.fn(),
  runClearAllParcels: vi.fn(),
  runReadWaitingMail: vi.fn(),
  runMarkWronglyDropped: vi.fn(),
  runForgetSender: vi.fn(),
  runDismissIntakeNotice: vi.fn(),
  deleteAuthUser: vi.fn(),
  readConsent: vi.fn(),
  readAfterConsent: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/supabase/server", () => {
  const client = () => ({ auth: { getSession: mocks.getSession, getUser: mocks.getUser, signOut: mocks.signOut }, rpc: mocks.rpc });
  return {
    createClient: async () => client(),
    getUser: async () => (await mocks.getUser()).data.user,
  };
});
vi.mock("@/lib/demo-run", () => ({ runLoadDemo: mocks.runLoadDemo, runClearAllParcels: mocks.runClearAllParcels }));
vi.mock("@/lib/mail-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail-run")>()),
  runReadWaitingMail: mocks.runReadWaitingMail,
  runMarkWronglyDropped: mocks.runMarkWronglyDropped,
}));
vi.mock("@/lib/settings-mail-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings-mail-actions")>()),
  runForgetSender: mocks.runForgetSender,
  runDismissIntakeNotice: mocks.runDismissIntakeNotice,
}));
vi.mock("@/lib/account-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-deletion")>()),
  deleteAuthUser: mocks.deleteAuthUser,
}));
vi.mock("@/lib/ai-consent", () => ({ readAiReadingConsent: mocks.readConsent }));
vi.mock("@/lib/ai-consent-run", () => ({ runReadAfterConsent: mocks.readAfterConsent }));

const actions = await import("@/app/app/settings/actions");
const accountActions = await import("@/app/app/settings/account-actions");
const readingActions = await import("@/app/app/reading/actions");

const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`;
const sessionOf = (sub: string) => ({ data: { session: { access_token: token(sub) } }, error: null });
const answerFor = (id: string): AuthAnswer => ({ data: { user: { id, email: `${id.slice(-1)}@example.test` } }, error: null });

type Case = { name: string; returnTo: string; fields: Record<string, string>; run: (data: FormData) => Promise<unknown>; reached: () => unknown };
const CASES: Case[] = [
  { name: "loadDemo", returnTo: "/app/settings/demo", fields: {}, run: actions.loadDemo, reached: () => mocks.runLoadDemo },
  { name: "readWaitingMail", returnTo: "/app/settings/trouble", fields: {}, run: actions.readWaitingMail, reached: () => mocks.readConsent },
  { name: "markWronglyDropped", returnTo: "/app/settings/dropped", fields: { id: EVENT }, run: actions.markWronglyDropped, reached: () => mocks.runMarkWronglyDropped },
  { name: "forgetSender", returnTo: "/app/settings/dropped", fields: { domain: "shop.example.test" }, run: actions.forgetSender, reached: () => mocks.runForgetSender },
  { name: "clearAllParcels", returnTo: "/app/settings/demo", fields: { confirm: "yes" }, run: actions.clearAllParcels, reached: () => mocks.runClearAllParcels },
  { name: "dismissIntakeNotice", returnTo: "/app/settings/trouble", fields: { limited_at: "2026-11-12T00:00:00Z" }, run: actions.dismissIntakeNotice, reached: () => mocks.runDismissIntakeNotice },
  { name: "deleteAccount", returnTo: "/app/settings/delete", fields: { confirm: "delete-account" }, run: (data) => accountActions.deleteAccount({ error: "" }, data), reached: () => mocks.deleteAuthUser },
  { name: "setAiReadingDecision", returnTo: "/app/reading", fields: { decision: "declined" }, run: readingActions.setAiReadingDecision, reached: () => mocks.rpc },
];

const WRITES = () => [
  mocks.admin, mocks.runLoadDemo, mocks.runClearAllParcels, mocks.runReadWaitingMail, mocks.runMarkWronglyDropped, mocks.runForgetSender,
  mocks.runDismissIntakeNotice, mocks.deleteAuthUser, mocks.readConsent, mocks.readAfterConsent, mocks.rpc, mocks.signOut, mocks.revalidate,
];

async function destination(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    const digest = error instanceof Error && "digest" in error ? error.digest : null;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";").slice(2, -2).join(";");
    throw error;
  }
  return "(returned without redirect)";
}

function form(c: Case, expected: string | undefined): FormData {
  const data = new FormData();
  if (expected !== undefined) data.set("expectedUserId", expected);
  for (const [k, v] of Object.entries(c.fields)) data.set(k, v);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.admin.mockReturnValue({});
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.runLoadDemo.mockResolvedValue({ ok: true, processed: 0, busy: false });
  mocks.runClearAllParcels.mockResolvedValue(null);
  mocks.runReadWaitingMail.mockResolvedValue({ ok: true });
  mocks.runMarkWronglyDropped.mockResolvedValue({ ok: true, outcome: "remembered" });
  mocks.runForgetSender.mockResolvedValue({ ok: true });
  mocks.runDismissIntakeNotice.mockResolvedValue({ ok: true });
  mocks.deleteAuthUser.mockResolvedValue({ ok: true });
  mocks.readConsent.mockResolvedValue("declined");
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "stop here" } });
});

const unreachable = [
  { label: "503", getUser: async () => ({ data: { user: null }, error: { status: 503 } }), getSession: async () => sessionOf(A) },
  { label: "status 0", getUser: async () => ({ data: { user: null }, error: { status: 0 } }), getSession: async () => sessionOf(A) },
  { label: "getUser throws", getUser: async () => { throw new Error("synthetic network failure"); }, getSession: async () => sessionOf(A) },
  { label: "getSession error with status 0", getUser: async () => ({ data: { user: null }, error: { status: 503 } }), getSession: async () => ({ data: { session: null }, error: { status: 0 } }) },
];

describe.each(CASES)("$name", (c) => {
  it.each(unreachable)("stops at the account-check page when Auth cannot be reached: $label", async ({ getUser, getSession }) => {
    mocks.getUser.mockImplementation(getUser);
    mocks.getSession.mockImplementation(getSession);
    const to = await destination(c.run(form(c, A)));
    expect(to).toBe(accountChangedPath(c.returnTo));
    expect(to).not.toBe("/login");
    for (const spy of WRITES()) expect(spy).not.toHaveBeenCalled();
  });

  it("goes to /login when nobody is signed in", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const to = await destination(c.run(form(c, A)));
    expect(to).toBe("/login");
    for (const spy of WRITES()) expect(spy).not.toHaveBeenCalled();
  });

  it("stops at the account-check page when another user is signed in", async () => {
    mocks.getUser.mockResolvedValue(answerFor(B));
    mocks.getSession.mockResolvedValue(sessionOf(B));
    const to = await destination(c.run(form(c, A)));
    expect(to).toBe(accountChangedPath(c.returnTo));
    for (const spy of WRITES()) expect(spy).not.toHaveBeenCalled();
  });

  it("control: passes the guard for the expected user", async () => {
    mocks.getUser.mockResolvedValue(answerFor(A));
    mocks.getSession.mockResolvedValue(sessionOf(A));
    await destination(c.run(form(c, A)));
    expect(c.reached()).toHaveBeenCalled();
  });
});
