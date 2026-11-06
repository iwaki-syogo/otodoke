import { z } from "zod";
import { CATEGORIES, categoryLabel } from "@/lib/category";

/**
 * What Claude returns for one email. Every value carries the line of the mail it
 * came from (`evidence`) and a confidence, so the UI can show "why" and flag
 * uncertain values for review instead of asserting them.
 *
 * Keep this schema structured-output friendly: no regex / min / max constraints.
 */

const confidence = z.number().describe("0〜1。原文に明記されていれば 0.9 以上、推測を含むなら 0.5 以下");

const evidence = z
  .string()
  .nullable()
  .describe("値の根拠になった元メールの行を原文のまま（60 文字以内）。無ければ null");

export const StrField = z.object({ value: z.string().nullable(), evidence, confidence });
export const IntField = z.object({ value: z.number().int().nullable(), evidence, confidence });
export const BoolField = z.object({ value: z.boolean().nullable(), evidence, confidence });

/** The largest Postgres `integer`: parcels.total_amount, parcel_items.quantity and unit_price. */
export const DB_INT_MAX = 2_147_483_647;

/**
 * A count or an amount in yen that those columns can hold, else null (unknown). The schema holds
 * the model to whole numbers but not to their size, and a mail can say "合計 3,000,000,000円".
 */
export function storableInt(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value >= 0 && value <= DB_INT_MAX ? value : null;
}

export const Relevance = z.enum([
  "order", // 注文を受け付けた
  "payment", // 決済完了・処方箋確認など、注文に付随する中間連絡
  "shipped", // 発送した（配達予定が付くことがある）
  "out_for_delivery", // 本日配達・配達中
  "delivered", // 配達完了
  "attempted", // 不在で持ち帰り・再配達の案内
  "cancelled", // キャンセル・返金
  "other_purchase", // 買い物に関係するが上記のどれでもない（定期便の変更、返品受付など）
  "unrelated", // 買い物・配達に関係しない（広告・ログイン通知・レビュー依頼など）
]);
export type Relevance = z.infer<typeof Relevance>;

export const ShopKey = z.enum([
  "amazon",
  "rakuten",
  "ocn",
  "lensapple",
  "irisplaza",
  "yodobashi",
  "uniqlo",
  "mercari",
  "yahoo",
  "other",
]);
export type ShopKey = z.infer<typeof ShopKey>;

const category = z
  .enum(CATEGORIES)
  .nullable()
  .describe(`品名と店から選ぶ支出の分類: ${CATEGORIES.map((c) => `${c}=${categoryLabel(c)}`).join(" / ")}。品名も店も分からなければ null`);

export const ItemSchema = z.object({
  name: z.string().describe("商品名。省略記号「...」で切れていてもそのまま"),
  quantity: z.number().int().nullable(),
  unit_price: z.number().int().nullable().describe("税込の単価（円）。不明なら null"),
  evidence,
});

/** Another order printed in the same mail (Amazon lists several orders in one confirmation). */
export const OtherOrderSchema = z.object({
  order_number: StrField.describe("この注文の注文番号"),
  items: z.array(ItemSchema).describe("この注文の商品だけ"),
  category: category.describe("この注文の商品の分類。品名も店も分からなければ null"),
  total_amount: IntField.describe("この注文の合計（円）"),
  expected_date: StrField.describe("この注文の配達予定日 YYYY-MM-DD"),
  expected_date_end: StrField.describe("この注文の配達予定が範囲なら最後の日 YYYY-MM-DD。範囲でなければ null"),
  expected_text: z.string().nullable().describe("この注文の配達予定の原文表記"),
});
export type OtherOrder = z.infer<typeof OtherOrderSchema>;

export const ExtractionSchema = z.object({
  relevance: Relevance,
  relevance_evidence: z.string().nullable().describe("そう判定した根拠の行"),
  shop_name: z
    .string()
    .nullable()
    .describe("商品を売った店・送り主の表示名。運送会社の通知ならご依頼主。受取人（お届け先・〇〇様）や運送会社の名前は入れない。分からなければ null"),
  shop_key: ShopKey.nullable(),
  order_number: StrField.describe("注文番号・受付番号・ご注文 ID。ハイフン等は原文のまま"),
  items: z.array(ItemSchema).describe("最初の注文の商品だけ。別の注文の商品は other_orders に入れる"),
  category,
  package_description: StrField.describe("運送会社の伝票の品名（例: 衣料品、電子機器）。店の商品名ではない"),
  total_amount: IntField.describe("注文合計（円、送料込み）。この通知で金額が分からなければ null"),
  ordered_at: StrField.describe("注文日 YYYY-MM-DD"),
  carrier: StrField.describe("運送会社名（原文の表記）"),
  tracking_number: StrField.describe("伝票番号・お問い合わせ番号・追跡番号（数字のみに正規化しない、原文のまま）"),
  expected_date: StrField.describe("配達予定日 YYYY-MM-DD。範囲なら最初の日。配達完了の通知なら配達した日。基準日から年を補う"),
  expected_date_end: StrField.describe("配達予定が範囲で書かれているときの最後の日 YYYY-MM-DD。範囲でなければ null"),
  expected_window_start: StrField.describe("配達予定時間帯の開始 HH:MM（24 時間）。「午前中」は 08:00"),
  expected_window_end: StrField.describe("配達予定時間帯の終了 HH:MM。「午前中」は 12:00"),
  expected_text: z.string().nullable().describe("配達予定の原文表記（例: 11月3日(月) 14:00-16:00）"),
  requires_presence: BoolField.describe(
    "在宅が必要か。対面・手渡し・受領印・置き配対象外・本人限定・代金引換・クール便なら true。置き配・宅配ボックス・ポスト投函・ネコポス・ゆうパケット・クリックポスト・メール便なら false。明記がなければ null",
  ),
  other_orders: z.array(OtherOrderSchema).describe("同じメールに載っている 2 つ目以降の注文。1 注文だけなら空配列"),
  overall_confidence: z.number().describe("この抽出全体の確信度 0〜1"),
  notes: z.string().nullable().describe("抽出で迷った点や読み取れなかった点（日本語、1〜2 文）"),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const NO_VALUE = { value: null, evidence: null, confidence: 0 };

/**
 * Results saved before a field existed (the demo cache, older rows) lack it.
 * Fill the gaps so every reader sees the current shape.
 */
export function withDefaults(x: Extraction): Extraction {
  const partial = x as Partial<Extraction>;
  return {
    ...x,
    package_description: partial.package_description ?? { ...NO_VALUE },
    expected_date_end: partial.expected_date_end ?? { ...NO_VALUE },
    category: partial.category ?? null,
    other_orders: (partial.other_orders ?? []).map((o) => ({ ...o, category: o.category ?? null })),
  };
}
