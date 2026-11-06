import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundEmail } from "@/lib/pipeline";
import { FakeDb, type Query } from "./fake-db";
import { USER, asAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * Review R1-3, turned into regression tests: reading a stored unread mail again (設定 「読み取る」,
 * or a webhook redelivery) used to delete the stored row and then insert the mail anew. If that
 * insert failed, the only copy of the mail was gone. Now the stored row is taken over in place,
 * under its own id, only while it is as it was read. Made-up mails only.
 *
 * Also: a mail that was read is found before the free screen runs, so its redelivery is a
 * duplicate even when the screen would drop it (it used to remove the read row, review B-5).
 */

const order = reading({ relevance: "order", order_number: sure("ORD-66660000"), items: [item("テスト商品", 1200)], total_amount: sure(1200) });
const mocks = vi.hoisted(() => ({ extractEmail: vi.fn(), isPurchaseMail: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extractEmail }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.isPurchaseMail }));

const { processInboundEmail } = await import("@/lib/pipeline");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extractEmail.mockReset();
  mocks.extractEmail.mockImplementation(async () => precomputed(order));
  mocks.isPurchaseMail.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const STORED_AT = "2026-11-01T00:00:00Z";
const waiting = (over: Partial<InboundEmail> = {}): InboundEmail => ({ ...mailOf("2026-11-03T01:00:00Z"), messageId: "<waiting@example.test>", subject: "ご注文ありがとうございます", text: "ご注文番号 ORD-66660000 を承りました", ...over });

function seeded(mail: InboundEmail, status = "over_limit") {
  return new FakeDb({
    emails: [{ id: "e-waiting", user_id: USER, message_id: mail.messageId, subject: mail.subject, text_body: mail.text, html_body: mail.html, from_address: mail.from, processing_status: status, created_at: STORED_AT }],
  });
}

/**
 * The write that stores the mail for reading fails (a dropped connection, say): the insert of the
 * old way (after its delete), or the take-over of the stored row (its update to pending).
 */
const storeFails = (db: FakeDb) =>
  db.hooks.push((q: Query) =>
    q.table === "emails" && (q.op === "insert" || (q.op === "update" && (q.values as { processing_status?: string }).processing_status === "pending"))
      ? { data: null, error: { message: "connection reset" } }
      : undefined,
  );

describe("re-reading a stored mail keeps its row", () => {
  it("a failed store leaves the stored mail as it was (found by its Message-ID)", async () => {
    const mail = waiting();
    const db = seeded(mail);
    storeFails(db);
    await expect(processInboundEmail(asAdmin(db), mail)).rejects.toThrow("connection reset");
    expect(db.rows("emails").map((e) => [e.id, e.processing_status, e.subject, e.text_body])).toEqual([["e-waiting", "over_limit", mail.subject, mail.text]]);
    expect(mocks.extractEmail).not.toHaveBeenCalled();
  });

  it("a failed store leaves the stored mail as it was (no Message-ID, named by replacesEmailId)", async () => {
    const mail = waiting({ messageId: null });
    const db = seeded(mail, "failed");
    storeFails(db);
    await expect(processInboundEmail(asAdmin(db), mail, { replacesEmailId: "e-waiting" })).rejects.toThrow("connection reset");
    expect(db.rows("emails").map((e) => [e.id, e.processing_status, e.subject])).toEqual([["e-waiting", "failed", mail.subject]]);
  });

  it("is read in the same row, never deleted and inserted anew; the pending grace starts again", async () => {
    const mail = waiting();
    const db = seeded(mail);
    const out = await processInboundEmail(asAdmin(db), mail);
    expect(out).toMatchObject({ kind: "processed", emailId: "e-waiting" });
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ id: "e-waiting", processing_status: "processed", body_state: "dropped", error: null });
    expect(db.callsOn("emails", "delete")).toHaveLength(0);
    expect(db.callsOn("emails", "insert")).toHaveLength(0);
    const takeOver = db.callsOn("emails", "update")[0];
    expect((takeOver.values as { processing_status: string; created_at: string }).processing_status).toBe("pending");
    expect((takeOver.values as { created_at: string }).created_at > STORED_AT).toBe(true);
  });

  it("removes what an earlier, unfinished read of the row left, so a parcel is not counted twice", async () => {
    const mail = waiting();
    const db = seeded(mail, "failed");
    db.rows("extractions").push({ id: "x-old", user_id: USER, email_id: "e-waiting", parcel_id: null, model: "m", result: {}, confidence: 0.5 });
    await processInboundEmail(asAdmin(db), mail);
    const left = db.rows("extractions").filter((x) => x.email_id === "e-waiting");
    expect(left.map((x) => x.id)).not.toContain("x-old");
    expect(left).toHaveLength(1);
  });

  it("is not taken over when another delivery took it first: it fails, and Claude is not paid twice", async () => {
    const mail = waiting();
    const db = seeded(mail);
    // Another delivery takes the row over between this one's lookup and its write.
    let raced = false;
    db.hooks.push((q: Query) => {
      if (raced || q.table !== "emails" || q.op !== "update") return undefined;
      raced = true;
      Object.assign(db.find("emails", "e-waiting")!, { processing_status: "pending", created_at: "2026-11-03T00:00:00Z" });
      return undefined;
    });
    await expect(processInboundEmail(asAdmin(db), mail)).rejects.toThrow("changed while it was being stored");
    expect(mocks.extractEmail).not.toHaveBeenCalled();
    expect(db.rows("emails")).toHaveLength(1);
  });

  it("control: a new mail is still inserted with a fresh id", async () => {
    const db = new FakeDb();
    const out = await processInboundEmail(asAdmin(db), waiting({ messageId: "<new@example.test>" }));
    expect(out.kind).toBe("processed");
    expect(db.callsOn("emails", "insert")).toHaveLength(1);
  });
});

describe("a redelivered mail that was read", () => {
  const promo = (): InboundEmail => ({ ...mailOf("2026-11-03T01:00:00Z"), messageId: "<read@example.test>", from: "news@mall.example.test", subject: "今週のおすすめ", text: "新着アイテムのご案内。配信停止はこちら" });

  it("is a duplicate before the screen runs: the read row stays, and nothing is paid", async () => {
    const mail = promo();
    const db = new FakeDb({ emails: [{ id: "e-read", user_id: USER, message_id: mail.messageId, processing_status: "processed", body_state: "dropped", created_at: STORED_AT }] });
    // The sender is marked, so the screen's drop would have gone to the cheap check.
    db.rows("screen_events").push({ id: "flag", user_id: USER, decision: "dropped", subject: "前の通知", from_domain: "mall.example.test", flagged_at: "2026-11-02T00:00:00Z", created_at: "2026-11-02T00:00:00Z" });
    mocks.isPurchaseMail.mockResolvedValue(false);
    expect(await processInboundEmail(asAdmin(db), mail)).toEqual({ kind: "duplicate", emailId: "e-read" });
    expect(db.rows("emails").map((e) => e.id)).toEqual(["e-read"]);
    expect(mocks.isPurchaseMail).not.toHaveBeenCalled();
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.rows("screen_events")).toHaveLength(1);
  });

  it("control: a stored unread mail the screen now drops is still removed (it would stay unread forever)", async () => {
    const mail = promo();
    const db = new FakeDb({ emails: [{ id: "e-unread", user_id: USER, message_id: mail.messageId, processing_status: "over_limit", created_at: STORED_AT }] });
    expect((await processInboundEmail(asAdmin(db), mail)).kind).toBe("screened_out");
    expect(db.rows("emails")).toHaveLength(0);
    // Gone from emails, so it is listed in 読まなかったメール, with its subject.
    expect(db.rows("screen_events").map((e) => [e.decision, e.subject])).toEqual([["dropped", "今週のおすすめ"]]);
  });

  it("a stored mail another delivery took over meanwhile is not removed from under it (review R3-5)", async () => {
    const mail = promo();
    const db = new FakeDb({ emails: [{ id: "e-unread", user_id: USER, message_id: mail.messageId, processing_status: "over_limit", created_at: STORED_AT }] });
    // Another delivery takes the row over (pending, a new created_at) after this one looked it up.
    let raced = false;
    db.hooks.push((q: Query) => {
      if (raced || q.table !== "emails" || q.op !== "delete") return undefined;
      raced = true;
      Object.assign(db.find("emails", "e-unread")!, { processing_status: "pending", created_at: "2026-11-03T00:00:00Z" });
      return undefined;
    });
    expect((await processInboundEmail(asAdmin(db), mail)).kind).toBe("screened_out");
    expect(db.rows("emails").map((e) => [e.id, e.processing_status])).toEqual([["e-unread", "pending"]]);
    // That delivery may read and seal it: its subject is not kept in plaintext as dropped (R3-33).
    expect(db.rows("screen_events")).toEqual([]);
  });

  it("a failed removal leaves no dropped subject behind, and the webhook is asked to retry (review R3-33)", async () => {
    const mail = promo();
    const db = new FakeDb({ emails: [{ id: "e-unread", user_id: USER, message_id: mail.messageId, processing_status: "over_limit", created_at: STORED_AT }] });
    db.hooks.push((q: Query) => (q.table === "emails" && q.op === "delete" ? { data: null, error: { message: "connection reset" } } : undefined));
    await expect(processInboundEmail(asAdmin(db), mail)).rejects.toThrow("emails cleanup failed");
    expect(db.rows("screen_events")).toEqual([]);
    expect(db.rows("emails").map((e) => e.id)).toEqual(["e-unread"]);
  });
});
