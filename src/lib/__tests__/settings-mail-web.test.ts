import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READ_STORAGE_CONFIRM, READ_STORAGE_CONFIRMING, READ_STORAGE_LIMIT_BODY, READ_STORAGE_LIMIT_NOTICE, READ_STORAGE_LIMIT_REASON, READ_STORAGE_NOTICE_FAILED } from "@/lib/read-notices";
import { REMEMBERED_SENDER_TEXT } from "@/lib/settings-mail-text";
import { FakeDb } from "./fake-db";

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const STAMP = "2026-11-12T01:00:00.123456+00:00";
const NEWER = "2026-11-12T01:00:00.123457+00:00";
const mocks = vi.hoisted(() => ({ db: null as unknown, pending: false, getUser: vi.fn(), admin: vi.fn(), revalidate: vi.fn() }));
vi.mock("react-dom", async (importActual) => ({
  ...await importActual<typeof import("react-dom")>(), useFormStatus: () => ({ pending: mocks.pending }),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/settings/trouble", useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.db, getUser: mocks.getUser }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { mocks.admin(); return mocks.db; } }));

const { dismissIntakeNotice, forgetSender } = await import("@/app/app/settings/actions");
const form = (fields: Record<string, string>) => {
  const value = new FormData();
  value.set("expectedUserId", USER);
  for (const [key, text] of Object.entries(fields)) value.set(key, text);
  return value;
};
const redirects = async (run: Promise<void>, to: string) => { await expect(run).rejects.toThrow(`NEXT_REDIRECT ${to}`); };
const action = (kind: "forget" | "dismiss") => kind === "forget" ? forgetSender(form({ domain: "gmail.com" })) : dismissIntakeNotice(form({ limited_at: STAMP }));

beforeEach(() => {
  mocks.db = new FakeDb({
    screen_events: [
      { id: "me", user_id: USER, from_domain: "gmail.com", flagged_at: STAMP },
      { id: "other", user_id: OTHER, from_domain: "gmail.com", flagged_at: STAMP },
    ],
    mail_intake_notices: [{ user_id: USER, limited_at: STAMP }, { user_id: OTHER, limited_at: STAMP }],
  });
  mocks.getUser.mockReset().mockResolvedValue({ id: USER });
  mocks.admin.mockReset();
  mocks.revalidate.mockReset();
  mocks.pending = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected external request"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Web actions retain authentication and use the shared owner-scoped writes", () => {
  it.each(["forget", "dismiss"] as const)("%s: signed out redirects before creating a database client", async (kind) => {
    mocks.getUser.mockResolvedValue(null);
    await redirects(action(kind), "/login");
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("removes a previously remembered shared domain only for the signed-in person", async () => {
    await redirects(action("forget"), "/app/settings/dropped?unflagged=done");
    expect((mocks.db as FakeDb).rows("screen_events").map((row) => row.flagged_at)).toEqual([null, STAMP]);
    expect(mocks.revalidate.mock.calls).toEqual([["/app/settings"], ["/app/settings/dropped"]]);
  });

  it("uses the raw microsecond acknowledgement and keeps both a newer and another person's notice", async () => {
    const db = mocks.db as FakeDb;
    db.rows("mail_intake_notices")[0].limited_at = NEWER;
    await redirects(action("dismiss"), "/app/settings/trouble");
    expect(db.rows("mail_intake_notices")).toEqual([{ user_id: USER, limited_at: NEWER }, { user_id: OTHER, limited_at: STAMP }]);
    const deleteFilters = db.callsOn("mail_intake_notices", "delete")[0].filters;
    expect(deleteFilters).toEqual([{ method: "eq", args: ["user_id", USER] }, { method: "eq", args: ["limited_at", STAMP] }]);
    await redirects(dismissIntakeNotice(form({ limited_at: NEWER })), "/app/settings/trouble");
    expect(db.rows("mail_intake_notices")).toEqual([{ user_id: OTHER, limited_at: STAMP }]);
    expect(mocks.revalidate.mock.calls).toEqual([["/app", "layout"], ["/app", "layout"]]);
  });

  it("invalid inputs retain the fixed failure destinations without creating a client", async () => {
    await redirects(forgetSender(form({ domain: "" })), "/app/settings/dropped?unflagged=failed");
    await redirects(dismissIntakeNotice(form({ limited_at: "" })), "/app/settings/trouble?error=notice_confirm_failed");
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(["forget", "dismiss"] as const)("%s: database failures keep the Web failure destination and do not change data", async (kind) => {
    const db = mocks.db as FakeDb;
    const before = structuredClone(db.rows(kind === "forget" ? "screen_events" : "mail_intake_notices"));
    db.hooks.push(() => ({ data: null, error: { message: "private database detail" } }));
    await redirects(action(kind), kind === "forget" ? "/app/settings/dropped?unflagged=failed" : "/app/settings/trouble?error=notice_confirm_failed");
    expect(db.rows(kind === "forget" ? "screen_events" : "mail_intake_notices")).toEqual(before);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private database detail");
  });
});

describe("the Web renders the same actual mail-recovery words as the native copy source", () => {
  async function trouble() {
    const Page = (await import("@/app/app/settings/trouble/page")).default;
    return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
  }
  async function dropped(params: Record<string, string> = {}) {
    const Page = (await import("@/app/app/settings/dropped/page")).default;
    return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) }));
  }

  it("shows the body-not-saved explanation, resend path, exact stamp and actual confirm/busy labels even with zero unread", async () => {
    mocks.db = new FakeDb({ mail_intake_notices: [{ user_id: USER, limited_at: STAMP }] });
    const html = await trouble();
    for (const words of [READ_STORAGE_LIMIT_NOTICE, READ_STORAGE_LIMIT_BODY, READ_STORAGE_LIMIT_REASON, READ_STORAGE_CONFIRM]) expect(html).toContain(words);
    expect(html).toContain("このメールの本文は保存していません。");
    expect(html).toContain(`value="${STAMP}"`);
    expect(html).toContain("未読のメールはありません。");
    mocks.pending = true;
    const busy = await trouble();
    expect(busy).toContain(READ_STORAGE_CONFIRMING);
    expect(busy).toContain('aria-busy="true"');
    expect(busy).not.toContain(READ_STORAGE_CONFIRM + "</button>");
  });

  it("a failed notice read shows the fixed failure sentence and no dismiss form", async () => {
    (mocks.db as FakeDb).hooks.push((query) => query.table === "mail_intake_notices" ? { data: null, error: { message: "offline" } } : undefined);
    const html = await trouble();
    expect(html).toContain(READ_STORAGE_NOTICE_FAILED);
    expect(html).not.toContain('name="limited_at"');
    expect(html).not.toContain(READ_STORAGE_LIMIT_BODY);
  });

  it("renders every remembered-sender label, including busy and both result states", async () => {
    mocks.db = new FakeDb({ screen_events: [{ id: "me", user_id: USER, decision: "dropped", subject: "Order", from_domain: "shop.example.test", flagged_at: STAMP, created_at: STAMP }] });
    const html = await dropped();
    expect(html).toContain(REMEMBERED_SENDER_TEXT.title);
    expect(html).toContain(REMEMBERED_SENDER_TEXT.remove);
    expect(html).toContain('value="shop.example.test"');
    mocks.pending = true;
    expect(await dropped()).toContain(REMEMBERED_SENDER_TEXT.removing);
    mocks.pending = false;
    expect(await dropped({ unflagged: "done" })).toContain(REMEMBERED_SENDER_TEXT.removed);
    expect(await dropped({ unflagged: "failed" })).toContain(REMEMBERED_SENDER_TEXT.failed);
  });
});
