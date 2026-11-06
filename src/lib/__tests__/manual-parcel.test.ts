import { describe, expect, it } from "vitest";
import { CARRIERS } from "@/lib/carriers";
import { ManualParcelSchema, manualParcelRow } from "@/lib/manual-parcel";

/**
 * Contract pinned here (src/lib/manual-parcel.ts):
 * - `ManualParcelSchema` parses the form as sent (every value a string, "" for an empty field).
 *   Field names: title, shop, ordered_at, expected_date, total_amount, category, tracking_number,
 *   carrier ("auto" | "yamato" | "sagawa" | "japanpost" | "seino" | "fukutsu"),
 *   presence ("face" | "drop" | ""), status ("ordered" | "shipped" | "delivered").
 *   An empty optional field becomes null. Unknown keys (user_id, Next's $ACTION_ keys) are dropped.
 * - `manualParcelRow(parsed, now)` gives the parcels columns to write (without user_id).
 */

const form = (over: Record<string, string> = {}): Record<string, string> => ({
  title: "テスト用の品名",
  shop: "テスト雑貨店",
  ordered_at: "",
  expected_date: "",
  total_amount: "",
  category: "",
  tracking_number: "",
  carrier: "auto",
  presence: "",
  status: "ordered",
  ...over,
});

const ok = (over: Record<string, string> = {}) => {
  const r = ManualParcelSchema.safeParse(form(over));
  if (!r.success) throw new Error(`expected to pass: ${JSON.stringify(over)} ${r.error.message}`);
  return r.data;
};
const rejects = (over: Record<string, string>) => expect(ManualParcelSchema.safeParse(form(over)).success, JSON.stringify(over)).toBe(false);

const NOW = new Date("2026-11-03T03:00:00Z");

describe("ManualParcelSchema: what it lets through", () => {
  it("accepts the minimal form (name and shop) with every optional field empty", () => {
    const v = ok();
    expect(v.ordered_at).toBeNull();
    expect(v.expected_date).toBeNull();
    expect(v.total_amount).toBeNull();
    expect(v.category).toBeNull();
    expect(v.tracking_number).toBeNull();
  });

  it("needs a name and a shop", () => {
    rejects({ title: "" });
    rejects({ shop: "" });
  });

  it("drops keys it does not know, such as user_id", () => {
    const v = ok({ user_id: "00000000-0000-4000-8000-00000000000b", $ACTION_ID_abc: "" }) as Record<string, unknown>;
    expect(v).not.toHaveProperty("user_id");
  });

  it("takes real calendar dates only", () => {
    expect(ok({ ordered_at: "2026-11-03" }).ordered_at).toBe("2026-11-03");
    expect(ok({ expected_date: "2028-02-29" }).expected_date).toBe("2028-02-29");
    rejects({ expected_date: "2026-02-30" });
    rejects({ expected_date: "2026-02-29" });
    rejects({ expected_date: "2026-13-01" });
    rejects({ ordered_at: "2026-00-10" });
    rejects({ ordered_at: "2026/11/03" });
    rejects({ ordered_at: "明日" });
  });

  it("names the date field that is wrong", () => {
    const messageOf = (over: Record<string, string>) => ManualParcelSchema.safeParse(form(over)).error?.issues[0]?.message;
    expect(messageOf({ ordered_at: "2026-02-30" })).toBe("注文日が正しくありません");
    expect(messageOf({ expected_date: "2026-02-30" })).toBe("お届け予定日が正しくありません");
  });

  it("takes a whole yen amount from 0 to 10,000,000", () => {
    expect(ok({ total_amount: "0" }).total_amount).toBe(0);
    expect(ok({ total_amount: "1980" }).total_amount).toBe(1980);
    expect(ok({ total_amount: "10000000" }).total_amount).toBe(10_000_000);
    rejects({ total_amount: "10000001" });
    rejects({ total_amount: "-1" });
    rejects({ total_amount: "12.5" });
    rejects({ total_amount: "abc" });
  });

  it("takes the amount the way people write it: with 円, with ¥, with spaces", () => {
    for (const v of ["2480 円", "2480円", "¥2,480", "￥2,480", " 2480 ", "２４８０円", "¥ 2,480 円", " 2,480 ", "¥ 2,480", "2,480 円"]) expect(ok({ total_amount: v }).total_amount, v).toBe(2480);
    for (const v of ["円", "¥", "2480ドル", "円2480", "¥円", "2480円円"]) rejects({ total_amount: v });
    // Spaces between digits are refused, not joined; commas only are not an empty amount.
    for (const v of ["480 480", "100 200", "2 480", "2 480円", "2\u00a0480", "2　480", "2\n480", ",", ", ,", "¥10,000,001円"]) rejects({ total_amount: v });
    expect(ok({ total_amount: "10,000,000円" }).total_amount).toBe(10_000_000);
    expect(ok({ total_amount: "" }).total_amount).toBeNull();
  });

  it("takes an amount of only white space as no amount, not as a refusal (the text step trims first)", () => {
    for (const v of [" ", "\u3000", "\u00a0", "\t\n"]) expect(ok({ total_amount: v }).total_amount, JSON.stringify(v)).toBeNull();
  });

  it("takes only the listed values for category, carrier, presence and status", () => {
    expect(ok({ category: "electronics" }).category).toBe("electronics");
    rejects({ category: "toys" });
    for (const carrier of ["auto", "yamato", "sagawa", "japanpost", "seino", "fukutsu"]) ok({ carrier });
    rejects({ carrier: "dhl" });
    rejects({ carrier: "amazon" });
    ok({ presence: "face" });
    ok({ presence: "drop" });
    rejects({ presence: "maybe" });
    for (const status of ["ordered", "shipped", "delivered"]) ok({ status });
    rejects({ status: "cancelled" });
    rejects({ status: "unknown" });
  });

  it("keeps long but real names and stops absurd lengths", () => {
    // Shop listings often run past 100 characters.
    ok({ title: "あ".repeat(200) });
    ok({ shop: "い".repeat(100) });
    ok({ tracking_number: "1234-5678-9012-3456-7890" });
    rejects({ title: "あ".repeat(5000) });
    rejects({ shop: "い".repeat(5000) });
    rejects({ tracking_number: "1".repeat(500) });
  });
});

describe("manualParcelRow: the parcels columns", () => {
  it("marks the parcel as typed in and sets the fixed columns", () => {
    const row = manualParcelRow(ok(), NOW) as Record<string, unknown>;
    expect(row.title).toBe("テスト用の品名");
    expect(row.shop).toBe("テスト雑貨店");
    expect(row.shop_key).toBe("other");
    expect(row.source).toBe("manual");
    expect(row.tracking_url).toBeNull();
    expect(row.last_email_at).toBe(NOW.toISOString());
    expect(row.status).toBe("ordered");
    expect(row).not.toHaveProperty("user_id");
  });

  it("uses today in JST when the order date is empty", () => {
    expect(manualParcelRow(ok(), new Date("2026-11-03T14:59:59Z")).ordered_at).toBe("2026-11-03");
    // 00:30 on the 4th in Japan is still the 3rd in UTC.
    expect(manualParcelRow(ok(), new Date("2026-11-03T15:30:00Z")).ordered_at).toBe("2026-11-04");
    expect(manualParcelRow(ok({ ordered_at: "2026-10-01" }), NOW).ordered_at).toBe("2026-10-01");
  });

  it("keeps the date and amount as given", () => {
    const row = manualParcelRow(ok({ expected_date: "2026-11-10", total_amount: "3480" }), NOW);
    expect(row.expected_date).toBe("2026-11-10");
    expect(row.total_amount).toBe(3480);
  });

  it("records a chosen category as the user's, and leaves both empty otherwise", () => {
    const chosen = manualParcelRow(ok({ category: "hobby" }), NOW) as Record<string, unknown>;
    expect(chosen.category).toBe("hobby");
    expect(chosen.category_source).toBe("user");
    const none = manualParcelRow(ok(), NOW) as Record<string, unknown>;
    expect(none.category).toBeNull();
    expect(none.category_source).toBeNull();
  });

  it("stores the tracking number normalized, so mails with the same number find it", () => {
    expect(manualParcelRow(ok({ tracking_number: "1234-5678-9012" }), NOW).tracking_number).toBe("123456789012");
    expect(manualParcelRow(ok({ tracking_number: " tba 123456789012 " }), NOW).tracking_number).toBe("TBA123456789012");
  });

  it("names the carrier: chosen by hand, found from the number, or unknown", () => {
    expect(manualParcelRow(ok({ tracking_number: "1234-5678-9012", carrier: "yamato" }), NOW).carrier).toBe(CARRIERS.yamato.name);
    expect(manualParcelRow(ok({ tracking_number: "1234-5678-9012", carrier: "sagawa" }), NOW).carrier).toBe(CARRIERS.sagawa.name);
    expect(manualParcelRow(ok({ tracking_number: "123456789012", carrier: "japanpost" }), NOW).carrier).toBe(CARRIERS.japanpost.name);
    expect(manualParcelRow(ok({ tracking_number: "1234567890", carrier: "seino" }), NOW).carrier).toBe(CARRIERS.seino.name);
    expect(manualParcelRow(ok({ tracking_number: "1234567890", carrier: "fukutsu" }), NOW).carrier).toBe(CARRIERS.fukutsu.name);
    // Automatic: the shape of the number decides; a bare 12-digit number is not guessed.
    expect(manualParcelRow(ok({ tracking_number: "TBA123456789012", carrier: "auto" }), NOW).carrier).toBe(CARRIERS.amazon.name);
    expect(manualParcelRow(ok({ tracking_number: "123456789012", carrier: "auto" }), NOW).carrier).toBeNull();
    expect(manualParcelRow(ok({ carrier: "auto" }), NOW).carrier).toBeNull();
  });

  it("maps how it is received to requires_presence", () => {
    expect(manualParcelRow(ok({ presence: "face" }), NOW).requires_presence).toBe(true);
    expect(manualParcelRow(ok({ presence: "drop" }), NOW).requires_presence).toBe(false);
    expect(manualParcelRow(ok({ presence: "" }), NOW).requires_presence).toBeNull();
  });

  it("never builds a tracking URL from typed input", () => {
    for (const carrier of ["auto", "yamato", "sagawa", "japanpost"]) {
      expect(manualParcelRow(ok({ tracking_number: "1234-5678-9012", carrier }), NOW).tracking_url).toBeNull();
    }
  });
});
