import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CARRIERS } from "@/lib/carriers";
import { CATEGORIES, categoryLabel } from "@/lib/category";
import { MANUAL_CARRIERS, MANUAL_LIMITS, MANUAL_MAX_AMOUNT, MANUAL_PRESENCE, MANUAL_STATUSES, ManualParcelSchema, manualParcelRow } from "@/lib/manual-parcel";

/**
 * 「＋ 登録」 in the iOS app (ios/Otodoke/Logic/ManualParcel.swift, Screens/Parcels/ManualParcelText.swift) is a
 * copy of src/lib/manual-parcel.ts and manual-form.tsx. The Swift side is read from its source and compared with
 * the Web's own values: the limits, the choices and their words, the labels, and the sentence of every check
 * (found by asking ManualParcelSchema itself, not by a copy in this test). A Web file that cannot be read is red.
 */

const ROOT = path.resolve(__dirname, "../../..");
const readFile = (p: string) => {
  const full = path.join(ROOT, p);
  if (!existsSync(full)) throw new Error(`cannot read ${p}`);
  return readFileSync(full, "utf8");
};
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const TEXT = stripComments(readFile("ios/Otodoke/Screens/Parcels/ManualParcelText.swift"));
const LOGIC = stripComments(readFile("ios/Otodoke/Logic/ManualParcel.swift"));
const VIEW = stripComments(readFile("ios/Otodoke/Screens/Parcels/ManualParcelView.swift"));
const FORM = readFile("src/app/app/parcels/manual-form.tsx");
const PAGE = readFile("src/app/app/parcels/new/page.tsx");

const constant = (src: string, name: string) => src.match(new RegExp(`static let ${name} = "([^"\\\\]*)"`))?.[1];
const swiftLimit = (name: string, src = LOGIC) => Number(src.match(new RegExp(`static let ${name} = ([0-9_]+)`))?.[1]?.replace(/_/g, ""));
/** The `case a, b, c` list of a Swift enum. */
const swiftCases = (name: string, src = LOGIC) =>
  [...(src.match(new RegExp(`enum ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "").matchAll(/^\s*case ([A-Za-z][^\n.:]*)$/gm)].flatMap((m) =>
    m[1].split(",").map((c) => c.trim().replace(/ = .*/, "")),
  );

/** The first message ManualParcelSchema gives for a form with one field wrong. */
const message = (over: Record<string, string>) => {
  const r = ManualParcelSchema.safeParse({ title: "本", shop: "店", status: "ordered", ...over });
  return r.success ? null : r.error.issues[0]?.message;
};

describe("limits and choices", () => {
  it("the limits are the Web's", () => {
    expect(swiftLimit("title")).toBe(MANUAL_LIMITS.title);
    expect(swiftLimit("shop")).toBe(MANUAL_LIMITS.shop);
    expect(swiftLimit("tracking")).toBe(MANUAL_LIMITS.tracking);
    expect(swiftLimit("maxAmount")).toBe(MANUAL_MAX_AMOUNT);
  });

  it("the carriers, the ways of receiving and the statuses are the Web's, in the Web's order", () => {
    expect(swiftCases("ManualCarrier")).toEqual([...MANUAL_CARRIERS]);
    expect(swiftCases("ManualStatus")).toEqual([...MANUAL_STATUSES]);
    // MANUAL_PRESENCE is ["face", "drop", ""]; the Swift enum names the empty one `none`.
    expect(swiftCases("ManualPresence").map((c) => (c === "none" ? "" : c)).sort()).toEqual([...MANUAL_PRESENCE].sort());
    expect(LOGIC).toMatch(/case none = ""/);
  });

  it("each named carrier has the Web's name", () => {
    for (const key of MANUAL_CARRIERS.filter((c) => c !== "auto")) {
      expect(LOGIC, key).toContain(`case .${key}: "${CARRIERS[key].name}"`);
    }
  });
});

describe("the words", () => {
  it("every check of the schema says the Web's sentence", () => {
    const pairs: [string, string | null | undefined][] = [
      ["titleEmpty", message({ title: "" })],
      ["titleTooLong", message({ title: "あ".repeat(MANUAL_LIMITS.title + 1) })],
      ["shopEmpty", message({ shop: "" })],
      ["shopTooLong", message({ shop: "あ".repeat(MANUAL_LIMITS.shop + 1) })],
      ["orderedAtInvalid", message({ ordered_at: "2026-02-30" })],
      ["expectedDateInvalid", message({ expected_date: "2026-02-30" })],
      ["amountInvalid", message({ total_amount: String(MANUAL_MAX_AMOUNT + 1) })],
      ["categoryInvalid", message({ category: "nope" })],
      ["trackingTooLong", message({ tracking_number: "1".repeat(MANUAL_LIMITS.tracking + 1) })],
    ];
    for (const [name, web] of pairs) {
      expect(web, name).toBeTruthy();
      expect(constant(TEXT, name), name).toBe(web);
    }
  });

  it("the sentences of the action (manual-actions.ts) are the Web's", () => {
    const actions = readFile("src/app/app/parcels/manual-actions.ts");
    expect(actions).toContain(`const NOT_SIGNED_IN = "${constant(TEXT, "notSignedIn")}"`);
    expect(actions).toContain(`const FAILED = "${constant(TEXT, "failed")}"`);
  });

  it("the labels, in the Web's order, are the form's", () => {
    const labels = [...FORM.matchAll(/<label className="[^"]*">\s*(?:<span className="w-full">)?([^<\n]+?)(?:<\/span>)?\s*\n?\s*<(?:input|select)/g)].map((m) => m[1].trim()).filter(Boolean);
    expect(labels).toEqual(["品名", "店", "注文日", "お届け予定日", "金額", "分類", "追跡番号", "運送会社", "受け取り", "状態"]);
    const swiftLabels = ["titleLabel", "shopLabel", "orderedAtLabel", "expectedDateLabel", "amountLabel", "categoryLabel", "trackingLabel", "carrierLabel", "presenceLabel", "statusLabel"].map((n) => constant(TEXT, n));
    expect(swiftLabels).toEqual(labels);
    // The fields are drawn in the same order.
    const order = ["titleLabel", "shopLabel", "orderedAtLabel", "expectedDateLabel", "amountLabel", "categoryLabel", "trackingLabel", "carrierLabel", "presenceLabel", "statusLabel"].map((n) => VIEW.indexOf(`ManualParcelText.${n})`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("the choices, the unit, the example, the title and the buttons are the form's", () => {
    expect(PAGE).toContain(`<h1 className="text-xl font-bold">${constant(TEXT, "heading")}</h1>`);
    expect(FORM).toContain(`placeholder="${constant(TEXT, "amountPlaceholder")}"`);
    expect(FORM).toContain(`<span className="mt-1 text-base">${constant(TEXT, "amountUnit")}</span>`);
    expect(FORM).toContain(`<option value="auto">${constant(TEXT, "carrierAuto")}</option>`);
    expect(FORM).toContain(`<option value="">${constant(TEXT, "presenceNone")}</option>`);
    expect(FORM).toContain(`<option value="face">${constant(TEXT, "presenceFace")}</option>`);
    expect(FORM).toContain(`<option value="drop">${constant(TEXT, "presenceDrop")}</option>`);
    expect(FORM).toContain(`ordered: "${constant(TEXT, "statusOrdered")}"`);
    expect(FORM).toContain(`shipped: "${constant(TEXT, "statusShipped")}"`);
    expect(FORM).toContain(`delivered: "${constant(TEXT, "statusDelivered")}"`);
    expect(FORM).toContain(`pendingLabel="${constant(TEXT, "submitting")}"`);
    expect(FORM).toContain(`{parcel ? "保存" : "${constant(TEXT, "submit")}"}`);
    expect(constant(TEXT, "uncategorized")).toBe(categoryLabel(null));
  });

  it("the seven categories come from ParcelCategory, which category.ts already pins", () => {
    // The picker lists "" (未分類) and then the seven in CATEGORIES order.
    expect(VIEW).toContain("[(\"\", ManualParcelText.uncategorized)] + ParcelCategory.allCases.map");
    const swift = readFile("ios/Otodoke/Logic/Category.swift");
    const order = swift.match(/case ([a-z, ]+)\n\n/)?.[1].split(",").map((c) => c.trim());
    expect(order).toEqual([...CATEGORIES]);
  });

  it("the screen holds no Japanese of its own", () => {
    expect(VIEW.match(/"[^"]*[぀-ヿ一-鿿][^"]*"/g) ?? []).toEqual([]);
  });

  it("the words with no Web counterpart are listed here, so a new one is noticed", () => {
    const names = [...TEXT.matchAll(/static let (\w+) = "/g)].map((m) => m[1]);
    const onWeb = new Set([
      "heading", "titleLabel", "shopLabel", "orderedAtLabel", "expectedDateLabel", "amountLabel", "amountUnit", "amountPlaceholder", "categoryLabel",
      "trackingLabel", "carrierLabel", "presenceLabel", "statusLabel", "uncategorized", "carrierAuto", "presenceNone", "presenceFace", "presenceDrop",
      "statusOrdered", "statusShipped", "statusDelivered", "submit", "submitting", "titleEmpty", "titleTooLong", "shopEmpty", "shopTooLong",
      "orderedAtInvalid", "expectedDateInvalid", "amountInvalid", "categoryInvalid", "trackingTooLong", "checkInput", "notSignedIn", "failed",
    ]);
    // close = the sheet's close (CategorySheet's word); dateClear / dateNone = leaving a date empty; unknown = a lost answer.
    expect(names.filter((n) => !onWeb.has(n)).sort()).toEqual(["close", "dateClear", "dateNone", "unknown"]);
  });
});

describe("the columns written", () => {
  it("manualParcelRow writes exactly the columns the Swift row sends (and user_id)", () => {
    const parsed = ManualParcelSchema.parse({ title: "本", shop: "店", status: "ordered" });
    const web = Object.keys(manualParcelRow(parsed, new Date("2026-11-08T00:00:00Z"))).concat("user_id").sort();
    const keys = [...(LOGIC.match(/private enum Keys: String, CodingKey \{([\s\S]*?)\n    \}/)?.[1] ?? "").matchAll(/"([a-z_]+)"|\b(title|shop|category|carrier|status|source)\b/g)].map((m) => m[1] ?? m[2]);
    expect([...new Set(keys)].sort()).toEqual(web);
  });

  it("a new row is source manual, shop_key other, last_email_at now, category_source user, no tracking URL", () => {
    const parsed = ManualParcelSchema.parse({ title: "本", shop: "店", status: "ordered", category: "food", tracking_number: "1234-5678-9012-3" });
    const row = manualParcelRow(parsed, new Date("2026-11-07T16:00:00Z"));
    expect(row).toMatchObject({ source: "manual", shop_key: "other", ordered_at: "2026-11-08", last_email_at: "2026-11-07T16:00:00.000Z", category_source: "user", tracking_url: null, tracking_number: "1234567890123", carrier: "日本郵便" });
    expect(LOGIC).toContain('var shopKey = "other"');
    expect(LOGIC).toContain('var source = "manual"');
    expect(LOGIC).toContain('categorySource: category.isEmpty ? nil : "user"');
    expect(LOGIC).toContain("Format.todayJst(now: now)");
  });

  it("negative control: the same readers see a changed limit, word, choice or column in a mutated Swift source", () => {
    const web = message({ title: "" });
    expect(constant(TEXT, "titleEmpty")).toBe(web);
    expect(constant(TEXT.replace("品名を入れてください", "品名を入れて下さい"), "titleEmpty")).not.toBe(web);
    expect(swiftLimit("title", LOGIC.replace("static let title = 300", "static let title = 301"))).not.toBe(MANUAL_LIMITS.title);
    expect(swiftCases("ManualCarrier", LOGIC.replace("case auto, yamato", "case auto, sagawa, yamato"))).not.toEqual([...MANUAL_CARRIERS]);
    expect(constant(TEXT.replace('presenceDrop = "置き配・投函"', 'presenceDrop = "置き配"'), "presenceDrop")).not.toBe("置き配・投函");
    const keys = (src: string) => [...(src.match(/private enum Keys: String, CodingKey \{([\s\S]*?)\n    \}/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(keys(LOGIC.replace('"tracking_url"', '"tracking_uri"'))).not.toEqual(keys(LOGIC));
  });
});

describe("the sheet replaces the jump to the Web", () => {
  const list = stripComments(readFile("ios/Otodoke/Screens/Parcels/ParcelListView.swift"));

  it("「＋ 登録」 opens the form in the app and no longer opens the Web", () => {
    expect(list).toContain("manualForm = ManualParcelModel.live(list: model)");
    expect(list).not.toContain("WebLink.newParcel");
    expect(list).toMatch(/\.sheet\(item: \$manualForm\)/);
  });

  it("parcels are inserted by one call, in ParcelWriter, as the signed-in user, asking the id back", () => {
    const writer = stripComments(readFile("ios/Otodoke/Data/ParcelWriter.swift"));
    expect(writer).toMatch(/\.insert\(mine\)\.select\("id"\)/);
    expect(writer).toContain("mine.userId = me");
    const inserts: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (f.isDirectory()) walk(`${dir}/${f.name}`);
        else if (f.name.endsWith(".swift") && /from\("parcels"\)[^;{}]{0,120}?\.insert\(/.test(stripComments(readFile(`${dir}/${f.name}`)))) inserts.push(`${dir}/${f.name}`);
      }
    };
    walk("ios/Otodoke");
    expect(inserts).toEqual(["ios/Otodoke/Data/ParcelWriter.swift"]);
  });
});
