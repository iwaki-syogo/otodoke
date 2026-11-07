import { describe, expect, it } from "vitest";
import { amazonOrderTrackingUrl, identifyCarrier, normalizeTracking, trackingLinkFor, trackingUrlFor } from "@/lib/carriers";
import { shiftDatesDeep, shiftDatesInText } from "@/lib/demo";
import { buildUserMessage } from "@/lib/extract/prompt";
import type { Extraction } from "@/lib/extract/schema";
import { screenMail } from "@/lib/screen";
import { addDays, formatWindow, todayJst, weekdayOf } from "@/lib/format";
import { forwardingConfirmUrl, isForwardingConfirmation } from "@/lib/forwarding";
import {
  buildParcelInsert,
  buildParcelUpdate,
  chooseParcel,
  faceToFace,
  isLate,
  needsCheck,
  parcelTotal,
  rebuildParcel,
  splitOrders,
  startsParcel,
  twinsByTracking,
  UNKNOWN_SENDER,
  type ParcelCandidate,
  type ParcelRow,
} from "@/lib/match";
import { safeNextPath } from "@/lib/safe-next";
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
    category: null,
    package_description: none,
    total_amount: none,
    ordered_at: none,
    carrier: none,
    tracking_number: none,
    expected_date: none,
    expected_date_end: none,
    expected_window_start: none,
    expected_window_end: none,
    expected_text: null,
    requires_presence: none,
    other_orders: [],
    overall_confidence: 0.9,
    notes: null,
    ...over,
  };
}

const sure = <T,>(value: T) => ({ value, evidence: "根拠", confidence: 0.95 });

const parcel = (over: Partial<ParcelRow>) => ({ status: "ordered", shop: "テスト店", last_email_at: "2026-11-01T00:00:00Z", requires_presence: null, ...over }) as ParcelRow;

describe("carriers", () => {
  it("keeps only letters and digits in a tracking number", () => {
    expect(normalizeTracking("6203-9184-5571")).toBe("620391845571");
  });
  it("does not guess the carrier of a bare 12-digit number", () => {
    expect(identifyCarrier("482915307128").key).toBe("unknown");
    expect(trackingUrlFor("482915307128")).toBeNull();
  });
  it("uses the carrier named in the mail for a 12-digit number", () => {
    expect(identifyCarrier("482915307128", "佐川急便").key).toBe("sagawa");
    expect(identifyCarrier("6203-9184-5571", "ヤマト運輸").key).toBe("yamato");
  });
  it("hands each carrier the number in the way its site accepts it", () => {
    // Yamato ignores a number in the URL; its form posts number01.
    expect(trackingLinkFor("6203-9184-5571", "ヤマト運輸")).toEqual({
      kind: "post",
      url: "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko",
      fields: { category: "1", number01: "620391845571" },
    });
    // Sagawa takes no number from outside: copy it and open the input page.
    expect(trackingLinkFor("4829-1530-7128", "佐川急便")).toEqual({
      kind: "copy",
      url: "https://e-customer.sagawa-exp.co.jp/k2k",
      pageName: "佐川のお荷物お問い合わせサービス",
    });
    const post = trackingLinkFor("123456789012", "ゆうパック");
    expect(post?.kind).toBe("open");
    expect(post?.url).toContain("reqCodeNo1=123456789012");
    expect(trackingLinkFor("TBA123456789012", null)).toBeNull();
    expect(trackingLinkFor("---", "ヤマト運輸")).toBeNull();
  });
  it("links an Amazon order number to Amazon's own tracking", () => {
    expect(amazonOrderTrackingUrl(" 250-1234567-1234567 ")).toBe("https://www.amazon.co.jp/gp/your-account/ship-track?orderId=250-1234567-1234567");
    expect(amazonOrderTrackingUrl("250-1234567-123456")).toBeNull();
    expect(amazonOrderTrackingUrl("D01-1234567-1234567")).toBeNull();
    expect(amazonOrderTrackingUrl("250-1234567-1234567&x=1")).toBeNull();
    expect(amazonOrderTrackingUrl("")).toBeNull();
    expect(amazonOrderTrackingUrl(null)).toBeNull();
    expect(amazonOrderTrackingUrl(undefined)).toBeNull();
  });
});

describe("JST dates", () => {
  it("treats a UTC evening as the next JST day", () => {
    expect(todayJst(new Date("2026-11-01T17:21:00Z"))).toBe("2026-11-02");
  });
  it("gives the model the JST date, so 本日 resolves to the right day", () => {
    const { text } = buildUserMessage({ from: "a", subject: "s", sentAt: "2026-11-01T17:21:00+00:00", body: "本日到着予定" });
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
  it.each(["503-6666033-1766280", "X296693-5042632-9", "371054-20261015-7461804933", "6203-9184-5571", "0979279182570435064-8469141"])(
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
  it.each([
    ["19:00", "19:00"],
    ["19:00:00", "19:00"],
    ["2026-04-10T19:00:00+09:00", "19:00"],
    ["2026-04-10T19:00", "19:00"],
    ["2026-07-01 19:00", "19:00"],
    ["2026-04-10T10:00:00Z", null],
    ["2026-04-10T19:00:00-05:00", null],
    ["午前中", null],
  ])("reads the delivery time %s as %s", (written, want) => {
    const row = buildParcelInsert("u", extraction({ expected_window_start: sure(written) }), null);
    expect(row.expected_window_start).toBe(want);
  });
  it("uses the JST date of an order mail when the mail states no order date", () => {
    const row = buildParcelInsert("u", extraction({ relevance: "order" }), "2026-11-01T17:21:00Z");
    expect(row.ordered_at).toBe("2026-11-02");
  });
  it("treats a payment notice with a tracking number as shipped", () => {
    expect(buildParcelInsert("u", extraction({ relevance: "payment", tracking_number: sure("123456789012") }), null).status).toBe("shipped");
    expect(buildParcelInsert("u", extraction({ relevance: "payment" }), null).status).toBe("ordered");
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

  it.each(["2026-11-02T01:00:00Z", "2026-11-02T12:00:00Z", "2027-03-01T23:30:00Z"])(
    "never shows a mail or an order from the future when opened at %s",
    async (nowIso) => {
      const { loadDemoEntries } = await import("@/lib/demo");
      const { todayJst } = await import("@/lib/format");
      const now = new Date(nowIso);
      const today = todayJst(now);
      const entries = await loadDemoEntries(today, now);
      // 17 anonymized real mails and 80 made-up history orders.
      expect(entries).toHaveLength(97);
      const sent = entries.map((e) => new Date(e.mail.date!).getTime());
      for (const [i, time] of sent.entries()) {
        expect(time, entries[i].mail.file).toBeLessThanOrEqual(now.getTime());
        if (i > 0) expect(time).toBeGreaterThan(sent[i - 1]);
      }
      for (const { mail, extraction } of entries) {
        const ordered = extraction.ordered_at.value;
        if (ordered) expect(ordered <= today, mail.file).toBe(true);
      }
    },
  );
});

const money = (value: number, confidence = 0.95) => ({ value, evidence: "合計", confidence });
const item = (name: string, unit_price: number | null) => ({ name, quantity: 1, unit_price, evidence: null });

describe("parcelTotal", () => {
  it("adds the shipments of one order that ships in parts", () => {
    const total = parcelTotal([
      extraction({ relevance: "shipped", total_amount: money(1980), items: [item("B", 1980)] }),
      extraction({ relevance: "shipped", total_amount: money(2750), items: [item("A", 2750)] }),
    ]);
    expect(total).toBe(4730);
  });
  it("uses the item list until a shipment mail states the amount", () => {
    const order = extraction({ relevance: "order", items: [item("A", 2750), item("B", 1980)] });
    expect(parcelTotal([order])).toBe(4730);
  });
  it("counts only its own shipment when an order mail lists two order numbers", () => {
    const order = extraction({ relevance: "order", items: [item("A", 2750), item("B", 1980)] });
    expect(parcelTotal([order, extraction({ relevance: "shipped", total_amount: money(2750), items: [item("A", 2750)] })])).toBe(2750);
  });
  it("prefers the shipment over an unsure order total", () => {
    expect(parcelTotal([extraction({ relevance: "order", total_amount: money(118, 0.7) }), extraction({ relevance: "shipped", total_amount: money(559) })])).toBe(559);
  });
  it("keeps a discount the item list does not show", () => {
    const total = parcelTotal([
      extraction({ relevance: "order", total_amount: money(10750, 0.7), items: [item("A", 6000), item("B", 5309)] }),
      extraction({ relevance: "shipped", total_amount: money(10750), items: [item("A", 6000), item("B", 5309)] }),
    ]);
    expect(total).toBe(10750);
  });
  it("does not count one mail delivered twice", () => {
    const shipped = extraction({ relevance: "shipped", total_amount: money(818), items: [item("A", 818)] });
    expect(parcelTotal([shipped, shipped])).toBe(818);
  });
  it("ignores a price in a subscription notice", () => {
    expect(parcelTotal([extraction({ relevance: "shipped", total_amount: money(500) }), extraction({ relevance: "other_purchase", total_amount: money(1162) })])).toBe(500);
  });
  it("trusts an order total the mail states outright", () => {
    expect(parcelTotal([extraction({ relevance: "order", total_amount: money(3000), items: [item("A", 3500)] })])).toBe(3000);
  });
  it("is unknown when nothing states a price", () => {
    expect(parcelTotal([extraction({ relevance: "order", total_amount: money(0, 0.5), items: [item("A", null)] })])).toBeNull();
  });
});

const candidate = (over: Partial<ParcelCandidate>) =>
  ({ shop: "テスト店", shop_key: "other", status: "shipped", order_number: null, tracking_number: null, expected_date: null, created_at: "2026-11-01T00:00:00Z", itemNames: [], ...over }) as ParcelCandidate;
const NOW = new Date("2026-11-02T00:00:00Z");

describe("chooseParcel", () => {
  it("joins by order number within a shop", () => {
    const p = candidate({ order_number: "A-1001" });
    expect(chooseParcel([p], extraction({ order_number: sure("A1001") }), NOW)).toBe(p);
  });
  it("keeps the same order number at another shop apart", () => {
    const p = candidate({ order_number: "1001", shop: "別の店" });
    expect(chooseParcel([p], extraction({ order_number: sure("1001") }), NOW)).toBeNull();
  });
  it("joins a long order number across two shop names", () => {
    const p = candidate({ order_number: "123456789012", shop: "SwitchBot Japan" });
    expect(chooseParcel([p], extraction({ shop_name: "TikTok Shop", order_number: sure("123456789012") }), NOW)).toBe(p);
  });
  it("does not join on a number it is unsure of", () => {
    const p = candidate({ order_number: "1001" });
    expect(chooseParcel([p], extraction({ order_number: { value: "1001", evidence: null, confidence: 0.3 } }), NOW)).toBeNull();
  });
  it("joins a carrier notice to an order on the same day at a known shop", () => {
    const p = candidate({ shop_key: "amazon", order_number: "1", expected_date: "2026-11-03" });
    expect(chooseParcel([p], extraction({ shop_key: "amazon", tracking_number: sure("123456789012"), expected_date: sure("2026-11-03") }), NOW)).toBe(p);
  });
  it("does not join on the same day at an unknown shop", () => {
    const p = candidate({ order_number: "1", expected_date: "2026-11-03" });
    expect(chooseParcel([p], extraction({ tracking_number: sure("123456789012"), expected_date: sure("2026-11-03") }), NOW)).toBeNull();
  });
  it("does not join a subscription notice by its item", () => {
    const p = candidate({ itemNames: ["とても長い商品の名前です"] });
    expect(chooseParcel([p], extraction({ relevance: "other_purchase", items: [item("とても長い商品の名前です", null)] }), NOW)).toBeNull();
  });
  it.each(["…", "Tシャツ"])("does not join on the item name %s", (name) => {
    const p = candidate({ itemNames: ["Tシャツ黒"] });
    expect(chooseParcel([p], extraction({ items: [item(name, null)] }), NOW)).toBeNull();
  });
  it("joins a long item name cut short by the mail", () => {
    const p = candidate({ itemNames: ["とても長い商品の名前です 黒 Lサイズ"] });
    expect(chooseParcel([p], extraction({ items: [item("とても長い商品の名前です...", null)] }), NOW)).toBe(p);
  });
  it("does not join an alike item with another order number", () => {
    const p = candidate({ order_number: "1", itemNames: ["とても長い商品の名前です"] });
    expect(chooseParcel([p], extraction({ order_number: sure("2"), items: [item("とても長い商品の名前です", null)] }), NOW)).toBeNull();
  });
});

describe("startsParcel", () => {
  it("opens no parcel for a subscription notice", () => {
    expect(startsParcel(extraction({ relevance: "other_purchase" }))).toBe(false);
  });
  it("opens one when the notice carries a tracking number", () => {
    expect(startsParcel(extraction({ relevance: "other_purchase", tracking_number: sure("123456789012") }))).toBe(true);
  });
});

describe("needsCheck", () => {
  const row = (status: string, expected_date: string | null, last_email_at: string | null, expected_date_end: string | null = null) => ({ status, expected_date, expected_date_end, last_email_at });
  it.each([
    ["13 days past the date is not asked yet", row("shipped", "2026-10-20", null), false],
    ["14 days past the date is asked", row("shipped", "2026-10-19", null), true],
    ["no date, 13 days since the last mail is not asked", row("ordered", null, "2026-10-20T03:00:00Z"), false],
    ["no date, 14 days since the last mail (JST) is asked", row("ordered", null, "2026-10-18T16:00:00Z"), true],
    ["a delivered parcel never is", row("delivered", "2020-01-01", null), false],
    ["a cancelled parcel never is", row("cancelled", "2020-01-01", null), false],
    ["a window counts from its last day", row("shipped", "2026-10-01", null, "2026-10-25"), false],
    ["a window two weeks past its last day is asked", row("shipped", "2026-10-01", null, "2026-10-19"), true],
  ])("%s", (_name, p, want) => {
    expect(needsCheck(p, "2026-11-02")).toBe(want);
  });

  it("calls a parcel late from the day after its last day", () => {
    expect(isLate(row("shipped", "2026-11-01", null), "2026-11-02")).toBe(true);
    expect(isLate(row("shipped", "2026-11-02", null), "2026-11-02")).toBe(false);
    expect(isLate(row("shipped", "2026-10-30", null, "2026-11-03"), "2026-11-02")).toBe(false);
  });
});

describe("faceToFace", () => {
  it.each([
    ["unstated, not Amazon, counts as face-to-face", null, "other", true],
    ["unstated, no shop key, counts as face-to-face", null, null, true],
    ["unstated at Amazon stays unknown", null, "amazon", null],
    ["explicitly not needed stays false", false, "other", false],
    ["explicitly not needed at Amazon stays false", false, "amazon", false],
    ["explicitly needed stays true", true, "other", true],
    ["explicitly needed at Amazon stays true", true, "amazon", true],
  ] as const)("%s", (_name, requires_presence, shop_key, want) => {
    expect(faceToFace({ requires_presence, shop_key })).toBe(want);
  });
});

describe("dates from the model", () => {
  it("drops a date that does not exist instead of failing the insert", () => {
    expect(buildParcelInsert("u", extraction({ expected_date: sure("2026-02-31") }), null).expected_date).toBeNull();
  });
  it("uses the first mail as the order date of a shop that sends no order mail", () => {
    expect(buildParcelInsert("u", extraction({ relevance: "shipped", order_number: sure("1") }), "2026-11-01T17:21:00Z").ordered_at).toBe("2026-11-02");
  });
  it("does not list a carrier notice as an order", () => {
    expect(buildParcelInsert("u", extraction({ relevance: "shipped" }), "2026-11-01T17:21:00Z").ordered_at).toBeNull();
  });
});

describe("hostile mail", () => {
  it("does not throw on an impossible character reference", () => {
    expect(htmlToText("<p>&#9999999;x</p>")).toContain("x");
  });
  it("handles many unclosed comments quickly", () => {
    const started = Date.now();
    htmlToText("<!--".repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("strips comments", () => {
    expect(htmlToText("a<!-- hidden -->b")).toBe("ab");
  });
  it.each([
    "https://evil-google.com/mail/x",
    "https://notgoogle.com/mail/x",
    "https://www.google.com/url?q=https://evil.example",
    "https://mail-settings.google.com.evil.example/mail/x",
    "http://mail-settings.google.com/mail/x",
  ])("offers no button for %s", (url) => {
    expect(forwardingConfirmUrl(`click ${url}`)).toBeNull();
  });
  it("finds the link in a real confirmation", () => {
    const url = "https://mail-settings.google.com/mail/vf-abc";
    expect(forwardingConfirmUrl(`first https://support.google.com/x then ${url} end`)).toBe(url);
  });
  it("recognizes only the Gmail sender", () => {
    expect(isForwardingConfirmation("forwarding-noreply@google.com")).toBe(true);
    expect(isForwardingConfirmation("forwarding-noreply@google.com.evil.example")).toBe(false);
    expect(isForwardingConfirmation("someone@example.com")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it.each(["/\\evil.example", "/\t/evil.example", "//evil.example", "https://evil.example", "", null])("sends %s home", (value) => {
    expect(safeNextPath(value)).toBe("/app");
  });
  it("keeps a path on this site", () => {
    expect(safeNextPath("/app/settings?x=1#y")).toBe("/app/settings?x=1#y");
  });
});

describe("carrier-only mails", () => {
  const carrierMail = (over: Partial<Extraction>) => extraction({ shop_key: "other", carrier: sure("ヤマト運輸"), tracking_number: sure("123456786511"), ...over });

  it.each([
    ["the carrier itself", "ヤマト運輸株式会社"],
    ["another carrier", "佐川急便株式会社"],
    ["the addressee", "山田 太郎 様"],
    ["nothing", null],
  ])("does not show %s as the shop", (_name, shop) => {
    expect(buildParcelInsert("u", carrierMail({ shop_name: shop }), null).shop).toBe(UNKNOWN_SENDER);
  });

  it("keeps a sender the mail names", () => {
    expect(buildParcelInsert("u", carrierMail({ shop_name: "ユニクロ オンラインストア" }), null).shop).toBe("ユニクロ オンラインストア");
  });

  it("titles the parcel with the slip category until the shop names the items", () => {
    const row = buildParcelInsert("u", carrierMail({ shop_name: null, package_description: sure("衣料品") }), null);
    expect(row.title).toBe("衣料品");
    const later = extraction({ shop_name: "ユニクロ オンラインストア", items: [{ name: "エアリズムT", quantity: 1, unit_price: 1990, evidence: null }] });
    const update = buildParcelUpdate({ ...(row as ParcelRow), itemNames: [] }, later, null);
    expect(update.title).toBe("エアリズムT");
    expect(update.shop).toBe("ユニクロ オンラインストア");
  });

  it.each([
    ["000201-0000-9106", null],
    ["No. 12345678", null],
    ["衣料品", "衣料品"],
    ["PC,DESKTOP,WITHOUT DISPLAY", "PC,DESKTOP,WITHOUT DISPLAY"],
    ["Slim-RⅡ 浄水カートリッジ 2個", "Slim-RⅡ 浄水カートリッジ 2個"],
  ])("takes %s from the slip as %s", (slip, want) => {
    expect(buildParcelInsert("u", carrierMail({ shop_name: null, package_description: sure(slip) }), null).title).toBe(want);
  });

  it("keeps the item title of a parcel that already has items", () => {
    const update = buildParcelUpdate({ ...parcel({ title: "エアリズムT" }), itemNames: ["エアリズムT"] }, extraction({ items: [{ name: "別の品", quantity: 1, unit_price: null, evidence: null }] }), null);
    expect(update.title).toBeUndefined();
  });
});

describe("delivery windows", () => {
  it("stores the last day of a window", () => {
    const row = buildParcelInsert("u", extraction({ expected_date: sure("2026-10-23"), expected_date_end: sure("2026-10-31") }), null);
    expect([row.expected_date, row.expected_date_end]).toEqual(["2026-10-23", "2026-10-31"]);
  });
  it("ignores an end that is not after the start", () => {
    expect(buildParcelInsert("u", extraction({ expected_date: sure("2026-10-23"), expected_date_end: sure("2026-10-23") }), null).expected_date_end).toBeNull();
  });
  it("clears an old window when a later mail gives one day", () => {
    const update = buildParcelUpdate(parcel({ expected_date: "2026-10-23", expected_date_end: "2026-10-31" }), extraction({ expected_date: sure("2026-10-25") }), "2026-11-02T00:00:00Z");
    expect([update.expected_date, update.expected_date_end]).toEqual(["2026-10-25", null]);
  });
});

describe("mails that list several orders", () => {
  const item = (name: string, unit_price: number) => ({ name, quantity: 1, unit_price, evidence: null });
  const mail = extraction({
    relevance: "order",
    shop_key: "amazon",
    order_number: sure("250-0000000-0003813"),
    items: [item("断熱クッション", 495)],
    total_amount: sure(495),
    other_orders: [
      { order_number: sure("250-0000000-0007844"), items: [item("サウナハット", 2480)], category: null, total_amount: sure(2480), expected_date: sure("2026-10-20"), expected_date_end: none, expected_text: null },
      { order_number: none, items: [item("番号のない注文", 1)], category: null, total_amount: none, expected_date: none, expected_date_end: none, expected_text: null },
    ],
  });

  it("reads each order with only its own items and total", () => {
    const [first, second, ...rest] = splitOrders(mail);
    expect(rest).toHaveLength(0);
    expect([first.order_number.value, first.items.map((i) => i.name), first.total_amount.value]).toEqual(["250-0000000-0003813", ["断熱クッション"], 495]);
    expect([second.order_number.value, second.items.map((i) => i.name), second.total_amount.value, second.expected_date.value]).toEqual(["250-0000000-0007844", ["サウナハット"], 2480, "2026-10-20"]);
    expect(first.other_orders).toEqual([]);
  });

  it("leaves a single-order mail as it is", () => {
    expect(splitOrders(extraction({}))).toHaveLength(1);
  });
});

describe("one parcel opened twice", () => {
  const row = (id: string, tracking: string | null, order: string | null, created_at: string) => ({ id, tracking_number: tracking, order_number: order, created_at });

  it("keeps the parcel with the order number and absorbs the carrier one", () => {
    const parcels = [row("shop", "123456786511", "6083", "2026-10-15T00:00:00Z"), row("carrier", "123456786511", null, "2026-10-16T00:00:00Z"), row("other", "999", null, "2026-10-16T00:00:00Z")];
    const twins = twinsByTracking(parcels, "carrier");
    expect(twins?.keep.id).toBe("shop");
    expect(twins?.absorb.map((p) => p.id)).toEqual(["carrier"]);
  });

  it("leaves a parcel from months ago alone when the number comes back", () => {
    const parcels = [row("old", "111", null, "2026-05-01T00:00:00Z"), row("new", "111", "1001", "2026-10-16T00:00:00Z")];
    expect(twinsByTracking(parcels, "new")).toBeNull();
  });

  it("names the shop from the order mail when the carrier mail came first", () => {
    const fromSlip = buildParcelInsert("u", extraction({ shop_name: "株式会社テスト物流センター", shop_key: "other", tracking_number: sure("111") }), null);
    const update = buildParcelUpdate(fromSlip as ParcelRow, extraction({ shop_name: "テスト店", shop_key: "other", order_number: sure("1001") }), null);
    expect(update.shop).toBe("テスト店");
  });

  it("leaves two different orders apart even under one number", () => {
    const parcels = [row("a", "111", "1001", "2026-10-15T00:00:00Z"), row("b", "111", "1002", "2026-10-16T00:00:00Z")];
    expect(twinsByTracking(parcels, "a")).toBeNull();
  });

  it("rebuilds the merged parcel as if the mails had arrived in one", () => {
    const order = extraction({ relevance: "order", shop_name: "ユニクロ オンラインストア", shop_key: "uniqlo", order_number: sure("6083"), items: [{ name: "エアリズムT", quantity: 1, unit_price: 1990, evidence: null }], total_amount: sure(1990) });
    const carrierShipped = extraction({ relevance: "shipped", shop_name: "ヤマト運輸", carrier: sure("ヤマト運輸"), tracking_number: sure("123456786511"), package_description: sure("衣料品") });
    const shopShipped = extraction({ relevance: "shipped", shop_name: "ユニクロ オンラインストア", shop_key: "uniqlo", order_number: sure("6083"), tracking_number: sure("123456786511") });
    const delivered = extraction({ relevance: "delivered", shop_name: null, carrier: sure("ヤマト運輸"), tracking_number: sure("123456786511"), expected_date: sure("2026-10-17") });
    const merged = rebuildParcel("u", [
      { x: delivered, sentAt: "2026-10-17T07:36:00Z" },
      { x: order, sentAt: "2026-10-15T16:11:00Z" },
      { x: carrierShipped, sentAt: "2026-10-16T06:04:00Z" },
      { x: shopShipped, sentAt: "2026-10-16T06:09:00Z" },
    ]);
    expect([merged.shop, merged.title, merged.status, merged.order_number, merged.total_amount, merged.expected_date]).toEqual([
      "ユニクロ オンラインストア",
      "エアリズムT",
      "delivered",
      "6083",
      1990,
      "2026-10-17",
    ]);
  });
});
