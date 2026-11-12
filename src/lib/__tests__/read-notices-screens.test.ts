import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";
import {
  READ_FAILED_NOTICE,
  READ_FAILED_REASON,
  READ_OVER_LIMIT_NOTICE,
  READ_OVER_LIMIT_REASON,
  READ_STOPPED_BUTTON,
  READ_STOPPED_REASON,
  READ_UNAVAILABLE_NOTICE,
} from "@/lib/read-notices";
import { SETTINGS_ERROR_PAGES, settingsErrorMessage, settingsErrorPath } from "@/lib/settings-errors";

/**
 * What the person is told after 「読み取る」 and on 「うまく届かないとき」 when Claude is stopped,
 * the daily allowance is used up, or a mail failed. Made-up rows only.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const displayedForm = () => { const data = new FormData(); data.set("expectedUserId", USER); return data; };
const GRANT = { user_id: USER, decision: "granted", decided_at: "2026-11-12T00:00:00Z", text_version: "v1" };

const mocks = vi.hoisted(() => ({ state: { db: null as unknown }, redirect: vi.fn(), read: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    mocks.redirect(to);
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/settings/trouble",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mocks.state.db,
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/mail-run", async (importActual) => ({ ...(await importActual<typeof import("@/lib/mail-run")>()), runReadWaitingMail: mocks.read }));

const { readWaitingMail } = await import("@/app/app/settings/actions");

const row = (n: number, over: Row): Row => ({ id: `e${n}`, user_id: USER, processing_status: "failed", error: "x", created_at: "2026-11-01T00:00:00Z", ...over });
const STOPPED = (n: number) => row(n, { processing_status: "failed", error: "claude_unavailable" });
const OVER = (n: number) => row(n, { processing_status: "over_limit", error: "user" });
const FAILED = (n: number) => row(n, { processing_status: "failed", error: "Unexpected token } in JSON" });
const TRANSIENT = (n: number) => row(n, { processing_status: "failed", error: "claude_error" });

async function troubleText(emails: Row[], hook?: (db: FakeDb) => void): Promise<{ text: string; links: string[] }> {
  const db = new FakeDb({ emails, ai_reading_consents: [GRANT] });
  hook?.(db);
  mocks.state.db = db;
  const Page = (await import("@/app/app/settings/trouble/page")).default;
  const root = parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })));
  const card = findAll(root, (n) => n.tag === "section")[0];
  return { text: textOf(card), links: findAll(card, (n) => n.tag === "a").map((a) => a.attrs.href) };
}

beforeEach(() => {
  mocks.state.db = new FakeDb({ ai_reading_consents: [GRANT] });
  mocks.redirect.mockReset();
  mocks.read.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("読み取る: where each result goes", () => {
  const run = async () => {
    await expect(readWaitingMail(displayedForm())).rejects.toThrow("NEXT_REDIRECT");
    return mocks.redirect.mock.calls.map((c) => c[0] as string);
  };
  const result = (over: Record<string, unknown>) => ({ ok: true, read: 0, overLimit: false, unavailable: false, ...over });

  it("stopped -> read_unavailable, even with a failure and the limit in the same run", async () => {
    mocks.read.mockResolvedValue(result({ unavailable: true }));
    expect(await run()).toEqual([settingsErrorPath("read_unavailable")]);
    mocks.redirect.mockReset();
    mocks.read.mockResolvedValue(result({ ok: false, stage: "read", message: "REAL-FAILURE-MESSAGE", overLimit: true, unavailable: true, onlyBusy: false }));
    expect(await run()).toEqual([settingsErrorPath("read_unavailable")]);
    // The real failure is not shown, but it stays in the server log.
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("REAL-FAILURE-MESSAGE");
  });

  it("a failure -> read_failed (before the limit)", async () => {
    mocks.read.mockResolvedValue(result({ ok: false, stage: "read", message: "x", overLimit: true, onlyBusy: false }));
    expect(await run()).toEqual([settingsErrorPath("read_failed")]);
  });

  it("the limit alone -> read_over_limit", async () => {
    mocks.read.mockResolvedValue(result({ overLimit: true }));
    expect(await run()).toEqual([settingsErrorPath("read_over_limit")]);
  });

  it("negative control: everything read -> the trouble page with no code", async () => {
    mocks.read.mockResolvedValue(result({ read: 3 }));
    expect(await run()).toEqual(["/app/settings/trouble"]);
  });

  it("the three codes show on the trouble page with the fixed words, and none says to try again right away", () => {
    for (const [code, words] of [["read_unavailable", READ_UNAVAILABLE_NOTICE], ["read_over_limit", READ_OVER_LIMIT_NOTICE], ["read_failed", READ_FAILED_NOTICE]] as const) {
      expect(SETTINGS_ERROR_PAGES[code]).toBe("/app/settings/trouble");
      expect(settingsErrorMessage(code)).toBe(words);
      expect(words).not.toContain("もう一度お試しください");
      for (const banned of ["Claude", "API", "クレジット", "2027"]) expect(words).not.toContain(banned);
    }
  });
});

describe("うまく届かないとき: only the reasons that apply", () => {
  it("stopped: the stopped sentence and the button to register by hand; not the others", async () => {
    const { text, links } = await troubleText([STOPPED(1)]);
    expect(text).toContain(READ_STOPPED_REASON);
    expect(text).toContain(READ_STOPPED_BUTTON);
    expect(links).toEqual(["/app/parcels/new"]);
    expect(text).not.toContain(READ_OVER_LIMIT_REASON);
    expect(text).not.toContain(READ_FAILED_REASON);
  });

  it("negative control: only a row over the limit -> no stopped sentence, no register button", async () => {
    const { text, links } = await troubleText([OVER(1)]);
    expect(text).toContain(READ_OVER_LIMIT_REASON);
    expect(text).not.toContain(READ_STOPPED_REASON);
    expect(text).not.toContain(READ_FAILED_REASON);
    expect(links).toEqual([]);
  });

  it("only failed rows (an old raw message, a temporary Claude error) -> the failed sentence", async () => {
    const { text } = await troubleText([FAILED(1), TRANSIENT(2)]);
    expect(text).toContain(READ_FAILED_REASON);
    expect(text).not.toContain(READ_STOPPED_REASON);
    expect(text).not.toContain(READ_OVER_LIMIT_REASON);
    expect(text).not.toContain("もう一度お試しください");
  });

  it("all three at once: stopped, then the limit, then the failure", async () => {
    const { text } = await troubleText([STOPPED(1), OVER(2), FAILED(3)]);
    const at = [READ_STOPPED_REASON, READ_OVER_LIMIT_REASON, READ_FAILED_REASON].map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("a stopped row is not counted as a failure too", async () => {
    const { text } = await troubleText([STOPPED(1), STOPPED(2)]);
    expect(text).not.toContain(READ_FAILED_REASON);
  });

  const PROCESSED = (n: number, created_at: string, over: Row = {}) => row(n, { processing_status: "processed", error: null, created_at, provider_email_id: `re_${n}`, classification: "order", ...over });

  it("a mail was read after the stop: the old stopped row is a failure, not the stopped sentence", async () => {
    const { text } = await troubleText([row(1, { processing_status: "failed", error: "claude_unavailable", created_at: "2026-11-01T00:00:00Z" }), PROCESSED(2, "2026-11-02T00:00:00Z")]);
    expect(text).toContain(READ_FAILED_REASON);
    expect(text).not.toContain(READ_STOPPED_REASON);
  });

  it("negative control: the stop is newer than the last mail read -> the stopped sentence", async () => {
    const { text } = await troubleText([row(1, { processing_status: "failed", error: "claude_unavailable", created_at: "2026-11-03T00:00:00Z" }), PROCESSED(2, "2026-11-02T00:00:00Z")]);
    expect(text).toContain(READ_STOPPED_REASON);
    expect(text).not.toContain(READ_FAILED_REASON);
  });

  it("a sample mail or a Gmail confirmation read later does not end the stop (Claude was not used for them)", async () => {
    const { text } = await troubleText([
      row(1, { processing_status: "failed", error: "claude_unavailable", created_at: "2026-11-01T00:00:00Z" }),
      PROCESSED(2, "2026-11-02T00:00:00Z", { provider_email_id: "demo:sample/a" }),
      PROCESSED(3, "2026-11-02T00:00:00Z", { classification: "forwarding_confirmation" }),
    ]);
    expect(text).toContain(READ_STOPPED_REASON);
  });

  const STOP_AT = (iso: string) => row(1, { processing_status: "failed", error: "claude_unavailable", created_at: iso });

  it("a processed mail with no provider id and no classification is proof that Claude works again", async () => {
    const { text } = await troubleText([STOP_AT("2026-11-01T00:00:00Z"), PROCESSED(2, "2026-11-02T00:00:00Z", { provider_email_id: null, classification: null })]);
    expect(text).toContain(READ_FAILED_REASON);
    expect(text).not.toContain(READ_STOPPED_REASON);
  });

  it("a mail Claude refused after the stop is proof too: the failed sentence, not the stopped one", async () => {
    const { text } = await troubleText([STOP_AT("2026-11-01T00:00:00Z"), row(2, { processing_status: "failed", error: "model refused", created_at: "2026-11-02T00:00:00Z" })]);
    expect(text).toContain(READ_FAILED_REASON);
    expect(text).not.toContain(READ_STOPPED_REASON);
  });

  it("negative control: only a temporary Claude error after the stop is no proof -> still the stopped sentence", async () => {
    const { text } = await troubleText([STOP_AT("2026-11-01T00:00:00Z"), row(2, { processing_status: "failed", error: "claude_error", created_at: "2026-11-02T00:00:00Z" })]);
    expect(text).toContain(READ_STOPPED_REASON);
  });

  it("the unread rows could not be read -> the count is shown but no reason is stated", async () => {
    const { text } = await troubleText([STOPPED(1)], (db) => {
      db.hooks.push((q) => (q.table === "emails" && q.op === "select" && !q.head && String(q.columns).includes("error") ? { data: null, error: { message: "boom" } } : undefined));
    });
    expect(text).toContain("未読のメールが 1 通あります");
    for (const reason of [READ_STOPPED_REASON, READ_OVER_LIMIT_REASON, READ_FAILED_REASON]) expect(text).not.toContain(reason);
  });

  it("the last processed mail could not be read -> no reason is stated either", async () => {
    const { text } = await troubleText([STOPPED(1)], (db) => {
      db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "eq" && f.args[1] === "processed") ? { data: null, error: { message: "boom" } } : undefined));
    });
    expect(text).toContain("未読のメールが 1 通あります");
    for (const reason of [READ_STOPPED_REASON, READ_OVER_LIMIT_REASON, READ_FAILED_REASON]) expect(text).not.toContain(reason);
  });
});
