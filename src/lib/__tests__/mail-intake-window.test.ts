import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundEmail } from "@/lib/pipeline";
import { MAIL_INTAKE_LIMITS } from "@/lib/mail-intake";
import { screenMail } from "@/lib/screen";
import { FakeDb } from "./fake-db";
import { OTHER, USER, asConsentingAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * The per-day intake allowance (supabase/migrations/20261125100000_mail_intake_window.sql; the SQL itself is exercised
 * on Postgres by tests/postgres/run-mail-intake-window.mjs), through the real pipeline with the fake database:
 * - Gmail's confirmation (its sender and Google's link) takes one from the allowance and keeps only the link; a mail from
 *   that sender without the link is read like any other mail;
 * - a screened-out mail is logged once per delivery, within the allowance, and is dropped either way;
 * - an ordinary order mail, a confirmation and its retry, and a person's own handful of ads go through as before;
 * - while the database does not have the functions yet, everything goes on as before.
 * Made-up mails only; no Claude call.
 */

const mocks = vi.hoisted(() => ({ extractEmail: vi.fn(), isPurchaseMail: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extractEmail }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.isPurchaseMail }));
const { processInboundEmail } = await import("@/lib/pipeline");

const order = reading({ relevance: "order", order_number: sure("ORD-88880000"), items: [item("テスト商品", 1200)], total_amount: sure(1200) });
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extractEmail.mockReset().mockImplementation(async () => precomputed(order));
  mocks.isPurchaseMail.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const LINK = "https://mail-settings.google.com/mail/vf-%5Babc%5D-xyz";
let n = 0;
const confirmation = (over: Partial<InboundEmail> = {}): InboundEmail => {
  n++;
  return { ...mailOf("2026-11-03T01:00:00Z"), from: "forwarding-noreply@google.com", subject: "Gmail Forwarding Confirmation", text: `To allow, click:\n${LINK}\n`, providerEmailId: `PID-C${n}`, messageId: `<c${n}@google.test>`, ...over };
};
const AD = { subject: "週末セールのお知らせ", text: "今週末は全品がお得です。お気に入りの商品をぜひご覧ください。", from: "news@shop.example.test" };
const ad = (over: Partial<InboundEmail> = {}): InboundEmail => {
  n++;
  return { ...mailOf("2026-11-03T01:00:00Z"), ...AD, providerEmailId: `PID-A${n}`, messageId: `<a${n}@shop.example.test>`, ...over };
};
const orderMail = (): InboundEmail => {
  n++;
  return { ...mailOf("2026-11-03T01:00:00Z"), from: "order@shop.example.test", subject: "ご注文ありがとうございます", text: "ご注文番号 ORD-88880000 を承りました\nテスト商品 1,200円", providerEmailId: `PID-O${n}`, messageId: `<o${n}@shop.example.test>` };
};
/** The clock of the fake starts now: screen_events keeps 14 days from today, as the real table does. */
const fresh = () => new FakeDb({}, Date.now());
const calls = (db: FakeDb, name: string) => db.rpcCalls.filter((c) => c.name === name);
const confirmations = (db: FakeDb, user = USER) => db.rows("emails").filter((e) => e.user_id === user && e.classification === "forwarding_confirmation");
const events = (db: FakeDb, user = USER) => db.rows("screen_events").filter((e) => e.user_id === user);

describe("the made-up ad really is dropped by the free screen", () => {
  it("is not passing and not borderline", () => {
    const s = screenMail({ subject: AD.subject, text: AD.text, html: null });
    expect(s.pass).toBe(false);
    expect(s.borderline).toBe(false);
  });
});

describe("Gmail's forwarding confirmation", () => {
  it("(positive) one confirmation: one claim, stored with only its link, the approval card can use it", async () => {
    const db = fresh();
    const out = await processInboundEmail(asConsentingAdmin(db), confirmation());
    expect(out.kind).toBe("forwarding_confirmation");
    expect(calls(db, "claim_mail_intake").map((c) => (c.args as { p_kind: string }).p_kind)).toEqual(["forwarding_confirmation"]);
    const [row] = confirmations(db);
    expect(row).toMatchObject({ forwarding_confirm_url: LINK, processing_status: "processed", body_state: "dropped", subject: null, from_address: null, text_body: null, html_body: null });
  });

  it("(positive) the same delivery sent again is a duplicate and takes nothing more", async () => {
    const db = fresh();
    const mail = confirmation();
    await processInboundEmail(asConsentingAdmin(db), mail);
    expect((await processInboundEmail(asConsentingAdmin(db), { ...mail })).kind).toBe("duplicate");
    expect(calls(db, "claim_mail_intake")).toHaveLength(1);
    expect(confirmations(db)).toHaveLength(1);
  });

  it("many confirmations to one address: only the day's allowance is stored, the rest let go before any storage", async () => {
    const db = fresh();
    const limit = MAIL_INTAKE_LIMITS.forwarding_confirmation.user_count;
    const outcomes = [];
    for (let i = 0; i < limit + 5; i++) outcomes.push((await processInboundEmail(asConsentingAdmin(db), confirmation())).kind);
    expect(outcomes.filter((k) => k === "forwarding_confirmation")).toHaveLength(limit);
    expect(outcomes.slice(limit)).toEqual(Array(5).fill("discarded"));
    expect(confirmations(db)).toHaveLength(limit);
    expect(calls(db, "store_mail_run")).toHaveLength(limit);
    // Another person's confirmation is theirs: it still goes in.
    expect((await processInboundEmail(asConsentingAdmin(db), confirmation({ userId: OTHER }))).kind).toBe("forwarding_confirmation");
  });

  it("the bytes of the day count too: very large confirmations are let go once the bytes are used", async () => {
    const db = fresh();
    const big = "x".repeat(1024 * 1024);
    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push((await processInboundEmail(asConsentingAdmin(db), confirmation({ html: big }))).kind);
    // 4 MiB a day: three of about 1 MiB fit, the fourth does not.
    expect(outcomes.filter((k) => k === "forwarding_confirmation")).toHaveLength(3);
    expect(confirmations(db)).toHaveLength(3);
  });

  it("a mail from Gmail's sender without Google's link is not a confirmation: no claim, no approval link, screened like any mail", async () => {
    const db = fresh();
    const out = await processInboundEmail(asConsentingAdmin(db), confirmation({ text: "週末セールのお知らせ 今週末は全品がお得です。お気に入りの商品をぜひご覧ください。", subject: "週末セールのお知らせ" }));
    expect(out.kind).toBe("screened_out");
    expect(calls(db, "claim_mail_intake")).toHaveLength(0);
    expect(confirmations(db)).toHaveLength(0);
    expect(db.rows("emails")).toHaveLength(0);
  });

  it("an answer the database could not give stops the delivery (the webhook answers 500 and it is sent again)", async () => {
    const db = fresh();
    db.mailIntakeFailure = { code: "57014", message: "canceling statement" };
    await expect(processInboundEmail(asConsentingAdmin(db), confirmation())).rejects.toThrow(/mail intake claim failed/);
    expect(confirmations(db)).toHaveLength(0);
  });
});

describe("the screen log", () => {
  it("(positive) a handful of ads a day: each dropped and logged once", async () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) expect((await processInboundEmail(asConsentingAdmin(db), ad())).kind).toBe("screened_out");
    expect(events(db)).toHaveLength(5);
    expect(events(db).every((e) => e.decision === "dropped" && e.subject === AD.subject)).toBe(true);
  });

  it("the same ad delivered again (same Message-ID) leaves one row", async () => {
    const db = fresh();
    const mail = ad();
    for (let i = 0; i < 4; i++) expect((await processInboundEmail(asConsentingAdmin(db), { ...mail, providerEmailId: `PID-R${i}` })).kind).toBe("screened_out");
    expect(events(db)).toHaveLength(1);
  });

  it("many ads to one address: dropped all the same, but only the day's allowance is logged", async () => {
    const db = fresh();
    const limit = MAIL_INTAKE_LIMITS.screen_event.user_count;
    let dropped = 0;
    for (let i = 0; i < limit + 20; i++) if ((await processInboundEmail(asConsentingAdmin(db), ad())).kind === "screened_out") dropped++;
    expect(dropped).toBe(limit + 20);
    expect(events(db)).toHaveLength(limit);
    expect(db.rows("emails")).toHaveLength(0);
    // Another person's ads are logged as usual.
    await processInboundEmail(asConsentingAdmin(db), ad({ userId: OTHER }));
    expect(events(db, OTHER)).toHaveLength(1);
  });
});

describe("(positive) an ordinary order mail", () => {
  it("is stored, read and filed as before, without taking from the intake allowance", async () => {
    const db = fresh();
    const out = await processInboundEmail(asConsentingAdmin(db), orderMail());
    expect(out.kind).toBe("processed");
    expect(calls(db, "claim_mail_intake")).toHaveLength(0);
    expect(calls(db, "log_screen_event")).toHaveLength(0);
    expect(db.rows("parcels")).toHaveLength(1);
  });
});

describe("a database without the functions yet (or after the rollback)", () => {
  it("stores confirmations and logs ads as before", async () => {
    const db = fresh();
    db.mailIntakeMissing = true;
    const limit = MAIL_INTAKE_LIMITS.forwarding_confirmation.user_count;
    for (let i = 0; i < limit + 2; i++) expect((await processInboundEmail(asConsentingAdmin(db), confirmation())).kind).toBe("forwarding_confirmation");
    expect(confirmations(db)).toHaveLength(limit + 2);
    const mail = ad();
    await processInboundEmail(asConsentingAdmin(db), mail);
    await processInboundEmail(asConsentingAdmin(db), { ...mail, providerEmailId: "PID-again" });
    // The earlier direct insert: one row per delivery, no de-duplication.
    expect(events(db)).toHaveLength(2);
    expect(calls(db, "log_screen_event")).toHaveLength(2);
  });
});
