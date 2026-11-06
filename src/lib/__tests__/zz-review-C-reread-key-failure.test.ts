/**
 * Review C (C-5), turned into a regression test: re-reading a stored unread mail (settings
 * 「読み取る」 → readWaitingMail → processInboundEmail) used to delete the stored row first, then read
 * the seal key, then insert the mail again. If the key read failed in between, the only copy (the
 * DB row) was gone. Now the key is read before anything is removed.
 * precomputed is passed so no API can be called; the order of the steps is the same.
 */
import { describe, expect, it } from "vitest";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb } from "./fake-db";
import { USER, asAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

const keyReadFails = (db: FakeDb) => db.hooks.push((q) => (q.table === "user_keys" && q.op === "select" ? { data: null, error: { message: "timeout" } } : undefined));

describe("review C: a failed key read during a re-read", () => {
  it("keeps the stored unread mail (found by its Message-ID)", async () => {
    const mail = { ...mailOf("2026-11-03T01:00:00Z"), messageId: "<waiting@example.test>" };
    const db = new FakeDb({
      emails: [{ id: "e-waiting", user_id: USER, message_id: mail.messageId, subject: mail.subject, text_body: mail.text, html_body: mail.html, processing_status: "over_limit", created_at: "2026-11-01T00:00:00Z" }],
    });
    keyReadFails(db);

    await expect(processInboundEmail(asAdmin(db), mail, { precomputed: precomputed(reading({ relevance: "order", order_number: sure("ORD-1") })) })).rejects.toThrow("user_keys lookup failed");
    expect(db.rows("emails").map((e) => [e.id, e.processing_status, e.subject])).toEqual([["e-waiting", "over_limit", mail.subject]]);
  });

  it("keeps a stored unread mail with no Message-ID (the row it replaces is removed only after the key read)", async () => {
    const mail = { ...mailOf("2026-11-03T01:00:00Z"), messageId: null };
    const db = new FakeDb({
      emails: [{ id: "e-no-id", user_id: USER, message_id: null, subject: mail.subject, text_body: mail.text, html_body: mail.html, processing_status: "failed", created_at: "2026-11-01T00:00:00Z" }],
    });
    keyReadFails(db);

    await expect(processInboundEmail(asAdmin(db), mail, { precomputed: precomputed(reading({ relevance: "order", order_number: sure("ORD-1") })), replacesEmailId: "e-no-id" })).rejects.toThrow("user_keys lookup failed");
    expect(db.rows("emails").map((e) => e.id)).toEqual(["e-no-id"]);
  });

  it("control: when the key read works, the stored row is read again in place (one row, the same id; review R1-3)", async () => {
    const mail = { ...mailOf("2026-11-03T01:00:00Z"), messageId: null };
    const db = new FakeDb({
      emails: [{ id: "e-no-id", user_id: USER, message_id: null, subject: mail.subject, text_body: mail.text, html_body: mail.html, processing_status: "failed", created_at: "2026-11-01T00:00:00Z" }],
    });
    await processInboundEmail(asAdmin(db), mail, { precomputed: precomputed(reading({ relevance: "order", order_number: sure("ORD-1") })), replacesEmailId: "e-no-id" });
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ id: "e-no-id", processing_status: "processed" });
  });
});
