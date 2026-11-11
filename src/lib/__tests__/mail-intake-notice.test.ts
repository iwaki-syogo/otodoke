import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { READ_STORAGE_LIMIT_NOTICE, READ_STORAGE_LIMIT_REASON, READ_STORAGE_NOTICE_FAILED } from "@/lib/read-notices";

const USER = "00000000-0000-4000-8000-00000000000a";
const AT = "2026-11-12T01:00:00.000Z";
const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/settings/trouble", useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.db, getUser: async () => ({ id: USER }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/seal-later", () => ({ scheduleSealRemaining: vi.fn() }));

beforeEach(() => { mocks.db = new FakeDb(); vi.spyOn(console, "error").mockImplementation(() => {}); });
const noticeDb = () => new FakeDb({ mail_intake_notices: [{ user_id: USER, reason: "user_storage_limit", limited_at: AT }] });

describe("storage rejection is visible and recoverable", () => {
  it("shows on the everyday parcel page even when no body was kept and no mail is unread", async () => {
    mocks.db = noticeDb();
    const Page = (await import("@/app/app/page")).default;
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain(READ_STORAGE_LIMIT_NOTICE);
    expect(html).toContain('href="/app/settings/trouble"');
  });

  it("shows the original-mail recovery path and dismiss control without an unread body", async () => {
    mocks.db = noticeDb();
    const Page = (await import("@/app/app/settings/trouble/page")).default;
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(READ_STORAGE_LIMIT_NOTICE);
    expect(html).toContain(READ_STORAGE_LIMIT_REASON);
    expect(html).toContain("確認しました");
    expect(html).toContain('name="limited_at"');
    expect(html).toContain(AT);
  });

  it("reports an unknown reception state when its notice lookup fails", async () => {
    const db = new FakeDb();
    db.hooks.push((q) => q.table === "mail_intake_notices" ? { data: null, error: { message: "offline" } } : undefined);
    mocks.db = db;
    const Page = (await import("@/app/app/page")).default;
    expect(renderToStaticMarkup(await Page())).toContain(READ_STORAGE_NOTICE_FAILED);
    expect(db.callsOn("parcels", "select").length).toBeGreaterThan(0);
  });

  it("dismisses only the notice the person saw and keeps a newer rejection", async () => {
    const db = noticeDb();
    mocks.db = db;
    const { dismissIntakeNotice } = await import("@/app/app/settings/actions");
    const data = new FormData(); data.set("limited_at", AT);
    db.rows("mail_intake_notices")[0].limited_at = "2026-11-12T01:01:00.000Z";
    await expect(dismissIntakeNotice(data)).rejects.toThrow("NEXT_REDIRECT /app/settings/trouble");
    expect(db.rows("mail_intake_notices")).toHaveLength(1);
    data.set("limited_at", "2026-11-12T01:01:00.000Z");
    await expect(dismissIntakeNotice(data)).rejects.toThrow("NEXT_REDIRECT /app/settings/trouble");
    expect(db.rows("mail_intake_notices")).toHaveLength(0);
  });
});
