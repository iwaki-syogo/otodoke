import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * fixtures/demo-history is public and made up. Machine check that it carries nothing of a person
 * or of a real store: no mail address but the sample sender's (and the made-up Message-IDs), no
 * link but sample.otodoke.app, no phone number, no postal code, no real store domain, no name
 * before 様, and no long number that could be someone's tracking or order number.
 */
const DIR = path.join(process.cwd(), "fixtures", "demo-history");

/** Every committed file of the history, as text: whatever a field is called, it is scanned. */
const files = [
  "set.json",
  "extractions.json",
  ...readdirSync(path.join(DIR, "mails")).map((f) => `mails/${f}`),
].map((p) => ({ name: p, body: readFileSync(path.join(DIR, p), "utf8") }));

const SENDER = "@sample.otodoke.app";
/** Message-IDs are replaced on loading (demoInput), and use the reserved .invalid domain, like fixtures/demo. */
const MESSAGE_ID = /^demo-[0-9a-f]+@example\.invalid$/;
const REAL_STORE_DOMAINS = [
  "amazon.co.jp",
  "amazon.com",
  "amazon.jp",
  "rakuten.co.jp",
  "rakuten.ne.jp",
  "rakuten.com",
  "yahoo.co.jp",
  "yahoo.com",
  "uniqlo.com",
  "uniqlo.co.jp",
  "yodobashi.com",
  "yodobashi.co.jp",
  "irisplaza.co.jp",
  "irisohyama.co.jp",
  "lohaco.jp",
  "askul.co.jp",
  "kuronekoyamato.co.jp",
  "sagawa-exp.co.jp",
  "post.japanpost.jp",
  "japanpost.jp",
];

/** What is wrong with one text, as short notes; empty when it is clean. */
function personalInfoIn(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
    if (!m[0].endsWith(SENDER) && !MESSAGE_ID.test(m[0])) found.push(`address ${m[0]}`);
  }
  for (const m of body.matchAll(/https?:\/\/([^/\s"<>]+)/g)) {
    if (m[1] !== "sample.otodoke.app") found.push(`link ${m[0]}`);
  }
  const lower = body.toLowerCase();
  for (const d of REAL_STORE_DOMAINS) if (lower.includes(d)) found.push(`store domain ${d}`);
  // 03-1234-5678, 090-1234-5678, 0120-123-456, (03)1234-5678, and the same without hyphens.
  for (const m of body.matchAll(/(?<![\w-])\(?0\d{1,4}[-)）(（]\d{1,4}[-)）]?\d{3,4}(?![\d-])/g)) found.push(`phone ${m[0]}`);
  for (const m of body.matchAll(/(?<!\d)0\d{9,10}(?!\d)/g)) found.push(`phone ${m[0]}`);
  if (body.includes("〒")) found.push("postal mark 〒");
  for (const m of body.matchAll(/(?<![\d-])\d{3}-\d{4}(?![\d-])/g)) found.push(`postal code ${m[0]}`);
  // A tracking number is 10 to 14 digits, often in groups. The made-up order numbers have 9.
  // The made-up Message-IDs are hex and may hold a run of digits: they are left out of this one.
  for (const m of body.replace(/<demo-[0-9a-f]+@example\.invalid>/g, "<demo-id>").matchAll(/\d+(?:[-\s]\d+)*/g)) {
    if (m[0].replace(/\D/g, "").length >= 10) found.push(`long number ${m[0]}`);
  }
  // A name before 様: only お客様 is allowed.
  for (const m of body.matchAll(/(.{0,6})様/g)) if (!m[1].endsWith("お客")) found.push(`addressee ${m[0]}`);
  return found;
}

describe("fixtures/demo-history carries no personal information", () => {
  it("has the files to check", () => {
    expect(files.length).toBe(82);
  });

  it.each(files.map((f) => [f.name, f.body] as const))("%s is clean", (_, body) => {
    expect(personalInfoIn(body)).toEqual([]);
  });

  it("names a sender, a link and an order number in every mail, so the check has something to look at", () => {
    for (const f of files.filter((x) => x.name.startsWith("mails/"))) {
      expect(f.body, f.name).toContain(SENDER);
      expect(f.body, f.name).toContain("https://sample.otodoke.app/orders/");
      expect(f.body, f.name).toMatch(/[A-Z]{3}-\d{4}-\d{5}/);
    }
  });

  it("negative control: each kind of leak is caught", () => {
    const leaks: Array<[string, string]> = [
      ["送信元 order@shop.example.com", "address"],
      ["https://www.amazon.co.jp/gp/your-account/order-details", "link"],
      ["Amazon.co.jp をご利用いただき", "store domain"],
      ["詳しくは rakuten.co.jp まで", "store domain"],
      ["TEL 03-1234-5678", "phone"],
      ["携帯 090-1234-5678", "phone"],
      ["電話 09012345678", "phone"],
      ["0120-123-456", "phone"],
      ["〒100-0001", "postal"],
      ["住所 150-0002 東京都", "postal code"],
      ["お問い合わせ番号：4829-1530-7128", "long number"],
      ["伝票番号 482915307128", "long number"],
      ["<demo-4040924643f4@example.com>", "address"],
      ["山田 太郎 様", "addressee"],
    ];
    for (const [text, kind] of leaks) expect(personalInfoIn(text).join(" "), text).toContain(kind);
    // And what the history does write is not taken for a leak.
    expect(personalInfoIn("注文番号：AMZ-3180-60573\nご注文日：2025/12/03（水）\nご請求額：￥1,650\nhttps://sample.otodoke.app/orders/AMZ-3180-60573\nお客様の荷物は配達済みです。")).toEqual([]);
  });
});
