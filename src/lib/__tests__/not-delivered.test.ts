import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, describeQuery, scopedToUser, type Query } from "./fake-db";
import { findAll, hasClasses, parseHtml, textOf } from "./html-tree";

/**
 * [Feedback 3] Undo 「届いた」 later, from the parcel page.
 *
 * markNotDelivered(id) -> { ok: true } | { ok: false; error: string }, a Server Action in
 * src/app/app/parcel-actions.ts. Runs with the user's own session and names the user's id too.
 * Only a delivered parcel goes back; where to is decided by undeliveredStatus(the row it read),
 * never by the client. The update carries user_id, status = delivered and the updated_at it read,
 * and must change exactly one row: if a mail saved the delivery in between, nothing is written and
 * nothing is retried. Every failure answers 「更新できませんでした。開き直してください」.
 *
 * NotDeliveredButton({ id }), a client component in src/app/app/parcels/[id]/not-delivered-button.tsx:
 * the 「届いていない」 button. The parcel page shows it for a delivered parcel only.
 */

const USER = { id: "00000000-0000-4000-8000-00000000000a" };
const OTHER = "00000000-0000-4000-8000-0000000000ff";
const TRACKED = "11111111-1111-4111-8111-111111111111";
const BARE = "33333333-3333-4333-8333-333333333333";
const CARRIER_ONLY = "44444444-4444-4444-8444-444444444444";
const THEIRS = "22222222-2222-4222-8222-222222222222";
const READ_AT = "2026-11-01T00:00:00.000Z";
const FAILED = "更新できませんでした。開き直してください";

const mocks = vi.hoisted(() => ({
  state: { db: null as unknown, user: null as { id: string } | null },
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath, revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: mocks.state.user }, error: null }) } }),
  getUser: async () => mocks.state.user,
}));

const actions = await import("@/app/app/parcel-actions");
const markNotDelivered = (id: string) => (actions as unknown as { markNotDelivered: (id: string) => Promise<{ ok: boolean; error?: string }> }).markNotDelivered(id);

let db: FakeDb;
const parcel = (id: string, user_id: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id,
  shop: "テスト店",
  title: "テスト用の品名",
  status: "delivered",
  tracking_number: null,
  carrier: null,
  updated_at: READ_AT,
  ...over,
});

beforeEach(() => {
  db = new FakeDb({
    parcels: [
      parcel(TRACKED, USER.id, { tracking_number: "123456789012", carrier: "佐川急便" }),
      parcel(BARE, USER.id),
      parcel(CARRIER_ONLY, USER.id, { carrier: "ヤマト運輸" }),
      parcel(THEIRS, OTHER, { tracking_number: "999999999999" }),
    ],
    parcel_items: [],
    extractions: [],
    emails: [],
  });
  mocks.state.db = db;
  mocks.state.user = USER;
  mocks.revalidatePath.mockClear();
});

const statusOf = (id: string) => db.find("parcels", id)!.status;
const updates = () => db.callsOn("parcels", "update");

describe("markNotDelivered: where the parcel goes back to", () => {
  it("puts a parcel with a tracking number back to shipped", async () => {
    expect(await markNotDelivered(TRACKED)).toEqual({ ok: true });
    expect(statusOf(TRACKED)).toBe("shipped");
  });

  it("puts a parcel with only a carrier back to shipped", async () => {
    expect(await markNotDelivered(CARRIER_ONLY)).toEqual({ ok: true });
    expect(statusOf(CARRIER_ONLY)).toBe("shipped");
  });

  it("puts a parcel with neither back to ordered", async () => {
    expect(await markNotDelivered(BARE)).toEqual({ ok: true });
    expect(statusOf(BARE)).toBe("ordered");
  });

  it("writes the status and received_at (cleared) and nothing else", async () => {
    await markNotDelivered(TRACKED);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].values).toEqual({ status: "shipped", received_at: null });
    const row = db.find("parcels", TRACKED)!;
    expect(row.tracking_number).toBe("123456789012");
    expect(row.carrier).toBe("佐川急便");
  });

  it("redraws the app after a change, and only then", async () => {
    await markNotDelivered(BARE);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app", "layout");
  });
});

describe("markNotDelivered: the update's conditions", () => {
  it("reads the parcel as the signed-in user, by id", async () => {
    await markNotDelivered(TRACKED);
    const reads = db.callsOn("parcels", "select");
    expect(reads.length).toBeGreaterThanOrEqual(1);
    for (const q of reads) {
      expect(scopedToUser(q, USER.id), describeQuery(q)).toBe(true);
      expect(q.filters.some((f) => f.method === "eq" && f.args[0] === "id" && f.args[1] === TRACKED), describeQuery(q)).toBe(true);
    }
  });

  it("updates with user_id, status = delivered and the updated_at it read, and asks back the id", async () => {
    await markNotDelivered(TRACKED);
    expect(updates()).toHaveLength(1);
    const q: Query = updates()[0];
    const eq = (column: string) => q.filters.filter((f) => f.method === "eq" && f.args[0] === column).map((f) => f.args[1]);
    expect(eq("id"), describeQuery(q)).toEqual([TRACKED]);
    expect(eq("user_id"), describeQuery(q)).toEqual([USER.id]);
    expect(eq("status"), describeQuery(q)).toEqual(["delivered"]);
    expect(eq("updated_at"), describeQuery(q)).toEqual([READ_AT]);
    expect(q.returning).toBe("id");
  });
});

describe("markNotDelivered: fails without writing", () => {
  it("refuses when nobody is signed in, before touching the database", async () => {
    mocks.state.user = null;
    expect(await markNotDelivered(TRACKED)).toEqual({ ok: false, error: FAILED });
    expect(db.calls).toHaveLength(0);
    expect(statusOf(TRACKED)).toBe("delivered");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["not-a-uuid", "", "11111111-1111-4111-8111-11111111111", `${TRACKED} `, "1; drop table parcels"])("refuses the id %j before touching the database", async (id) => {
    expect(await markNotDelivered(id)).toEqual({ ok: false, error: FAILED });
    expect(db.calls).toHaveLength(0);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["ordered", "shipped", "out_for_delivery", "attempted", "cancelled", "unknown"])("leaves a %s parcel as it is", async (status) => {
    db.find("parcels", TRACKED)!.status = status;
    expect(await markNotDelivered(TRACKED)).toEqual({ ok: false, error: FAILED });
    expect(statusOf(TRACKED)).toBe(status);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not reach another user's parcel", async () => {
    expect(await markNotDelivered(THEIRS)).toEqual({ ok: false, error: FAILED });
    expect(statusOf(THEIRS)).toBe("delivered");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("fails on a parcel that is not there", async () => {
    expect(await markNotDelivered("55555555-5555-4555-8555-555555555555")).toEqual({ ok: false, error: FAILED });
    expect(updates().every((q) => q.filters.some((f) => f.method === "eq" && f.args[0] === "user_id"))).toBe(true);
  });

  it("[Codex-001] keeps 届いた when a mail saved the delivery between the read and the update, without retrying", async () => {
    // Another writer (the mail pipeline) saves the parcel again just before the update runs.
    db.hooks.push((q, d) => {
      if (q.table === "parcels" && q.op === "update") {
        const row = d.find("parcels", TRACKED)!;
        row.status = "delivered";
        row.updated_at = d.tick();
      }
    });
    expect(await markNotDelivered(TRACKED)).toEqual({ ok: false, error: FAILED });
    expect(statusOf(TRACKED)).toBe("delivered");
    expect(updates()).toHaveLength(1);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("logs a database error and fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "parcels" ? { data: null, error: { message: "boom" } } : undefined));
    try {
      expect(await markNotDelivered(TRACKED)).toEqual({ ok: false, error: FAILED });
      expect(log).toHaveBeenCalled();
      expect(statusOf(TRACKED)).toBe("delivered");
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("logs an error from the update and fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "parcels" && q.op === "update" ? { data: null, error: { message: "boom" } } : undefined));
    try {
      expect(await markNotDelivered(TRACKED)).toEqual({ ok: false, error: FAILED });
      expect(log).toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe("markNotDelivered: the existing undo keeps working", () => {
  it("marks a parcel received and puts it back with the undo, received_at included", async () => {
    db.find("parcels", BARE)!.status = "shipped";
    const receipt = await actions.markDeliveredForUndo([BARE]);
    expect(receipt.saved).toBe(1);
    expect(statusOf(BARE)).toBe("delivered");
    expect(db.find("parcels", BARE)!.received_at).not.toBeNull();
    await actions.restoreStatuses(receipt.written);
    expect(statusOf(BARE)).toBe("shipped");
    expect(db.find("parcels", BARE)!.received_at).toBeNull();
  });
});

describe("parcel-actions.ts", () => {
  const source = readFileSync(path.resolve(__dirname, "../../app/app/parcel-actions.ts"), "utf8");

  it("exports async functions only (a \"use server\" file)", () => {
    expect(source.startsWith('"use server";')).toBe(true);
    const exports = source.split("\n").filter((l) => /^\s*export\b/.test(l));
    expect(exports.length).toBeGreaterThanOrEqual(3);
    for (const l of exports) expect(l).toMatch(/^export async function \w+\(/);
    expect(source).toMatch(/export async function markNotDelivered\(/);
  });

  it("decides the status with undeliveredStatus from src/lib, not from the client", () => {
    expect(source).toMatch(/import\s*\{[^}]*\bundeliveredStatus\b[^}]*\}\s*from\s*["']@\/lib\/undelivered["']/);
    expect(source).toMatch(/export async function markNotDelivered\(\s*\w+\s*:\s*string\s*\)/);
  });
});

describe("NotDeliveredButton", () => {
  const load = async () => (await import("@/app/app/parcels/[id]/not-delivered-button")).NotDeliveredButton;
  const sourcePath = path.resolve(__dirname, "../../app/app/parcels/[id]/not-delivered-button.tsx");

  it("draws one 「届いていない」 button, styled like 編集", async () => {
    const NotDeliveredButton = await load();
    const root = parseHtml(renderToStaticMarkup(createElement(NotDeliveredButton, { id: TRACKED })));
    const buttons = findAll(root, (n) => n.tag === "button");
    expect(buttons).toHaveLength(1);
    expect(textOf(buttons[0]).trim()).toBe("届いていない");
    expect(hasClasses(buttons[0], "rounded-full", "border", "text-sm"), buttons[0].attrs.class).toBe(true);
    expect(buttons[0].attrs.disabled).toBeUndefined();
    expect(textOf(root)).not.toContain(FAILED);
  });

  it("is a client component that calls markNotDelivered through the shared pending button (spinner and 「戻しています…」, one press at a time: press-feedback.test.ts)", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).toContain("markNotDelivered");
    expect(source).toMatch(/import\s*\{[^}]*\bPendingButton\b[^}]*\busePendingAction\b[^}]*\}\s*from\s*["']@\/components\/pending-button["']/);
    expect(source).toMatch(/<PendingButton\b[^>]*\bpending=\{pending\}[^>]*\bpendingLabel="戻しています…"/);
    expect(source).toMatch(/\brun\(async\b/);
  });

  it("says 「更新できませんでした。開き直してください」 when it fails", () => {
    expect(readFileSync(sourcePath, "utf8")).toContain(FAILED);
  });
});

describe("parcel page", () => {
  const render = async (id: string) => {
    const Page = (await import("@/app/app/parcels/[id]/page")).default;
    return parseHtml(renderToStaticMarkup(await Page({ params: Promise.resolve({ id }) })));
  };
  const notDeliveredButtons = (root: ReturnType<typeof parseHtml>) => findAll(root, (n) => n.tag === "button" && textOf(n).includes("届いていない"));

  it("offers 「届いていない」 on a delivered parcel", async () => {
    expect(notDeliveredButtons(await render(TRACKED))).toHaveLength(1);
  });

  it.each(["ordered", "shipped", "out_for_delivery", "attempted", "cancelled", "unknown"])("does not offer it on a %s parcel", async (status) => {
    db.find("parcels", TRACKED)!.status = status;
    expect(notDeliveredButtons(await render(TRACKED))).toHaveLength(0);
  });

  // [Review D2-1] The swipe's button shows only while swiping: the page offers 「受け取った」 to everyone who has not said so.
  const deliveredButtons = (root: ReturnType<typeof parseHtml>) => findAll(root, (n) => n.tag === "button" && textOf(n).trim() === "受け取った");

  it.each(["ordered", "shipped", "out_for_delivery", "attempted", "unknown"])("offers 「受け取った」 on a %s parcel, styled like 編集", async (status) => {
    db.find("parcels", TRACKED)!.status = status;
    const found = deliveredButtons(await render(TRACKED));
    expect(found).toHaveLength(1);
    expect(hasClasses(found[0], "rounded-full", "border", "text-sm"), found[0].attrs.class).toBe(true);
    expect(found[0].attrs.disabled).toBeUndefined();
  });

  it("does not offer 「受け取った」 on a cancelled parcel", async () => {
    db.find("parcels", TRACKED)!.status = "cancelled";
    expect(deliveredButtons(await render(TRACKED))).toHaveLength(0);
  });

  it("offers both 「受け取った」 and 「届いていない」 on a delivered parcel not yet received", async () => {
    const root = await render(TRACKED);
    expect(deliveredButtons(root)).toHaveLength(1);
    expect(notDeliveredButtons(root)).toHaveLength(1);
  });

  it("offers only 「受け取っていない」 on a received parcel", async () => {
    db.find("parcels", TRACKED)!.received_at = "2026-11-02T00:00:00Z";
    const root = await render(TRACKED);
    expect(findAll(root, (n) => n.tag === "button" && textOf(n).trim() === "受け取っていない")).toHaveLength(1);
    expect(deliveredButtons(root)).toHaveLength(0);
    expect(notDeliveredButtons(root)).toHaveLength(0);
  });
});
