import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountChangedPath } from "@/lib/action-identity";
import { runMarkWronglyDropped } from "@/lib/mail-run";
import type { AdminClient } from "@/lib/supabase/admin";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

const A = { id: "00000000-0000-4000-8000-00000000000a", email: "a@example.test" };
const B = { id: "00000000-0000-4000-8000-00000000000b", email: "b@example.test" };
const EVENT_A = "11111111-1111-4111-8111-111111111111";
const EVENT_B = "22222222-2222-4222-8222-222222222222";
const LOOKUP_ERROR = "synthetic lookup unavailable";
const mocks = vi.hoisted(() => ({ user: null as { id: string; email: string } | null, db: null as unknown, admin: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => mocks.user,
  createClient: async () => Object.assign(mocks.db as FakeDb, { auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }), getSession: async () => ({ data: { session: mocks.user ? { access_token: `header.${Buffer.from(JSON.stringify({ sub: mocks.user.id })).toString("base64url")}.sig` } : null }, error: null }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));

const { markWronglyDropped } = await import("@/app/app/settings/actions");
const DroppedPage = (await import("@/app/app/settings/dropped/page")).default;
let db: FakeDb;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = A;
  db = new FakeDb({ screen_events: [
    { id: EVENT_A, user_id: A.id, decision: "dropped", subject: "Your parcel is coming", from_domain: "shop-a.example.test", created_at: "2026-11-12T00:00:00Z", flagged_at: null },
    { id: EVENT_B, user_id: B.id, decision: "dropped", subject: "Another parcel", from_domain: "shop-b.example.test", created_at: "2026-11-12T00:00:01Z", flagged_at: null },
  ] });
  mocks.db = db;
  mocks.admin.mockReturnValue(db);
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function form(expected: string | undefined, id = EVENT_A): FormData {
  const data = new FormData();
  if (expected !== undefined) data.set("expectedUserId", expected);
  data.set("id", id);
  return data;
}

/** Catch only Next's real redirect; setup or database exceptions cannot masquerade as recovery. */
async function destination(action: Promise<void>): Promise<string> {
  try { await action; } catch (error) {
    const digest = error instanceof Error && "digest" in error ? error.digest : null;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";").slice(2, -2).join(";");
    throw error;
  }
  throw new Error("the action did not redirect");
}

function failLookup() {
  db.hooks.push((query) => query.table === "screen_events" && query.op === "select" ? { data: null, error: { message: LOOKUP_ERROR } } : undefined);
}
const asAdmin = () => db as unknown as AdminClient;
const flagged = () => db.rows("screen_events").map((row) => row.flagged_at);
const updates = () => db.callsOn("screen_events", "update");
async function failedPageText() {
  return textOf(parseHtml(renderToStaticMarkup(await DroppedPage({ searchParams: Promise.resolve({ flagged: "failed" }) }))));
}

describe("the dropped-mail Web action uses the displayed account before touching admin data", () => {
  it("sends an old A form to identity recovery before admin creation or any lookup under B", async () => {
    const oldForm = form(A.id);
    mocks.user = B;
    const to = await destination(markWronglyDropped(oldForm));
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(db.callsOn("screen_events")).toEqual([]);
    expect(updates()).toEqual([]);
    expect(flagged()).toEqual([null, null]);
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(to).toBe(accountChangedPath("/app/settings/dropped"));
  });

  it.each([undefined, "", "not-a-user-id"])("does not read or mark the current account without a matching expected identity: %j", async (expected) => {
    const to = await destination(markWronglyDropped(form(expected)));
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(db.callsOn("screen_events")).toEqual([]);
    expect(updates()).toEqual([]);
    expect(to).toBe(accountChangedPath("/app/settings/dropped"));
  });

  it("keeps the displayed A id in each rendered 'this is a parcel' form", async () => {
    // RLS supplies only A's rows to the SSR page; its forms must retain that same rendered owner.
    db.rows("screen_events").splice(1);
    const html = parseHtml(renderToStaticMarkup(await DroppedPage({ searchParams: Promise.resolve({}) })));
    const forms = findAll(html, (node) => node.tag === "form" && findAll(node, (child) => child.tag === "button" && textOf(child) === "これは荷物").length > 0);
    expect(forms).toHaveLength(1);
    expect(findAll(forms[0], (node) => node.tag === "input" && node.attrs.name === "id").map((node) => node.attrs.value)).toEqual([EVENT_A]);
    expect(findAll(forms[0], (node) => node.tag === "input" && node.attrs.name === "expectedUserId").map((node) => node.attrs.value)).toEqual([A.id]);
  });

  it("still remembers A's sender when the same displayed account A is verified", async () => {
    expect(await destination(markWronglyDropped(form(A.id)))).toBe("/app/settings/dropped?flagged=remembered");
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(db.callsOn("screen_events", "select")).toHaveLength(1);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].filters).toContainEqual({ method: "eq", args: ["user_id", A.id] });
    expect(db.find("screen_events", EVENT_A)!.flagged_at).not.toBeNull();
    expect(db.find("screen_events", EVENT_B)!.flagged_at).toBeNull();
  });
});

describe("the shared mark helper keeps owner mismatch separate from a failed database read", () => {
  it("returns not_found for another owner's existing event and never updates it", async () => {
    expect(await runMarkWronglyDropped(asAdmin(), A.id, A.email, EVENT_B)).toEqual({ ok: false, code: "not_found" });
    expect(db.callsOn("screen_events", "select")).toHaveLength(1);
    expect(updates()).toEqual([]);
    expect(flagged()).toEqual([null, null]);
  });

  it("returns lookup_failed only for a database lookup error and never updates", async () => {
    failLookup();
    expect(await runMarkWronglyDropped(asAdmin(), A.id, A.email, EVENT_A)).toEqual({ ok: false, code: "lookup_failed", message: LOOKUP_ERROR });
    expect(db.callsOn("screen_events", "select")).toHaveLength(1);
    expect(updates()).toEqual([]);
    expect(flagged()).toEqual([null, null]);
  });

  it("shows Web failed after owner mismatch without changing the shared not_found contract", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await destination(markWronglyDropped(form(A.id, EVENT_B)))).toBe("/app/settings/dropped?flagged=failed");
    expect(db.callsOn("screen_events", "select")).toHaveLength(1);
    expect(updates()).toEqual([]);
    expect(flagged()).toEqual([null, null]);
    expect(log).not.toHaveBeenCalled();
    expect(await failedPageText()).toContain("記録できませんでした。もう一度お試しください。");
  });

  it("shows Web failed after a lookup failure, logs only that failure and never updates", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    failLookup();
    expect(await destination(markWronglyDropped(form(A.id)))).toBe("/app/settings/dropped?flagged=failed");
    expect(db.callsOn("screen_events", "select")).toHaveLength(1);
    expect(updates()).toEqual([]);
    expect(flagged()).toEqual([null, null]);
    expect(log).toHaveBeenCalledExactlyOnceWith("markWronglyDropped (lookup):", LOOKUP_ERROR);
    expect(await failedPageText()).toContain("記録できませんでした。もう一度お試しください。");
  });
});
