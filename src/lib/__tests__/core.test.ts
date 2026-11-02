import { describe, expect, it } from "vitest";
import { identifyCarrier, normalizeTracking, trackingUrlFor } from "@/lib/carriers";
import { shiftDatesDeep, shiftDatesInText } from "@/lib/demo";
import { buildUserMessage } from "@/lib/extract/prompt";
import type { Extraction } from "@/lib/extract/schema";
import { screenMail } from "@/lib/screen";
import { addDays, formatWindow, todayJst, weekdayOf } from "@/lib/format";
import { buildParcelInsert, buildParcelUpdate, type ParcelRow } from "@/lib/match";
import { emailBodyText, htmlToText } from "@/lib/text/html-to-text";

const none = { value: null, evidence: null, confidence: 0 };

function extraction(over: Partial<Extraction>): Extraction {
  return {
    relevance: "shipped",
    relevance_evidence: null,
    shop_name: "テスト店",
    shop_key: "other",
    order_number: none,
    items: [],
    total_amount: none,
    ordered_at: none,
    carrier: none,
    tracking_number: none,
    expected_date: none,
    expected_window_start: none,
    expected_window_end: none,
    expected_text: null,
    requires_presence: none,
    overall_confidence: 0.9,
    notes: null,
    ...over,
  };
}

const sure = <T,>(value: T) => ({ value, evidence: "根拠", confidence: 0.95 });

const parcel = (over: Partial<ParcelRow>) => ({ status: "ordered", shop: "テスト店", last_email_at: "2026-11-01T00:00:00Z", requires_presence: null, ...over }) as ParcelRow;

describe("carriers", () => {
  it("keeps only letters and digits in a tracking number", () => {
    expect(normalizeTracking("5111-7266-6093")).toBe("511172666093");
  });
  it("does not guess the carrier of a bare 12-digit number", () => {
    expect(identifyCarrier("313016540476").key).toBe("unknown");
    expect(trackingUrlFor("313016540476")).toBeNull();
  });
  it("uses the carrier named in the mail for a 12-digit number", () => {
    expect(identifyCarrier("313016540476", "佐川急便").key).toBe("sagawa");
    expect(identifyCarrier("5111-7266-6093", "ヤマト運輸").key).toBe("yamato");
  });
});

describe("JST dates", () => {
  it("treats a UTC evening as the next JST day", () => {
    expect(todayJst(new Date("2026-11-01T17:21:30Z"))).toBe("2026-11-02");
  });
  it("gives the model the JST date, so 本日 resolves to the right day", () => {
    const { text } = buildUserMessage({ from: "a", subject: "s", sentAt: "2026-11-01T17:21:30+00:00", body: "本日到着予定" });
    expect(text).toContain("2026-11-02(月) 02:21");
  });
  it("adds days across a month end", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(weekdayOf("2026-11-02")).toBe(1);
  });
  it("names the morning window", () => {
    expect(formatWindow("08:00:00", "12:00:00")).toBe("午前中");
    expect(formatWindow("19:00:00", "21:00:00")).toBe("19:00〜21:00");
  });
});

describe("shiftDatesInText", () => {
  it.each([
    ["2026/04/10（金）　19:00〜21:00", 3, "2026/04/13（月）　19:00〜21:00"],
    ["2026年9月5日(土)", 1, "2026年9月6日(日)"],
    ["【6月30日(火) 時間帯希望なし】", 1, "【7月1日(水) 時間帯希望なし】"],
    ["2026-10-31", 1, "2026-11-01"],
    ["木曜日にお届け", 2, "土曜日にお届け"],
  ])("%s + %i days", (input, days, want) => {
    expect(shiftDatesInText(input, days, 2026)).toBe(want);
  });
  it.each(["503-6666033-1766280", "X296693-5042632-9", "371054-20261015-7461804933", "5111-7266-6093", "0979279182570435064-8469141"])(
    "leaves the number %s alone",
    (n) => {
      expect(shiftDatesInText(n, 10, 2026)).toBe(n);
    },
  );
  it("moves dates inside a stored Claude result but not numbers", () => {
    const x = shiftDatesDeep({ expected_date: { value: "2026-06-30", confidence: 1 }, total: 2339 }, 1, 2026);
    expect(x).toEqual({ expected_date: { value: "2026-07-01", confidence: 1 }, total: 2339 });
  });
});

describe("email body", () => {
  it("removes invisible direction marks that break matching", () => {
    expect(htmlToText("<p>‫503-1‎</p>")).toBe("503-1");
  });
  it("adds lines that exist only in HTML to the text part", () => {
    const body = emailBodyText("お荷物のお知らせです。十分に長い本文がここにあります。お届け予定は明日です。", "<p>お荷物のお知らせです。十分に長い本文がここにあります。お届け予定は明日です。</p><p>受取方法 ： 対面での配達を希望</p>");
    expect(body).toContain("受取方法 ： 対面での配達を希望");
    expect(body.match(/お荷物のお知らせです/g)).toHaveLength(1);
  });
});

describe("parcel merge", () => {
  it("drops a malformed date instead of failing the whole mail", () => {
    const row = buildParcelInsert("u", extraction({ expected_date: sure("明日"), expected_window_start: sure("25:00"), ordered_at: sure("2026/10/15") }), null);
    expect(row.expected_date).toBeNull();
    expect(row.expected_window_start).toBeNull();
    expect(row.ordered_at).toBeNull();
  });
  it("uses the JST date of an order mail when the mail states no order date", () => {
    const row = buildParcelInsert("u", extraction({ relevance: "order" }), "2026-11-01T17:21:30Z");
    expect(row.ordered_at).toBe("2026-11-02");
  });
  it("does not move a delivered parcel backwards when a late mail arrives", () => {
    const update = buildParcelUpdate(parcel({ status: "delivered" }), extraction({ relevance: "shipped" }), "2026-11-02T00:00:00Z");
    expect(update.status).toBeUndefined();
  });
  it("lets a redelivery request replace the delivery date", () => {
    const update = buildParcelUpdate(
      parcel({ status: "attempted", expected_date: "2026-06-30" }),
      extraction({ relevance: "attempted", expected_date: sure("2026-07-01"), requires_presence: sure(true) }),
      "2026-11-02T00:00:00Z",
    );
    expect(update.expected_date).toBe("2026-07-01");
    expect(update.requires_presence).toBe(true);
  });
  it("keeps a known presence requirement when a later mail says nothing", () => {
    const update = buildParcelUpdate(parcel({ requires_presence: true }), extraction({}), "2026-11-02T00:00:00Z");
    expect(update.requires_presence).toBeUndefined();
  });
  it("does not assert low-confidence values and flags them for review", () => {
    const row = buildParcelInsert("u", extraction({ expected_date: { value: "2026-07-01", evidence: null, confidence: 0.3 }, overall_confidence: 0.4 }), null);
    expect(row.expected_date).toBeNull();
    expect(row.needs_review).toBe(true);
  });
});

describe("screenMail", () => {
  const mail = (subject: string, text: string) => ({ subject, text, html: null });
  it.each([
    ["ご注文ありがとうございます", "ご注文番号：123 を承りました。"],
    ["[Qoo10] 商品が発送されました", "配送番号: 123"],
    ["定期購入はキャンセルされました。おすすめ商品をご紹介します。", "お手続きありがとうございました。"],
    ["お知らせ", "下記の商品を発送いたしました。配信停止はこちら"],
    ["Your order has shipped", "Tracking number: 1Z999"],
    ["", ""],
  ])("keeps %s", (s, t) => {
    expect(screenMail(mail(s, t)).pass).toBe(true);
  });
  it.each([
    ["【80%OFFクーポン】今だけ", "ご注文はお早めに。配信停止はこちら"],
    ["今週のおすすめ記事", "メルマガの配信停止はこちら"],
    // A real ad: thanks you for an "order" that never happened, with no order number or item.
    ["ご注文ありがとうございました！", "感謝の気持ちとして特別なギフトをプレゼントします。配信停止はこちら"],
    ["ログインがありました", "新しい端末からサインインがありました。"],
  ])("drops %s", (s, t) => {
    expect(screenMail(mail(s, t)).pass).toBe(false);
  });
  it("asks for a second look when a dropped mail resembles a notice", () => {
    expect(screenMail(mail("お荷物について", "詳しくはこちら。配信停止はこちら")).borderline).toBe(true);
    expect(screenMail(mail("今週のおすすめ記事", "メルマガの配信停止はこちら")).borderline).toBe(false);
  });
  it("does not depend on the sender", () => {
    const m = mail("発送のお知らせ", "お問い合わせ番号 123");
    expect(Object.keys(m)).not.toContain("from");
    expect(screenMail(m).pass).toBe(true);
  });
});

describe("demo mails", () => {
  it("all pass the pre-check, so the demo shows what real forwarding would show", async () => {
    const { readDemoMails } = await import("@/lib/demo");
    const mails = await readDemoMails();
    expect(mails).toHaveLength(17);
    for (const m of mails) expect(screenMail(m).pass, m.file).toBe(true);
  });
});
