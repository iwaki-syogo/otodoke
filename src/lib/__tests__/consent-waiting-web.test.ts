import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_CONSENT_TEXT } from "@/lib/ai-consent-text";
import { READ_FAILED_REASON, READ_OVER_LIMIT_REASON, READ_STOPPED_REASON } from "@/lib/read-notices";
import { FakeDb, type Row } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

const USER = "00000000-0000-4000-8000-00000000000a";
const displayedForm = () => { const data = new FormData(); data.set("expectedUserId", USER); return data; };
const AT = "2026-11-12T00:00:00Z";
const mocks = vi.hoisted(() => ({ db: null as unknown, user: null as { id: string } | null, admin: vi.fn(), read: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/settings/trouble", useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.db, getUser: async () => mocks.user }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/mail-run", () => ({ runReadWaitingMail: mocks.read }));
vi.mock("@/lib/demo-run", () => ({ runClearAllParcels: vi.fn(), runLoadDemo: vi.fn() }));

const { readWaitingMail } = await import("@/app/app/settings/actions");
const { readUnreadReasons } = await import("@/app/app/settings/settings-reads");
const Page = (await import("@/app/app/settings/trouble/page")).default;
const consent = (decision: "granted" | "declined") => ({ user_id: USER, decision, decided_at: AT, text_version: "v1" });
const mail = (id: string, error: string, processing_status = "failed"): Row => ({ id, user_id: USER, error, processing_status, created_at: AT });
const page = async () => parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })));

beforeEach(() => {
  mocks.db = new FakeDb();
  mocks.user = { id: USER };
  mocks.admin.mockReset().mockReturnValue({});
  mocks.read.mockReset().mockResolvedValue({ ok: true, read: 1, overLimit: false, unavailable: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("A3: the Web retry enters the reading permission screen before mail writes", () => {
  it.each(["undecided", "declined"] as const)("%s: a direct action call offers permission and never starts a read", async (decision) => {
    const db = new FakeDb({ emails: [mail("waiting", "ai_consent_required")], ai_reading_consents: decision === "declined" ? [consent(decision)] : [] });
    mocks.db = db;
    const before = structuredClone(db.rows("emails"));
    await expect(readWaitingMail(displayedForm())).rejects.toThrow("NEXT_REDIRECT /app/reading?after=settings");
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(db.rows("emails")).toEqual(before);
    expect(db.callsOn("emails", "update")).toHaveLength(0);
  });

  it.each(["error", "throw"] as const)("an unknown permission (%s) has the permission screen's recovery exit", async (failure) => {
    const db = new FakeDb({ emails: [mail("waiting", "ai_consent_unknown")] });
    db.hooks.push((q) => {
      if (q.table !== "ai_reading_consents") return;
      if (failure === "throw") throw new Error("offline");
      return { data: null, error: { message: "offline" } };
    });
    mocks.db = db;
    await expect(readWaitingMail(displayedForm())).rejects.toThrow("NEXT_REDIRECT /app/reading?after=settings");
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    const ReadingPage = (await import("@/app/app/reading/page")).default;
    const root = parseHtml(renderToStaticMarkup(await ReadingPage({ searchParams: Promise.resolve({ after: "settings" }) })));
    expect(textOf(root)).toContain(AI_CONSENT_TEXT.readFailed);
    expect(findAll(root, (n) => n.tag === "a" && n.attrs.href === "/app/reading?after=settings").map(textOf)).toEqual([AI_CONSENT_TEXT.retry]);
  });

  it("granted: keeps the existing read and its success destination", async () => {
    mocks.db = new FakeDb({ ai_reading_consents: [consent("granted")] });
    await expect(readWaitingMail(displayedForm())).rejects.toThrow("NEXT_REDIRECT /app/settings/trouble");
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledWith({}, USER);
  });

  it("a signed-out direct action stays on the login path", async () => {
    mocks.user = null;
    await expect(readWaitingMail(displayedForm())).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

describe("A3: waiting permissions are distinct from read failures on the trouble page", () => {
  it("counts permission-required and permission-unknown separately without hiding other reasons", async () => {
    const db = new FakeDb({ emails: [mail("required", "ai_consent_required"), mail("unknown", "ai_consent_unknown"), mail("stopped", "claude_unavailable"), mail("limit", "user", "over_limit"), mail("failed", "claude_error")] });
    expect(await readUnreadReasons(db as never, "A3")).toEqual({ stopped: 1, overLimit: 1, failed: 1, consentRequired: 1, consentUnknown: 1 });
  });

  it.each(["undecided", "declined"] as const)("%s: shows the existing permission link instead of a retry form or a false read-failed reason", async (decision) => {
    mocks.db = new FakeDb({ emails: [mail("waiting", "ai_consent_required")], ai_reading_consents: decision === "declined" ? [consent(decision)] : [] });
    const root = await page();
    expect(findAll(root, (n) => n.tag === "a" && n.attrs.href === "/app/reading?after=settings").map(textOf)).toEqual([AI_CONSENT_TEXT.start]);
    expect(findAll(root, (n) => n.tag === "button" && textOf(n) === "読み取る")).toHaveLength(0);
    expect(textOf(root)).not.toContain(READ_FAILED_REASON);
  });

  it("permission waiting can coexist with the daily limit, a stopped reader, and a real failure", async () => {
    mocks.db = new FakeDb({ emails: [mail("required", "ai_consent_required"), mail("stopped", "claude_unavailable"), mail("limit", "user", "over_limit"), mail("failed", "claude_error")] });
    const root = await page();
    for (const reason of [READ_STOPPED_REASON, READ_OVER_LIMIT_REASON, READ_FAILED_REASON]) expect(textOf(root)).toContain(reason);
    expect(findAll(root, (n) => n.tag === "a" && n.attrs.href === "/app/reading?after=settings").map(textOf)).toEqual([AI_CONSENT_TEXT.start]);
  });

  it("unknown consent shows the existing recovery words and retry link, never a read form", async () => {
    const db = new FakeDb({ emails: [mail("unknown", "ai_consent_unknown")] });
    db.hooks.push((q) => q.table === "ai_reading_consents" ? { data: null, error: { message: "offline" } } : undefined);
    mocks.db = db;
    const root = await page();
    expect(textOf(root)).toContain(AI_CONSENT_TEXT.readFailed);
    expect(textOf(root)).not.toContain(READ_FAILED_REASON);
    expect(findAll(root, (n) => n.tag === "a" && n.attrs.href === "/app/settings/trouble").map(textOf)).toEqual([AI_CONSENT_TEXT.retry]);
    expect(findAll(root, (n) => n.tag === "button" && textOf(n) === "読み取る")).toHaveLength(0);
  });

  it("a current grant makes previous permission-waiting rows readable without calling them failures", async () => {
    mocks.db = new FakeDb({ emails: [mail("required", "ai_consent_required"), mail("unknown", "ai_consent_unknown")], ai_reading_consents: [consent("granted")] });
    const root = await page();
    expect(findAll(root, (n) => n.tag === "button" && textOf(n) === "読み取る")).toHaveLength(1);
    expect(textOf(root)).not.toContain(READ_FAILED_REASON);
    expect(textOf(root)).not.toContain(AI_CONSENT_TEXT.readFailed);
  });
});
