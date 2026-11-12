import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDismissIntakeNotice } from "@/lib/settings-mail-actions";
import { runMarkWronglyDropped } from "@/lib/mail-run";
import { READ_FAILED_NOTICE, READ_STORAGE_CONFIRM, READ_STORAGE_LIMIT_NOTICE } from "@/lib/read-notices";
import type { AdminClient } from "@/lib/supabase/admin";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

const USER = { id: "00000000-0000-4000-8000-00000000000a", email: "owner@personal.example.test" };
const STAMP = "2026-11-12T01:00:00.123456+00:00";
const EVENT = "11111111-1111-4111-8111-111111111111";
const CLOSE_FAILED = "通知を閉じられませんでした。もう一度お試しください。";
const mocks = vi.hoisted(() => ({ db: null as unknown, revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.db, getUser: async () => USER }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

const { dismissIntakeNotice, markWronglyDropped } = await import("@/app/app/settings/actions");
const TroublePage = (await import("@/app/app/settings/trouble/page")).default;
const DroppedPage = (await import("@/app/app/settings/dropped/page")).default;
let db: FakeDb;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T03:00:00Z"));
  db = new FakeDb({
    mail_intake_notices: [{ user_id: USER.id, limited_at: STAMP, reason: "user_storage_limit" }],
    screen_events: [{ id: EVENT, user_id: USER.id, decision: "dropped", subject: "Synthetic order notice", from_domain: "shop.example.test", created_at: "2026-10-01T00:00:00Z", flagged_at: null }],
    ai_reading_consents: [{ user_id: USER.id, decision: "granted", decided_at: STAMP, text_version: "v1" }],
  });
  mocks.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const admin = () => db as unknown as AdminClient;
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("expectedUserId", USER.id);
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}
async function destination(action: Promise<void>): Promise<string> {
  try { await action; } catch (error) {
    const digest = error instanceof Error && "digest" in error ? error.digest : null;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";").slice(2, -2).join(";");
    throw error;
  }
  throw new Error("the action did not redirect");
}
const paramsFrom = (to: string) => Object.fromEntries(new URL(to, "https://otodoke.invalid").searchParams);
function failNoticeDeleteOnly() {
  db.hooks.push((query) => query.table === "mail_intake_notices" && query.op === "delete" ? { data: null, error: { message: "synthetic notice deletion failure" } } : undefined);
}
function purgeBeforeMark() {
  let purged = false;
  db.hooks.push((query, fake) => {
    if (query.table !== "screen_events" || query.op !== "update" || purged) return;
    expect(fake.callsOn("screen_events", "select")).toHaveLength(1);
    const row = fake.find("screen_events", EVENT)!;
    expect(row.flagged_at).toBeNull();
    expect(Date.parse(String(row.created_at))).toBeLessThan(Date.now() - 14 * 24 * 60 * 60 * 1000);
    // A concurrent writer deletes the row. This does not execute the SQL cron itself.
    fake.tables.screen_events = fake.rows("screen_events").filter((item) => item.id !== EVENT);
    purged = true;
  });
  return () => expect(purged).toBe(true);
}

describe("R4-3: acknowledging a storage notice has its own recoverable failure", () => {
  it("keeps the shared dismiss_failed contract and retains the notice when only DELETE fails", async () => {
    failNoticeDeleteOnly();
    expect(await runDismissIntakeNotice(admin(), USER.id, STAMP)).toEqual({ ok: false, code: "dismiss_failed" });
    expect(db.rows("mail_intake_notices")).toHaveLength(1);
    expect(db.rows("emails")).toEqual([]);
  });

  it("redirects the real Web action to the notification-confirmation error, rather than a read failure", async () => {
    failNoticeDeleteOnly();
    const to = await destination(dismissIntakeNotice(form({ limited_at: STAMP })));
    expect(db.callsOn("mail_intake_notices", "delete")).toHaveLength(1);
    expect(db.rows("mail_intake_notices")).toHaveLength(1);
    expect(to).toBe("/app/settings/trouble?error=notice_confirm_failed");
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("redraws the real page with the notice and retry button, zero unread, and the provisional close-failure sentence", async () => {
    failNoticeDeleteOnly();
    const to = await destination(dismissIntakeNotice(form({ limited_at: STAMP })));
    const markup = renderToStaticMarkup(await TroublePage({ searchParams: Promise.resolve(paramsFrom(to)) }));
    const html = parseHtml(markup);
    const text = textOf(html);
    expect(text).toContain(READ_STORAGE_LIMIT_NOTICE);
    expect(text).toContain("未読のメールはありません。");
    expect(findAll(html, (node) => node.tag === "button" && textOf(node) === READ_STORAGE_CONFIRM)).toHaveLength(1);
    expect(findAll(html, (node) => node.tag === "input" && node.attrs.name === "limited_at").map((node) => node.attrs.value)).toEqual([STAMP]);
    expect(text).toContain(CLOSE_FAILED);
    expect(text).not.toContain(READ_FAILED_NOTICE);
    expect(text).not.toContain("synthetic notice deletion failure");
  });

  it("still removes a confirmed notice and redraws without its failure or retry control", async () => {
    const to = await destination(dismissIntakeNotice(form({ limited_at: STAMP })));
    expect(to).toBe("/app/settings/trouble");
    expect(db.rows("mail_intake_notices")).toEqual([]);
    const markup = renderToStaticMarkup(await TroublePage({ searchParams: Promise.resolve(paramsFrom(to)) }));
    expect(markup).toContain("未読のメールはありません。");
    expect(markup).not.toContain(READ_STORAGE_LIMIT_NOTICE);
    expect(markup).not.toContain(CLOSE_FAILED);
    expect(markup).not.toContain('name="limited_at"');
  });
});

describe("R4-5: purge between the lookup and the mark cannot report remembered", () => {
  it("returns the existing not_found result when the actual shared UPDATE reaches zero rows", async () => {
    const assertPurged = purgeBeforeMark();
    const result = await runMarkWronglyDropped(admin(), USER.id, USER.email, EVENT);
    assertPurged();
    expect(db.callsOn("screen_events", "update")).toHaveLength(1);
    expect(db.rows("screen_events")).toEqual([]);
    expect(result).toEqual({ ok: false, code: "not_found" });
  });

  it("redraws the Web page as failed after the purge, without recreating a domain mark or claiming it remembered", async () => {
    const assertPurged = purgeBeforeMark();
    const to = await destination(markWronglyDropped(form({ id: EVENT })));
    assertPurged();
    expect(db.rows("screen_events")).toEqual([]);
    const markup = renderToStaticMarkup(await DroppedPage({ searchParams: Promise.resolve(paramsFrom(to)) }));
    expect(textOf(parseHtml(markup))).toContain("記録できませんでした。もう一度お試しください。");
    expect(markup).not.toContain("覚えました。");
    expect(to).toBe("/app/settings/dropped?flagged=failed");
    expect(db.callsOn("screen_events", "insert")).toEqual([]);
    expect(db.callsOn("screen_events", "upsert")).toEqual([]);
    expect(mocks.revalidate).toHaveBeenCalledWith("/app/settings/dropped");
  });

  it("still confirms a normal shared-helper mark for the same owner and immutable event id", async () => {
    expect(await runMarkWronglyDropped(admin(), USER.id, USER.email, EVENT)).toEqual({ ok: true, outcome: "remembered" });
    expect(db.find("screen_events", EVENT)!.flagged_at).not.toBeNull();
    expect(db.callsOn("screen_events", "update")[0].filters).toEqual([{ method: "eq", args: ["id", EVENT] }, { method: "eq", args: ["user_id", USER.id] }]);
  });

  it.each([
    { name: "no returned data", data: null },
    { name: "multiple returned rows", data: [{ id: EVENT }, { id: "22222222-2222-4222-8222-222222222222" }] },
    { name: "a different returned id", data: [{ id: "22222222-2222-4222-8222-222222222222" }] },
  ])("does not claim remembered with $name", async ({ data }) => {
    db.hooks.push((query) => query.table === "screen_events" && query.op === "update" ? { data, error: null } : undefined);
    expect(await runMarkWronglyDropped(admin(), USER.id, USER.email, EVENT)).toEqual({ ok: false, code: "mark_failed", message: "mark was not confirmed" });
    expect(db.callsOn("screen_events", "select")).toHaveLength(1);
    expect(db.callsOn("screen_events", "update")).toHaveLength(1);
    expect(db.find("screen_events", EVENT)!.flagged_at).toBeNull();
  });

  it("accepts an uppercase UUID request when the database confirms its canonical lowercase UUID", async () => {
    const canonicalId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const requestedId = canonicalId.toUpperCase();
    db.rows("screen_events")[0].id = canonicalId;
    // FakeDb compares strings exactly. Model only PostgreSQL's UUID comparison/return boundary.
    db.hooks.push((query, fake) => {
      if (query.table !== "screen_events") return;
      expect(query.filters).toContainEqual({ method: "eq", args: ["id", requestedId] });
      expect(query.filters).toContainEqual({ method: "eq", args: ["user_id", USER.id] });
      const row = fake.find("screen_events", canonicalId)!;
      if (query.op === "select") return { data: { subject: row.subject, from_domain: row.from_domain }, error: null };
      if (query.op === "update") {
        row.flagged_at = new Date().toISOString();
        return { data: [{ id: canonicalId }], error: null };
      }
    });
    expect(await runMarkWronglyDropped(admin(), USER.id, USER.email, requestedId)).toEqual({ ok: true, outcome: "remembered" });
    expect(db.find("screen_events", canonicalId)!.flagged_at).not.toBeNull();
  });

  it("still redraws a confirmed normal mark as remembered", async () => {
    const to = await destination(markWronglyDropped(form({ id: EVENT })));
    expect(to).toBe("/app/settings/dropped?flagged=remembered");
    const markup = renderToStaticMarkup(await DroppedPage({ searchParams: Promise.resolve(paramsFrom(to)) }));
    expect(markup).toContain("覚えました。");
    expect(markup).toContain("荷物として記録済み");
    expect(markup).not.toContain("記録できませんでした。");
  });
});
