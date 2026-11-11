import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliveryEvidence } from "@/lib/delivery-evidence";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * The parcel page shows the line a delivery mail gave as its reason (relevance_evidence of a
 * mail read as delivered), as one row of the detail card. The newest delivery mail wins; with
 * none, no row. The line is the mail's own text, never made up.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const PARCEL = "11111111-1111-4111-8111-111111111111";

describe("deliveryEvidence", () => {
  it("is the line of a delivery mail", () => {
    expect(deliveryEvidence([{ result: { relevance: "delivered", relevance_evidence: "宅配ボックスに配達しました" }, sentAt: "2026-11-01T00:00:00Z" }])).toBe("宅配ボックスに配達しました");
  });

  it("is null when no mail was read as delivered, however many lines the others have", () => {
    expect(
      deliveryEvidence([
        { result: { relevance: "shipped", relevance_evidence: "発送しました" }, sentAt: "2026-11-01T00:00:00Z" },
        { result: { relevance: "out_for_delivery", relevance_evidence: "本日配達予定" }, sentAt: "2026-11-02T00:00:00Z" },
      ]),
    ).toBeNull();
    expect(deliveryEvidence([])).toBeNull();
  });

  it("is null when the delivery mail gave no line, or a blank one", () => {
    for (const relevance_evidence of [null, undefined, "", "   ", 5]) {
      expect(deliveryEvidence([{ result: { relevance: "delivered", relevance_evidence }, sentAt: "2026-11-01T00:00:00Z" }])).toBeNull();
    }
    expect(deliveryEvidence([{ result: null, sentAt: null }])).toBeNull();
  });

  it("takes the newest of several delivery mails, whatever their order", () => {
    const old = { result: { relevance: "delivered", relevance_evidence: "玄関前に配達しました" }, sentAt: "2026-11-01T00:00:00Z" };
    const fresh = { result: { relevance: "delivered", relevance_evidence: "宅配ボックスに配達しました" }, sentAt: "2026-11-03T00:00:00Z" };
    expect(deliveryEvidence([old, fresh])).toBe("宅配ボックスに配達しました");
    expect(deliveryEvidence([fresh, old])).toBe("宅配ボックスに配達しました");
  });

  it("skips a newer delivery mail with no line and uses the older one that has one", () => {
    const old = { result: { relevance: "delivered", relevance_evidence: "玄関前に配達しました" }, sentAt: "2026-11-01T00:00:00Z" };
    const empty = { result: { relevance: "delivered", relevance_evidence: null }, sentAt: "2026-11-03T00:00:00Z" };
    expect(deliveryEvidence([old, empty])).toBe("玄関前に配達しました");
  });
});

const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
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
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: [{ id: PARCEL, user_id: USER, shop: "テスト店", title: "テスト用の品名", status: "delivered", source: "mail" }], parcel_items: [] });
  mocks.state.db = db;
});

function addMail(id: string, sentAt: string, result: Record<string, unknown>) {
  db.rows("emails").push({ id, user_id: USER, sent_at: sentAt, classification: "delivery", subject: "件名", from_name: null, from_address: "a@example.test", text_body: "本文", html_body: null, body_state: "plain" });
  db.rows("extractions").push({ id: `x-${id}`, user_id: USER, parcel_id: PARCEL, email_id: id, confidence: 0.9, result, created_at: sentAt });
}

async function rows() {
  const Page = (await import("@/app/app/parcels/[id]/page")).default;
  const root = parseHtml(renderToStaticMarkup(await Page({ params: Promise.resolve({ id: PARCEL }) })));
  const dl = findAll(root, (n) => n.tag === "dl")[0];
  const kids = dl.children.filter((c) => typeof c !== "string");
  const out: Record<string, string> = {};
  for (let i = 0; i < kids.length; i += 2) out[textOf(kids[i]).trim()] = textOf(kids[i + 1]).trim();
  return out;
}

describe("parcel page: the delivery mail's line", () => {
  it("shows the line of the one delivery mail, in the mail's own words", async () => {
    addMail("e1", "2026-11-01T00:00:00Z", { relevance: "delivered", relevance_evidence: "宅配ボックスに配達しました" });
    expect((await rows())["配達完了"]).toBe("「宅配ボックスに配達しました」");
  });

  it("shows no row when the parcel has no delivery mail", async () => {
    addMail("e1", "2026-11-01T00:00:00Z", { relevance: "shipped", relevance_evidence: "発送しました" });
    const r = await rows();
    expect(Object.keys(r)).not.toContain("配達完了");
    expect(JSON.stringify(r)).not.toContain("発送しました");
  });

  it("shows no row when the delivery mail gave no line", async () => {
    addMail("e1", "2026-11-01T00:00:00Z", { relevance: "delivered", relevance_evidence: null });
    expect(Object.keys(await rows())).not.toContain("配達完了");
  });

  it("shows the newest of several delivery mails", async () => {
    addMail("e1", "2026-11-01T00:00:00Z", { relevance: "delivered", relevance_evidence: "玄関前に配達しました" });
    addMail("e2", "2026-11-03T00:00:00Z", { relevance: "delivered", relevance_evidence: "宅配ボックスに配達しました" });
    expect((await rows())["配達完了"]).toBe("「宅配ボックスに配達しました」");
  });
});
