import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "@/lib/crypto/bytes";
import { createKeyPair } from "@/lib/crypto/key-wrap";
import type { InboundEmail } from "@/lib/pipeline";
import { FakeDb, type Row } from "./fake-db";
import { USER, asAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * screen_events keeps the subject of a dropped ad (disclosed: 14 days, shown in settings so a
 * wrong drop can be noticed). A mail the second look rescues is read and sealed: its subject must
 * not be left behind in screen_events in plaintext.
 */

const order = reading({ relevance: "order", order_number: sure("ORD-77770000"), items: [item("テスト商品", 900)], total_amount: sure(900) });
vi.mock("@/lib/extract/extract", () => ({ extractEmail: vi.fn(async () => precomputed(order)) }));

const { processInboundEmail } = await import("@/lib/pipeline");

const AD_SUBJECT = "【テスト店】週末セール開催中";

function ad(over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    ...mailOf("2026-11-03T01:00:00Z"),
    messageId: "<ad1@example.test>",
    from: "news@shop.example.test",
    subject: AD_SUBJECT,
    text: "今週の特集です。配信停止はこちら",
    html: null,
    ...over,
  };
}

async function keyedUser(db: FakeDb) {
  const k = await createKeyPair();
  db.rows("user_keys").push({ user_id: USER, key_id: k.keyId, public_key: toBase64(k.publicKey), activated_at: "2026-11-01T00:00:00Z", retired_at: null });
}

/** screen_events rows that hold the subject of a mail that was in fact read. */
function readSubjectsLeft(db: FakeDb): Row[] {
  return db.rows("screen_events").filter((e) => e.decision !== "dropped" && e.subject != null);
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("screen_events: the subject is kept only for a dropped mail", () => {
  it("a dropped ad keeps its subject and sender domain, and no mail row", async () => {
    const db = new FakeDb();
    const out = await processInboundEmail(asAdmin(db), ad());
    expect(out.kind).toBe("screened_out");
    expect(db.rows("screen_events")).toMatchObject([{ decision: "dropped", subject: AD_SUBJECT, from_domain: "shop.example.test" }]);
    expect(db.rows("emails")).toHaveLength(0);
  });

  it("a rescued mail (the user marked the sender) is read and sealed, and its subject is not logged", async () => {
    const db = new FakeDb();
    await keyedUser(db);
    db.rows("screen_events").push({ id: "flag", user_id: USER, decision: "dropped", subject: "前に落とした広告", from_domain: "shop.example.test", flagged_at: "2026-11-02T00:00:00Z", created_at: "2026-11-02T00:00:00Z" });

    const out = await processInboundEmail(asAdmin(db), ad({ subject: "【テスト店】週末セール開催中 ご注文の件" }));
    expect(out.kind).toBe("processed");
    const rescued = db.rows("screen_events").filter((e) => e.decision === "rescued");
    expect(rescued).toHaveLength(1);
    expect(rescued[0]).toMatchObject({ subject: null, from_domain: "shop.example.test" });
    expect(db.rows("emails")[0]).toMatchObject({ body_state: "sealed", subject: null });
    expect(readSubjectsLeft(db)).toEqual([]);
    // The subject of the read mail is nowhere in plaintext.
    expect(JSON.stringify(db.tables)).not.toContain("ご注文の件");
  });

  it("negative control: the check finds a rescued row that kept its subject", () => {
    const db = new FakeDb();
    db.rows("screen_events").push({ id: "x", user_id: USER, decision: "rescued", subject: "件名", from_domain: "a.test" });
    expect(readSubjectsLeft(db)).toHaveLength(1);
  });
});
