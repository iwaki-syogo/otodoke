import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { asAdmin, asConsentingAdmin, mailOf, precomputed, reading, USER } from "./pipeline-fixtures";
import { WAITING_MAIL_FILTER } from "@/lib/unread";

const api = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: api.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: api.triage }));
const { processInboundEmail } = await import("@/lib/pipeline");
const { runReadWaitingMail } = await import("@/lib/mail-run");

const advertisement = () => ({
  ...mailOf("2026-11-12T00:00:00Z"),
  messageId: "<synthetic-newsletter@example.test>",
  subject: "今週のセール案内",
  text: "今週のおすすめをご紹介します。配信停止はこちら。",
  html: "<p>今週のおすすめをご紹介します。配信停止はこちら。</p>",
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  api.extract.mockReset().mockRejectedValue(new Error("unexpected extraction API call"));
  api.triage.mockReset().mockRejectedValue(new Error("unexpected triage API call"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function expectNoPaidReading(db: FakeDb): void {
  expect(api.extract).not.toHaveBeenCalled();
  expect(api.triage).not.toHaveBeenCalled();
  expect(db.rpcCalls.filter((call) => /claude_call/.test(call.name)
    || call.name === "mail_run_write" && (call.args as { p_operation?: string }).p_operation === "claim")).toEqual([]);
}

describe("unverified unrelated readings keep only the unread mail", () => {
  it.each([null, "今月のおすすめをご紹介します。"])("retains the original body without an empty parcel when the quote is %s", async (relevance_evidence) => {
    const db = new FakeDb();
    const mail = advertisement();
    const outcome = await processInboundEmail(asConsentingAdmin(db), mail, {
      precomputed: precomputed(reading({ relevance: "unrelated", relevance_evidence })),
    });
    expect(db.rows("parcels")).toEqual([]);
    expect(outcome).toMatchObject({ kind: "noted" });
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({
      processing_status: "failed", error: "relevance_unverified", body_state: "plain",
      subject: mail.subject, text_body: mail.text, html_body: mail.html,
    });
    expect(db.rows("extractions")).toEqual([]);
    expect(db.callsOn("emails", "delete")).toEqual([]);
    expectNoPaidReading(db);
  });

  it("discards an unrelated verdict whose quote is present in the original mail", async () => {
    const db = new FakeDb();
    const outcome = await processInboundEmail(asConsentingAdmin(db), advertisement(), {
      precomputed: precomputed(reading({ relevance: "unrelated", relevance_evidence: "今週のおすすめをご紹介します。" })),
    });
    expect(outcome.kind).toBe("discarded");
    expect(db.rows("emails")).toEqual([]);
    expect(db.rows("parcels")).toEqual([]);
    expect(db.rows("extractions")).toEqual([]);
    expectNoPaidReading(db);
  });

  it.each([
    ["subject-only quote", "今週のセール案内", {}],
    ["HTML/full-width currency and whitespace", "合計: 1,980円", { text: null, html: "<p>合計：&nbsp;￥１，９８０ 円</p>" }],
    ["date quote", "11月12日(木)のお知らせ", { text: "11月12日(木)のお知らせ" }],
    ["ordered ellipsis fragments", "今週のおすすめ…配信停止はこちら", {}],
  ])("still discards grounded unrelated mail with %s", async (_name, relevance_evidence, source) => {
    const db = new FakeDb();
    const outcome = await processInboundEmail(asConsentingAdmin(db), { ...advertisement(), ...source }, {
      precomputed: precomputed(reading({ relevance: "unrelated", relevance_evidence })),
    });
    expect(outcome.kind).toBe("discarded");
    expect(db.rows("emails")).toEqual([]);
    expect(db.rows("parcels")).toEqual([]);
    expect(db.rows("extractions")).toEqual([]);
    expectNoPaidReading(db);
  });

  it("leaves the retained mail in the real unread selection and retries it in place", async () => {
    const db = new FakeDb();
    const admin = asConsentingAdmin(db);
    const mail = {
      ...mailOf("2026-11-12T00:00:00Z"), providerEmailId: "synthetic-retry", messageId: "<retry@example.test>",
      subject: "ご注文ありがとうございます", text: "ご注文番号 ORD-123456 を承りました。商品を発送しました。テスト商品。",
    };
    await processInboundEmail(admin, mail, { precomputed: precomputed(reading({ relevance: "unrelated", relevance_evidence: null })) });
    expect(db.rows("emails")).toHaveLength(1);
    const id = db.rows("emails")[0].id;
    const waiting = await admin.from("emails").select("id").eq("user_id", USER).eq("body_state", "plain").or(WAITING_MAIL_FILTER());
    expect(waiting.data?.map((mail) => mail.id)).toEqual([id]);
    expectNoPaidReading(db);
    api.extract.mockResolvedValue(precomputed(reading({
      relevance: "shipped", relevance_evidence: "商品を発送しました。",
      order_number: { value: "ORD-123456", evidence: "ご注文番号 ORD-123456", confidence: 0.95 },
      items: [{ name: "テスト商品", quantity: 1, unit_price: null, evidence: "テスト商品" }],
    })));
    expect(await runReadWaitingMail(admin, USER)).toMatchObject({ ok: true, read: 1, unavailable: false });
    expect(api.extract).toHaveBeenCalledTimes(1);
    expect(api.triage).not.toHaveBeenCalled();
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ id, processing_status: "processed", error: null });
    expect(db.rows("parcels")).toHaveLength(1);
    expect(db.rows("parcels")[0]).toMatchObject({ title: "テスト商品", status: "shipped", needs_review: false });
    expect(db.rows("extractions")).toHaveLength(1);
  });

  it("still requires consent before considering a precomputed negative verdict", async () => {
    const db = new FakeDb();
    await expect(processInboundEmail(asAdmin(db), advertisement(), {
      precomputed: precomputed(reading({ relevance: "unrelated", relevance_evidence: null })),
    })).rejects.toMatchObject({ code: "ai_consent_required" });
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", error: "ai_consent_required", text_body: advertisement().text });
    expect(db.rows("parcels")).toEqual([]);
    expect(db.rows("extractions")).toEqual([]);
    expectNoPaidReading(db);
  });

  it("propagates a failed hold write while retaining the original mail", async () => {
    const db = new FakeDb();
    db.hooks.push((query) => query.table === "emails" && query.op === "update"
      && (query.values as { error?: string }).error === "relevance_unverified"
      ? { data: null, error: { message: "synthetic hold failure" } } : undefined);
    await expect(processInboundEmail(asConsentingAdmin(db), advertisement(), {
      precomputed: precomputed(reading({ relevance: "unrelated", relevance_evidence: null })),
    })).rejects.toThrow("synthetic hold failure");
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ body_state: "plain", text_body: advertisement().text });
    expect(db.rows("parcels")).toEqual([]);
    expect(db.rows("extractions")).toEqual([]);
    expectNoPaidReading(db);
  });

  it("still files a grounded parcel reading", async () => {
    const db = new FakeDb();
    const mail = { ...mailOf("2026-11-12T00:00:00Z"), subject: "発送のお知らせ", text: "商品を発送しました。合計：￥１，９８０。11月12日にお届け。" };
    const outcome = await processInboundEmail(asConsentingAdmin(db), mail, {
      precomputed: precomputed(reading({
        relevance: "shipped", relevance_evidence: "商品を発送しました。",
        total_amount: { value: 1980, evidence: "合計: 1,980円", confidence: 0.95 },
        expected_date: { value: "2026-11-12", evidence: "11月12日にお届け", confidence: 0.95 },
      })),
    });
    expect(outcome.kind).toBe("processed");
    expect(db.rows("parcels")).toHaveLength(1);
    expect(db.rows("parcels")[0]).toMatchObject({ status: "shipped", total_amount: 1980, expected_date: "2026-11-12", needs_review: false });
    expect(db.rows("extractions")).toHaveLength(1);
    expectNoPaidReading(db);
  });
});
