/**
 * Writes fixtures/demo-history/: a made-up year of orders that the sample loads next to the
 * anonymized real mails in fixtures/demo, so the spend page has twelve months of bars in all seven
 * categories. Nothing here comes from a real order: every item, amount, order number and date is
 * written below or drawn from a seeded generator. No names, addresses or phone numbers; every
 * sender and link is on sample.otodoke.app (the app's own domain), never a store's.
 *
 *   npx tsx scripts/make-demo-history.ts           write the files
 *   npx tsx scripts/make-demo-history.ts --check   exit 1 when the files differ from what it would write
 *
 * One order is one 「お届けしました」 mail. Its reading (extractions.json) is built from the same
 * order as the mail, and every evidence is a line of that mail, so Claude is never called and the
 * reading cannot drift from the text. These mails are not part of the accuracy set (scripts/eval.ts
 * reads fixtures/demo only).
 *
 * Dates are written around ANCHOR; the loader moves them by (load day - ANCHOR) like the other
 * sample groups (target 0), so the year always ends the day before the sample is loaded.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Category } from "../src/lib/category";
import type { Extraction, ShopKey } from "../src/lib/extract/schema";

/** The day the history is written around: the last delivery is the day before. */
export const ANCHOR = "2026-11-08";
const SEED = 20261108;
export const SENDER_DOMAIN = "sample.otodoke.app";
export const HISTORY_DIR = path.join(process.cwd(), "fixtures", "demo-history");

/** Orders per month, oldest first: twelve months ending with the anchor's month. December and April a little higher. */
export const MONTHS: Array<[string, number]> = [
  ["2025-12", 9],
  ["2026-01", 6],
  ["2026-02", 5],
  ["2026-03", 6],
  ["2026-04", 9],
  ["2026-05", 7],
  ["2026-06", 7],
  ["2026-07", 6],
  ["2026-08", 7],
  ["2026-09", 7],
  ["2026-10", 7],
  ["2026-11", 4],
];

type Family = "amazon" | "rakuten" | "yahoo" | "uniqlo" | "yodobashi" | "irisplaza" | "kurashi" | "other";

interface Shop {
  family: Family;
  /** The seller as a reader would name it (shop_name). */
  name: string;
  key: ShopKey;
  /** Local part of the made-up sender address. */
  slug: string;
}

const AMAZON: Shop = { family: "amazon", name: "Amazon", key: "amazon", slug: "shipment-tracking" };
const UNIQLO: Shop = { family: "uniqlo", name: "ユニクロ オンラインストア", key: "uniqlo", slug: "uniqlo-order" };
const YODOBASHI: Shop = { family: "yodobashi", name: "ヨドバシ・ドット・コム", key: "yodobashi", slug: "yodobashi-order" };
const IRIS: Shop = { family: "irisplaza", name: "アイリスプラザ", key: "irisplaza", slug: "irisplaza-order" };
const KURASHI: Shop = { family: "kurashi", name: "日用品の通販 くらしモール", key: "other", slug: "kurashi-mall" };
const rakuten = (name: string, slug: string): Shop => ({ family: "rakuten", name: `${name} 楽天市場店`, key: "rakuten", slug: `rakuten-${slug}` });
const yahoo = (name: string, slug: string): Shop => ({ family: "yahoo", name: `${name} Yahoo!店`, key: "yahoo", slug: `yahoo-${slug}` });
const other = (name: string, slug: string): Shop => ({ family: "other", name, key: "other", slug });

const OUTDOOR = rakuten("アウトドア用品 そとあそび", "sotoasobi");

interface Line {
  name: string;
  price: number;
  quantity?: number;
}

interface Item {
  category: Category;
  shop: Shop;
  lines: Line[];
  /** Months (MM) the order may fall in; any month when absent. */
  months?: string[];
}

const WINTER = ["11", "12", "01", "02"];
const SUMMER = ["05", "06", "07", "08"];
const OUTSIDE = ["03", "04", "05", "06", "07", "08", "09", "10"];

const one = (category: Category, shop: Shop, name: string, price: number, extra: Partial<Item> = {}): Item => ({ category, shop, lines: [{ name, price }], ...extra });

/** Every order of the year, once each. The amounts are set here; only the dates are drawn. */
export const CATALOG: Item[] = [
  // 食費 (14): small boxes that come back often, so food shows in every month.
  one("food", AMAZON, "ドリップコーヒー 個包装 50袋", 1980),
  one("food", IRIS, "天然水 2L×9本", 1580),
  one("food", rakuten("お米の産直 みのり屋", "minoriya"), "無洗米 5kg", 3280),
  one("food", rakuten("自家焙煎珈琲 まめや", "mameya"), "コーヒー豆 中煎り 500g", 2380),
  one("food", AMAZON, "炭酸水 500ml×24本", 1890),
  { category: "food", shop: AMAZON, lines: [{ name: "オートミール 1kg", price: 980, quantity: 2 }] },
  one("food", rakuten("養蜂園の直売所", "youhouen"), "国産 はちみつ 500g", 2680),
  one("food", rakuten("讃岐の麺工房", "menkoubou"), "冷凍 讃岐うどん 20玉", 1980),
  one("food", yahoo("ナッツの専門店", "nuts"), "ミックスナッツ 素焼き 1kg", 1850),
  one("food", KURASHI, "緑茶 ティーバッグ 100包", 1620),
  one("food", other("北のめぐみ農園", "kitanomegumi"), "北海道産 じゃがいも 5kg", 2980, { months: ["09", "10", "11"] }),
  one("food", AMAZON, "レトルトカレー 中辛 10食", 1780),
  one("food", IRIS, "玄米 5kg", 3680),
  one("food", rakuten("くだもの便 果実堂", "kajitsudo"), "季節のくだもの 詰め合わせ", 3980, { months: ["06", "07", "08", "12"] }),

  // 日用品 (18)
  one("daily", KURASHI, "トイレットペーパー 12ロール×4パック", 2980),
  one("daily", KURASHI, "食器用洗剤 詰め替え 大容量", 698),
  one("daily", AMAZON, "衣料用洗剤 ジェル 詰め替え 3個", 1480),
  one("daily", KURASHI, "キッチンペーパー 12ロール", 1280),
  one("daily", AMAZON, "ゴミ袋 45L 100枚", 980),
  one("daily", AMAZON, "単3形 アルカリ乾電池 20本", 1180),
  one("daily", AMAZON, "ボックスティッシュ 5箱×3パック", 1650),
  one("daily", rakuten("収納と暮らしの店", "shuno"), "収納ケース 引き出し 3段", 3480, { months: ["03", "04", "05"] }),
  one("daily", AMAZON, "柔軟剤 詰め替え 特大", 1080),
  one("daily", AMAZON, "歯ブラシ ふつう 10本", 880),
  one("daily", AMAZON, "キッチン スポンジ 10個入り", 598),
  one("daily", yahoo("インテリア雑貨のお店", "interior"), "突っ張り棒 2本組", 1380),
  one("daily", rakuten("寝具のふとん工房", "futon"), "布団カバー セミダブル", 2780),
  one("daily", AMAZON, "すべらない ハンガー 30本", 1980),
  one("daily", yahoo("バス用品ストア", "bath"), "珪藻土 バスマット", 1780),
  one("daily", AMAZON, "フローリングワイパー 取り替えシート 60枚", 1180),
  one("daily", IRIS, "スチールラック 5段 幅90cm", 8980, { months: ["03"] }),
  one("daily", rakuten("生活雑貨 ここち", "kokochi"), "洗濯ネット 6枚セット", 798),

  // 趣味・レジャー (11)
  {
    category: "hobby",
    shop: AMAZON,
    lines: [
      { name: "文庫本 ミステリー 上巻", price: 792 },
      { name: "文庫本 ミステリー 下巻", price: 792 },
    ],
  },
  one("hobby", AMAZON, "ボードゲーム 2〜4人用", 3520),
  one("hobby", OUTDOOR, "キャンプ用 折りたたみチェア", 4980, { months: OUTSIDE }),
  one("hobby", AMAZON, "ゲームソフト アクションRPG", 6578, { months: ["08"] }),
  one("hobby", AMAZON, "漫画 全10巻セット", 6380),
  one("hobby", AMAZON, "ジグソーパズル 1000ピース", 1980),
  one("hobby", yahoo("スポーツ用品のお店", "sports"), "ヨガマット 厚さ10mm", 1690),
  one("hobby", AMAZON, "水彩色鉛筆 36色", 1870),
  one("hobby", OUTDOOR, "LED ランタン キャンプ用", 2980, { months: OUTSIDE }),
  one("hobby", AMAZON, "旅の雑誌 秋号", 990, { months: ["09", "10"] }),
  one("hobby", other("キャンプ用品の専門店 やまなみ", "yamanami"), "ドーム型 テント 2人用", 12800, { months: ["05", "06", "07"] }),

  // ファッション (11)
  { category: "fashion", shop: UNIQLO, lines: [{ name: "あったか 長袖インナー", price: 1290, quantity: 2 }], months: WINTER },
  one("fashion", UNIQLO, "ライトダウン ジャケット", 5990, { months: WINTER }),
  one("fashion", UNIQLO, "スウェット パーカー", 3990),
  one("fashion", UNIQLO, "ストレッチ スリムパンツ", 3990),
  one("fashion", UNIQLO, "靴下 3足組", 990),
  one("fashion", AMAZON, "スニーカー ホワイト", 8990),
  one("fashion", rakuten("ニットとシャツの店", "knit"), "ニット セーター", 3990, { months: ["10", "11", "12", "01"] }),
  one("fashion", AMAZON, "レインコート", 2980, { months: ["06"] }),
  one("fashion", AMAZON, "無地 Tシャツ 3枚セット", 1980, { months: SUMMER }),
  one("fashion", yahoo("革小物の工房", "kawakomono"), "冬用 手袋", 1480, { months: WINTER }),
  one("fashion", rakuten("コートの専門店", "coat"), "ウール コート", 14800, { months: ["01", "02"] }),

  // 家電・ガジェット (11): the two big orders of the year.
  one("electronics", YODOBASHI, "ワイヤレスイヤホン ノイズキャンセリング", 24800, { months: ["12"] }),
  one("electronics", YODOBASHI, "ロボット掃除機", 29800, { months: ["04"] }),
  one("electronics", AMAZON, "USB-C 充電器 65W", 3980),
  one("electronics", AMAZON, "USB-C ケーブル 2m 2本", 1580),
  one("electronics", AMAZON, "モバイルバッテリー 10000mAh", 3280),
  one("electronics", YODOBASHI, "ワイヤレスマウス", 1980),
  one("electronics", AMAZON, "スマホ 保護フィルム 2枚", 1180),
  one("electronics", AMAZON, "LED デスクライト", 5980),
  one("electronics", IRIS, "電気ケトル 1.0L", 3980),
  one("electronics", YODOBASHI, "Bluetooth スピーカー", 8800),
  one("electronics", YODOBASHI, "microSD カード 128GB", 1880),

  // 美容・健康 (10)
  one("beauty", AMAZON, "化粧水 大容量 500ml", 1650),
  one("beauty", AMAZON, "日焼け止め SPF50", 1480, { months: SUMMER }),
  { category: "beauty", shop: rakuten("ヘアケア専門店", "haircare"), lines: [{ name: "シャンプー 詰め替え", price: 880, quantity: 2 }] },
  one("beauty", AMAZON, "マルチビタミン サプリ 90日分", 1980),
  one("beauty", AMAZON, "プロテイン ココア味 1kg", 4980),
  one("beauty", yahoo("コスメのお店", "cosme"), "ハンドクリーム 3本", 1320, { months: WINTER }),
  one("beauty", AMAZON, "電動歯ブラシ 替えブラシ 4本", 1980),
  one("beauty", rakuten("お風呂じかん", "ofuro"), "入浴剤 詰め合わせ 30錠", 1580),
  one("beauty", rakuten("スキンケアの店", "skincare"), "美容液 30ml", 5500),
  one("beauty", AMAZON, "ヘアドライヤー 大風量", 9800),

  // その他 (5)
  one("other", AMAZON, "ペットシーツ レギュラー 200枚", 1780),
  one("other", AMAZON, "猫砂 7L×4袋", 2980),
  one("other", other("花の定期便", "hana"), "季節の花束", 3300),
  one("other", rakuten("ラッピング資材の店", "wrapping"), "ギフト ラッピング袋 10枚", 660, { months: ["11", "12"] }),
  one("other", other("グリーンの店 はっぱ", "happa"), "観葉植物 鉢植え", 3980),
];

/* ---------- seeded randomness ---------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- dates (JST calendar, written without time zones) ---------- */

const WEEKDAYS = "日月火水木金土";
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

interface Day {
  y: number;
  m: number;
  d: number;
}
const dayOf = (iso: string): Day => {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
};
const addDaysTo = (day: Day, n: number): Day => {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const iso = (day: Day) => `${day.y}-${pad(day.m)}-${pad(day.d)}`;
const weekday = (day: Day) => WEEKDAYS[new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()];
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const slash = (day: Day) => `${day.y}/${pad(day.m)}/${pad(day.d)}（${weekday(day)}）`;
const kanji = (day: Day) => `${day.y}年${day.m}月${day.d}日(${weekday(day)})`;
const yen = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/* ---------- the orders ---------- */

export interface HistoryOrder {
  file: string;
  item: Item;
  orderNumber: string;
  ordered: Day;
  delivered: Day;
  /** Minutes after midnight, JST. */
  orderedAt: number;
  deliveredAt: number;
  total: number;
  method: { label: string; presence: false };
  carrier: string | null;
}

const ORDER_PREFIX: Record<Family, string> = {
  amazon: "AMZ",
  rakuten: "RKT",
  yahoo: "YSH",
  uniqlo: "UNQ",
  yodobashi: "YDB",
  irisplaza: "IRS",
  kurashi: "KRS",
  other: "SHP",
};

/** How it was left: never in person (the history adds no red mark). */
const METHODS: Record<Family, Array<{ label: string; carrier: string | null }>> = {
  amazon: [
    { label: "玄関前に置き配", carrier: null },
    { label: "宅配ボックスに配達", carrier: null },
    { label: "郵便受けに配達", carrier: null },
  ],
  rakuten: [
    { label: "置き配（玄関前）", carrier: "ヤマト運輸" },
    { label: "宅配ボックス", carrier: "佐川急便" },
    { label: "ポスト投函", carrier: "日本郵便" },
  ],
  yahoo: [
    { label: "ポスト投函", carrier: "日本郵便" },
    { label: "置き配（玄関前）", carrier: "ヤマト運輸" },
  ],
  uniqlo: [{ label: "置き配（玄関前）", carrier: "ヤマト運輸" }],
  yodobashi: [{ label: "宅配ボックス", carrier: null }],
  irisplaza: [{ label: "置き配（玄関前）", carrier: "佐川急便" }],
  kurashi: [{ label: "置き配（玄関前）", carrier: "ヤマト運輸" }],
  other: [
    { label: "置き配（玄関前）", carrier: "ヤマト運輸" },
    { label: "宅配ボックス", carrier: "佐川急便" },
  ],
};

const totalOf = (item: Item) => item.lines.reduce((s, l) => s + l.price * (l.quantity ?? 1), 0);

/** Places every catalog item in a month. Constrained items first; food first of all, one per month. */
function placeInMonths(rand: () => number): Map<string, Item[]> {
  const slots = new Map(MONTHS.map(([m, n]) => [m, n]));
  const placed = new Map<string, Item[]>(MONTHS.map(([m]) => [m, []]));
  const shuffle = <T>(xs: T[]): T[] => {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const put = (item: Item, month: string) => {
    placed.get(month)!.push(item);
    slots.set(month, slots.get(month)! - 1);
  };
  const allowed = (item: Item) => MONTHS.map(([m]) => m).filter((m) => slots.get(m)! > 0 && (!item.months || item.months.includes(m.slice(5))));

  // Food: one free-to-move box in every month first, so no month is without it.
  const food = CATALOG.filter((i) => i.category === "food");
  const fixedFood = food.filter((i) => i.months);
  for (const item of fixedFood) {
    const choices = allowed(item).filter((m) => !placed.get(m)!.some((p) => p.category === "food"));
    const month = (choices.length ? choices : allowed(item))[Math.floor(rand() * (choices.length || allowed(item).length))];
    put(item, month);
  }
  const looseFood = shuffle(food.filter((i) => !i.months));
  for (const [month] of MONTHS) {
    if (placed.get(month)!.some((p) => p.category === "food")) continue;
    put(looseFood.shift()!, month);
  }

  // Then the rest, the most constrained first.
  const rest = shuffle([...CATALOG.filter((i) => i.category !== "food"), ...looseFood]).sort((a, b) => (a.months?.length ?? 99) - (b.months?.length ?? 99));
  for (const item of rest) {
    const choices = allowed(item);
    if (choices.length === 0) throw new Error(`no month left for ${item.lines[0].name}`);
    put(item, choices[Math.floor(rand() * choices.length)]);
  }
  return placed;
}

/** The history, deterministic for SEED. Throws when a rule below does not hold. */
export function buildOrders(seed = SEED): HistoryOrder[] {
  const rand = mulberry32(seed);
  const anchor = dayOf(ANCHOR);
  const lastDelivery = addDaysTo(anchor, -1);
  const placed = placeInMonths(rand);
  const orders: HistoryOrder[] = [];
  const usedNumbers = new Set<string>();
  const usedTimes = new Set<string>();
  const usedFiles = new Set<string>();
  const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");

  for (const [month, items] of placed) {
    const [y, m] = month.split("-").map(Number);
    const isLast = month === ANCHOR.slice(0, 7);
    for (const item of items) {
      // The anchor's month: ordered early enough to be delivered by the day before the anchor.
      const lastOrderDay = isLast ? Math.min(daysIn(y, m), lastDelivery.d - 3) : daysIn(y, m);
      const ordered: Day = { y, m, d: 1 + Math.floor(rand() * lastOrderDay) };
      let delivered = addDaysTo(ordered, 1 + Math.floor(rand() * 3));
      if (iso(delivered) > iso(lastDelivery)) delivered = lastDelivery;
      const orderedAt = 7 * 60 + Math.floor(rand() * 16 * 60);
      let deliveredAt = 9 * 60 + Math.floor(rand() * 11 * 60);
      while (usedTimes.has(`${iso(delivered)} ${deliveredAt}`)) deliveredAt++;
      usedTimes.add(`${iso(delivered)} ${deliveredAt}`);

      let orderNumber: string;
      do orderNumber = `${ORDER_PREFIX[item.shop.family]}-${pad(Math.floor(rand() * 10000), 4)}-${pad(Math.floor(rand() * 100000), 5)}`;
      while (usedNumbers.has(orderNumber));
      usedNumbers.add(orderNumber);

      let file: string;
      do file = `history/${iso(delivered)}_delivered_${hex(8)}.eml`;
      while (usedFiles.has(file));
      usedFiles.add(file);

      const methods = METHODS[item.shop.family];
      const method = methods[Math.floor(rand() * methods.length)];
      orders.push({
        file,
        item,
        orderNumber,
        ordered,
        delivered,
        orderedAt,
        deliveredAt,
        total: totalOf(item),
        method: { label: method.label, presence: false },
        carrier: method.carrier,
      });
    }
  }
  orders.sort((a, b) => (iso(a.delivered) + pad(a.deliveredAt, 4)).localeCompare(iso(b.delivered) + pad(b.deliveredAt, 4)));
  if (orders.length !== CATALOG.length) throw new Error("every catalog item is one order");
  return orders;
}

/* ---------- the mails ---------- */

export interface HistoryMail {
  file: string;
  source: string;
  stage: "delivered";
  message_id: string;
  date: string;
  from: string;
  from_name: string;
  subject: string;
  text: string;
  html: null;
}

/** The lines a reading points at, so evidence is always text of the mail. */
interface Rendered {
  subject: string;
  lines: string[];
  relevance: string;
  orderNumber: string;
  orderedAt: string;
  total: string;
  deliveredOn: string;
  deliveredText: string;
  method: string;
  carrier: string | null;
  items: string[];
}

const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const NOTE = "※このメールは Otodoke の見本として作ったものです。実在の注文ではありません。";
const linkOf = (o: HistoryOrder) => `https://${SENDER_DOMAIN}/orders/${o.orderNumber}`;

function render(o: HistoryOrder): Rendered {
  const { shop, lines: items } = o.item;
  const first = items[0].name;
  const title = items.length > 1 ? `${first} 他${items.length - 1}点` : first;
  const qty = (l: Line) => l.quantity ?? 1;
  const carrierLine = o.carrier ? `配送業者：${o.carrier}` : null;

  if (shop.family === "amazon") {
    const relevance = "お客様の荷物は配達済みです。";
    const deliveredOn = `配達日：${slash(o.delivered)}`;
    const method = `お届け方法：${o.method.label}`;
    const orderNumber = `注文番号：${o.orderNumber}`;
    const orderedAt = `ご注文日：${slash(o.ordered)}`;
    const total = `ご請求額：￥${yen(o.total)}`;
    const itemLines = items.map((l) => `* ${l.name}`);
    return {
      subject: `配達済み：「${title}」`,
      lines: [
        "Amazon をご利用いただき、ありがとうございます。",
        "",
        relevance,
        deliveredOn,
        method,
        "",
        orderNumber,
        orderedAt,
        "",
        "ご注文の商品",
        ...items.flatMap((l, i) => [itemLines[i], `  数量：${qty(l)}　価格：￥${yen(l.price)}`]),
        "",
        total,
        "",
        "注文の詳細を見る",
        linkOf(o),
        "",
        NOTE,
      ],
      relevance,
      orderNumber,
      orderedAt,
      total,
      deliveredOn,
      deliveredText: slash(o.delivered),
      method,
      carrier: null,
      items: itemLines,
    };
  }

  if (shop.family === "rakuten") {
    const relevance = "ご注文の商品のお届けが完了しました。";
    const orderNumber = `[受注番号] ${o.orderNumber}`;
    const orderedAt = `[注文日時] ${kanji(o.ordered)} ${hhmm(o.orderedAt)}`;
    const deliveredOn = `[お届け日] ${kanji(o.delivered)}`;
    const method = `[お届け方法] ${o.method.label}`;
    const total = `[合計金額] ${yen(o.total)}円`;
    const itemLines = items.map((l) => `[商品] ${l.name}`);
    return {
      subject: `【楽天市場】商品お届け完了のお知らせ（${shop.name}）`,
      lines: [
        `このたびは ${shop.name} をご利用いただき、誠にありがとうございます。`,
        relevance,
        "",
        orderNumber,
        orderedAt,
        deliveredOn,
        method,
        ...(carrierLine ? [`[配送業者] ${o.carrier}`] : []),
        "",
        ...items.flatMap((l, i) => [itemLines[i], `  価格 ${yen(l.price)}円 × ${qty(l)}個`]),
        total,
        "",
        "ご注文の確認はこちら",
        linkOf(o),
        "",
        NOTE,
      ],
      relevance,
      orderNumber,
      orderedAt,
      total,
      deliveredOn,
      deliveredText: kanji(o.delivered),
      method,
      carrier: o.carrier ? `[配送業者] ${o.carrier}` : null,
      items: itemLines,
    };
  }

  // The other shops: one plain layout with the shop's own name.
  const relevance = shop.family === "uniqlo" ? "ご注文商品のお届けが完了いたしました。" : "ご注文の商品をお届けしました。";
  const orderNumber = `ご注文番号：${o.orderNumber}`;
  const orderedAt = `ご注文日：${kanji(o.ordered)}`;
  const deliveredOn = `お届け日：${kanji(o.delivered)}`;
  const method = `お届け方法：${o.method.label}`;
  const total = `お支払い合計：${yen(o.total)}円`;
  const itemLines = items.map((l) => `商品名：${l.name}`);
  const subject =
    shop.family === "uniqlo" ? "＜ユニクロオンラインストア＞商品お届け完了のお知らせ" : shop.family === "yahoo" ? `【${shop.name}】商品配達完了のお知らせ` : `【${shop.name}】お届け完了のお知らせ`;
  return {
    subject,
    lines: [
      `${shop.name} をご利用いただきまして、誠にありがとうございます。`,
      relevance,
      "",
      orderNumber,
      orderedAt,
      deliveredOn,
      method,
      ...(carrierLine ? [carrierLine] : []),
      "",
      ...items.flatMap((l, i) => [itemLines[i], `数量：${qty(l)}　単価：${yen(l.price)}円`]),
      total,
      "",
      "ご注文履歴",
      linkOf(o),
      "",
      NOTE,
    ],
    relevance,
    orderNumber,
    orderedAt,
    total,
    deliveredOn,
    deliveredText: kanji(o.delivered),
    method,
    carrier: carrierLine,
    items: itemLines,
  };
}

/** A JST day and minute as an ISO instant in UTC, seconds 00. */
function instant(day: Day, minutes: number): string {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d, 0, minutes) - 9 * 3_600_000);
  return t.toISOString().replace(".000Z", "+00:00");
}

const sure = (value: string | number | boolean, evidence: string) => ({ value, evidence, confidence: 0.95 });
const none = () => ({ value: null, evidence: null, confidence: 0.9 });

export function buildHistory(seed = SEED): { mails: HistoryMail[]; extractions: Record<string, Extraction> } {
  const rand = mulberry32(seed ^ 0x5eed);
  const mails: HistoryMail[] = [];
  const extractions: Record<string, Extraction> = {};
  for (const o of buildOrders(seed)) {
    const r = render(o);
    const { shop } = o.item;
    mails.push({
      file: o.file,
      source: shop.family,
      stage: "delivered",
      message_id: `<demo-${Array.from({ length: 12 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("")}@example.invalid>`,
      date: instant(o.delivered, o.deliveredAt),
      from: `${shop.slug}@${SENDER_DOMAIN}`,
      from_name: shop.name,
      subject: r.subject,
      text: r.lines.join("\n"),
      html: null,
    });
    extractions[o.file] = {
      relevance: "delivered",
      relevance_evidence: r.relevance,
      shop_name: shop.name,
      shop_key: shop.key,
      order_number: sure(o.orderNumber, r.orderNumber),
      items: o.item.lines.map((l, i) => ({ name: l.name, quantity: l.quantity ?? 1, unit_price: l.price, evidence: r.items[i] })),
      category: o.item.category,
      package_description: none(),
      total_amount: sure(o.total, r.total),
      ordered_at: sure(iso(o.ordered), r.orderedAt),
      carrier: o.carrier && r.carrier ? sure(o.carrier, r.carrier) : none(),
      tracking_number: none(),
      expected_date: sure(iso(o.delivered), r.deliveredOn),
      expected_date_end: none(),
      expected_window_start: none(),
      expected_window_end: none(),
      expected_text: r.deliveredText,
      requires_presence: sure(o.method.presence, r.method),
      other_orders: [],
      overall_confidence: 0.95,
      notes: null,
    } as Extraction;
  }
  return { mails, extractions };
}

/** Every file this script writes, by path under HISTORY_DIR, with its content. */
export function historyFiles(seed = SEED): Map<string, string> {
  const { mails, extractions } = buildHistory(seed);
  const files = new Map<string, string>();
  files.set(
    "set.json",
    JSON.stringify(
      {
        groups: [
          {
            name: "支出の履歴: 見本として作った 1 年分の注文（すべて配達済み。scripts/make-demo-history.ts が書く）",
            anchor: ANCHOR,
            target: 0,
            files: mails.map((m) => m.file.replace(/\.eml$/, "")),
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  files.set("extractions.json", JSON.stringify(extractions, null, 2) + "\n");
  for (const m of mails) files.set(`mails/${m.file.replace(/\.eml$/, "").replace("/", "__")}.json`, JSON.stringify(m, null, 1) + "\n");
  return files;
}

function main() {
  const files = historyFiles();
  if (process.argv.includes("--check")) {
    const existing = new Set(readdirSync(path.join(HISTORY_DIR, "mails")).map((f) => `mails/${f}`));
    const stale: string[] = [];
    for (const [p, body] of files) {
      existing.delete(p);
      let now = "";
      try {
        now = readFileSync(path.join(HISTORY_DIR, p), "utf8");
      } catch {}
      if (now !== body) stale.push(p);
    }
    stale.push(...existing);
    if (stale.length) {
      console.error(`fixtures/demo-history differs from the script: ${stale.slice(0, 5).join(", ")}${stale.length > 5 ? " …" : ""}`);
      process.exit(1);
    }
    console.log("fixtures/demo-history is up to date");
    return;
  }
  rmSync(path.join(HISTORY_DIR, "mails"), { recursive: true, force: true });
  mkdirSync(path.join(HISTORY_DIR, "mails"), { recursive: true });
  for (const [p, body] of files) writeFileSync(path.join(HISTORY_DIR, p), body);
  console.log(`wrote ${files.size} files to fixtures/demo-history`);
}

if (process.argv[1] && path.basename(process.argv[1]) === "make-demo-history.ts") main();
