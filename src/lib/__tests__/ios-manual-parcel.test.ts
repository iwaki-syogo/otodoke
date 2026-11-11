import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CARRIERS } from "@/lib/carriers";
import { CATEGORIES, categoryLabel } from "@/lib/category";
import { STATUS_LABEL } from "@/lib/format";
import {
  MANUAL_CANCELLED,
  MANUAL_CARRIED_STATUSES,
  MANUAL_CARRIERS,
  MANUAL_DELETE_UNCHECKED,
  MANUAL_KEEP_CARRIER,
  MANUAL_LIMITS,
  MANUAL_MAX_AMOUNT,
  MANUAL_PRESENCE,
  MANUAL_STATUSES,
  ManualParcelSchema,
  manualCarrierChoice,
  manualParcelFields,
  manualParcelRow,
  manualParcelSchemaFor,
} from "@/lib/manual-parcel";

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
const EDIT_PAGE = readFile("src/app/app/parcels/[id]/edit/page.tsx");
const DETAIL_PAGE = readFile("src/app/app/parcels/[id]/page.tsx");
const ACTIONS = readFile("src/app/app/parcels/manual-actions.ts");

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
      "editHeading", "edit", "save", "deleteSummary", "deleteWarning", "deleteConfirm", "deleteButton", "deleting", "notFound", "deleteFailed", "deleteUnchecked",
    ]);
    // close = the sheet's close (CategorySheet's word); dateClear / dateNone = leaving a date empty; unknown / deleteUnknown = a lost
    // answer; changed = the parcel changed between the read and the write (the detail page's existing words).
    expect(names.filter((n) => !onWeb.has(n)).sort()).toEqual(["changed", "close", "dateClear", "dateNone", "deleteUnknown", "unknown"]);
  });

  it("`changed` is the detail page's existing sentence (ParcelDetailModel.notDeliveredFailed and the Web's NOT_UPDATED)", () => {
    const detailText = (readFile("ios/Otodoke/Screens/Detail/ParcelDetailModel.swift").match(/static let notDeliveredFailed = "([^"]+)"/) ?? [])[1];
    const changed = (TEXT.match(/static let changed = "([^"]+)"/) ?? [])[1];
    expect(detailText).toBeTruthy();
    expect(changed).toBe(detailText);
    expect(readFile("src/app/app/parcel-actions.ts")).toContain(`const NOT_UPDATED = "${changed}"`);
    // The Web's edit of a typed-in parcel (updated_at check) answers with the same sentence.
    expect(readFile("src/app/app/parcels/manual-actions.ts")).toContain(`const CHANGED = "${changed}"`);
  });
});

describe("the columns written", () => {
  it("manualParcelRow writes exactly the columns the Swift row sends (and user_id)", () => {
    const parsed = ManualParcelSchema.parse({ title: "本", shop: "店", status: "ordered" });
    // "id" is the one the form makes when it is opened (the Web lets the database make it).
    const web = Object.keys(manualParcelRow(parsed, new Date("2026-11-08T00:00:00Z"))).concat("user_id", "id").sort();
    const keys = [...(LOGIC.match(/private enum Keys: String, CodingKey \{([\s\S]*?)\n    \}/)?.[1] ?? "").matchAll(/"([a-z_]+)"|\b(id|title|shop|category|carrier|status|source)\b/g)].map((m) => m[1] ?? m[2]);
    expect([...new Set(keys)].sort()).toEqual(web);
  });

  it("a new row is source manual, shop_key other, last_email_at now, category_source user, no tracking URL", () => {
    const parsed = ManualParcelSchema.parse({ title: "本", shop: "店", status: "ordered", category: "food", tracking_number: "1234-5678-9012-3" });
    const row = manualParcelRow(parsed, new Date("2026-11-07T16:00:00Z"));
    expect(row).toMatchObject({ source: "manual", shop_key: "other", ordered_at: "2026-11-08", last_email_at: "2026-11-07T16:00:00.000Z", category_source: "user", tracking_url: null, tracking_number: "1234567890123", carrier: "日本郵便" });
    expect(LOGIC).toContain('var shopKey = "other"');
    expect(LOGIC).toContain('var source = "manual"');
    expect(LOGIC).toContain('categorySource: v.category.isEmpty ? nil : "user"');
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

describe("the edit and the delete", () => {
  const detail = stripComments(readFile("ios/Otodoke/Screens/Detail/ParcelDetailView.swift"));
  const detailModel = stripComments(readFile("ios/Otodoke/Screens/Detail/ParcelDetailModel.swift"));
  const writer = stripComments(readFile("ios/Otodoke/Data/ParcelWriter.swift"));
  const model = stripComments(readFile("ios/Otodoke/Screens/Parcels/ManualParcelModel.swift"));

  it("the words are the Web's: heading, the link, the save button, the delete box", () => {
    expect(EDIT_PAGE).toContain(`<h1 className="text-xl font-bold">${constant(TEXT, "editHeading")}</h1>`);
    expect(DETAIL_PAGE).toMatch(new RegExp(`>\\s*${constant(TEXT, "edit")}\\s*</Link>`));
    expect(FORM).toContain(`{parcel ? "${constant(TEXT, "save")}" :`);
    expect(FORM).toContain(`<summary className="cursor-pointer text-neutral-500">${constant(TEXT, "deleteSummary")}</summary>`);
    expect(FORM).toContain(`<p id={warningId} className="text-sm leading-6">${constant(TEXT, "deleteWarning")}</p>`);
    expect(FORM).toMatch(new RegExp(`/>\\s*${constant(TEXT, "deleteConfirm")}\\s*</label>`));
    expect(FORM).toContain(`pendingLabel="${constant(TEXT, "deleting")}"`);
    expect(FORM).toMatch(new RegExp(`>\\s*${constant(TEXT, "deleteButton")}\\s*</SubmitButton>`));
  });

  it("the sentences of the actions are the Web's, and the unchecked delete says MANUAL_DELETE_UNCHECKED", () => {
    expect(ACTIONS).toContain(`const NOT_FOUND = "${constant(TEXT, "notFound")}"`);
    expect(ACTIONS).toContain(`error: "${constant(TEXT, "deleteFailed")}"`);
    expect(constant(TEXT, "deleteUnchecked")).toBe(MANUAL_DELETE_UNCHECKED);
    // Negative control: a word changed in the Swift text is not the Web's.
    expect(constant(TEXT.replace("削除できませんでした", "消せませんでした"), "deleteFailed")).not.toBe("削除できませんでした");
  });

  it("the constants of the edit are the Web's", () => {
    expect(LOGIC).toContain(`static let keepCarrier = "${MANUAL_KEEP_CARRIER}"`);
    expect(LOGIC).toContain(`static let cancelled = "${MANUAL_CANCELLED}"`);
    expect(LOGIC).toContain(`static let carriedStatuses = [${MANUAL_CARRIED_STATUSES.map((c) => `"${c}"`).join(", ")}]`);
    // The labels of the statuses a mail sets are STATUS_LABEL's, which Format.statusLabel copies.
    const format = stripComments(readFile("ios/Otodoke/Logic/Format.swift"));
    for (const status of [...MANUAL_CARRIED_STATUSES, MANUAL_CANCELLED]) expect(format).toContain(`"${status}": "${STATUS_LABEL[status]}"`);
  });

  it("the Web's checks for an edit: a cancelled parcel may stay cancelled, the stored amount may be saved back", () => {
    const form = { title: "本", shop: "店" };
    expect(manualParcelSchemaFor("shipped", null).safeParse({ ...form, status: "cancelled" }).success).toBe(false);
    expect(manualParcelSchemaFor("cancelled", null).safeParse({ ...form, status: "cancelled" }).success).toBe(true);
    expect(manualParcelSchemaFor("shipped", null).safeParse({ ...form, status: "out_for_delivery" }).success).toBe(true);
    expect(manualParcelSchemaFor("shipped", MANUAL_MAX_AMOUNT * 2).safeParse({ ...form, status: "shipped", total_amount: String(MANUAL_MAX_AMOUNT * 2) }).success).toBe(true);
    expect(manualParcelSchemaFor("shipped", MANUAL_MAX_AMOUNT * 2).safeParse({ ...form, status: "shipped", total_amount: String(MANUAL_MAX_AMOUNT * 2 + 1) }).success).toBe(false);
    expect(manualParcelSchemaFor("shipped", null).safeParse({ ...form, status: "shipped", total_amount: String(MANUAL_MAX_AMOUNT + 1) }).success).toBe(false);
    // Swift: the same three rules.
    expect(LOGIC).toContain("if saved.status == cancelled { statuses.insert(cancelled) }");
    expect(LOGIC).toContain("storedAmount: saved.totalAmount");
    expect(LOGIC).toContain("n <= ManualLimits.maxAmount || n == stored");
  });

  it("an unchanged category, date, number and way of receiving are not written (manualParcelFields)", () => {
    const saved = { category: "food", ordered_at: "2026-11-01", expected_date: "2026-11-10", tracking_number: "1234567890123", carrier: "日本郵便", requires_presence: true };
    const form = { title: "本", shop: "店", status: "shipped", category: "food", expected_date: "2026-11-10", tracking_number: "1234567890123", carrier: "japanpost", presence: "face", ordered_at: "", total_amount: "" };
    const parsed = manualParcelSchemaFor("shipped", null).parse(form);
    const kept = manualParcelFields(parsed, new Date("2026-11-08T00:00:00Z"), saved);
    for (const key of ["category", "category_source", "expected_date", "expected_date_end", "expected_window_start", "expected_window_end", "expected_text", "tracking_number", "carrier", "tracking_url", "presence_evidence"]) {
      expect(kept, key).not.toHaveProperty(key);
    }
    // An empty order date keeps the stored one (the Swift edit does not write it at all).
    expect(kept.ordered_at).toBe("2026-11-01");
    expect(LOGIC).toContain("let ordered: String? = v.ordered.isEmpty ? saved.orderedAt : v.ordered");
    // A changed one drops what came with the old value.
    const changed = manualParcelFields(manualParcelSchemaFor("shipped", null).parse({ ...form, category: "daily", expected_date: "2026-11-12", tracking_number: "999", presence: "drop" }), new Date(), saved);
    expect(changed).toMatchObject({ category: "daily", category_source: "user", expected_date: "2026-11-12", expected_text: null, tracking_url: null, presence_evidence: null });
    // The columns always written.
    expect(Object.keys(kept).sort()).toEqual(["ordered_at", "requires_presence", "shop", "shop_key", "status", "title", "total_amount"]);
    for (const key of ["title", "shop", "shop_key", "total_amount", "status", "requires_presence"]) expect(LOGIC, key).toContain(`"${key}"`);
  });

  it("the carrier choice for a stored name is the Web's", () => {
    expect(manualCarrierChoice("日本郵便", "123")).toBe("japanpost");
    expect(manualCarrierChoice(null, null)).toBe("auto");
    expect(manualCarrierChoice("ゆうパック便", null)).toBe(MANUAL_KEEP_CARRIER);
    expect(LOGIC).toContain("if name == nil || carrierName(.auto, tracking: tracking) == name { return ManualCarrier.auto.rawValue }");
  });

  it("an edit is read, then written as the signed-in user's typed-in parcel on the version read; a delete likewise", () => {
    expect(ACTIONS).toMatch(/\.eq\("source", "manual"\)/);
    // Per function (not a count): the read of an edit, the manualEdit conditions of the one write, and the delete.
    const body = (start: string, end: string) => {
      const from = writer.indexOf(start);
      const to = writer.indexOf(end, from + start.length);
      expect(from, start).toBeGreaterThan(-1);
      expect(to, end).toBeGreaterThan(from);
      return writer.slice(from, to);
    };
    const manualOnly = /\.eq\("source", value: "manual"\)/;
    expect(body("func updateManual(", "private func announcedEdit(")).toMatch(manualOnly);
    expect(body("case let .manualEdit(_, updatedAt):\n                query", "response = try await query")).toMatch(manualOnly);
    expect(body("func deleteManual(", "private func announce<T>(")).toMatch(manualOnly);
    // The update goes through the one write function, on the updated_at the form was opened with (as the Web's hidden
    // field carries it, manual-actions.ts), with source = manual added to its filters. A form opened on another version
    // writes nothing: it is compared with the version just read before anything is written.
    expect(writer).toContain("write(id: id, .manualEdit(columns, updatedAt: openedUpdatedAt))");
    expect(writer).toContain("guard !openedUpdatedAt.isEmpty, openedUpdatedAt == saved.updatedAt else { return .changed }");
    expect(writer.indexOf("openedUpdatedAt == saved.updatedAt")).toBeLessThan(writer.indexOf("ManualParcel.checkEdit(input, saved: saved)"));
    expect(readFile("ios/Otodoke/Screens/Parcels/ManualParcelModel.swift")).toContain("update(parcel.id, typed, parcel.updatedAt)");
    expect(writer).toMatch(/case let \.manualEdit\(_, updatedAt\):\s*query = query\s*\.eq\("source", value: "manual"\)\s*\.eq\("updated_at", value: updatedAt\)/);
    expect(writer).toMatch(/\.delete\(\)\s*\.eq\("id", value: id\)\s*\.eq\("user_id", value: me\)\s*\.eq\("source", value: "manual"\)\s*\.select\("id"\)/);
  });

  it("the detail page edits in the app and no longer opens the Web's edit page", () => {
    expect(detail).toContain("model.makeEditForm()");
    expect(detail).toMatch(/\.sheet\(item: \$editForm, onDismiss: \{/);
    // The page goes back only once the sheet has closed, never in the same moment.
    expect(detail).toMatch(/onDismiss: \{\s*if deletedInSheet \{\s*deletedInSheet = false\s*dismiss\(\)/);
    expect(detail).toContain("deleted: { deletedInSheet = true; editForm = nil }");
    expect(detail).not.toMatch(/deleted: \{ dismiss\(\) \}/);
    expect(detail).not.toContain("model.editURL");
    expect(detail).toContain("Button(ManualParcelText.edit)");
    expect(detailModel).not.toContain("parcelEdit");
    expect(stripComments(readFile("ios/Otodoke/Screens/Shared/OpenWeb.swift"))).not.toContain("parcelEdit");
    // Only a typed-in parcel has 編集, as the Web's link is shown only for source = manual.
    expect(DETAIL_PAGE).toContain('parcel.source === "manual"');
    expect(detailModel).toContain('row?.source == "manual"');
  });

  it("a new parcel is sent with the id its form made; a duplicate of it counts as made", () => {
    expect(model).toContain("newID: String = UUID().uuidString.lowercased()");
    expect(model).toContain("id: newID");
    expect(writer).toContain('failure.code == "23505"');
  });

  it("nothing closes the sheet while a write is on its way, and an error is read out", () => {
    expect(VIEW).toContain(".disabled(model.isBusy)");
    expect(VIEW).toContain(".interactiveDismissDisabled(model.isBusy)");
    expect(VIEW).toContain("AccessibilityNotification.Announcement(message).post()");
    expect(VIEW).toContain("proxy.scrollTo(row, anchor: .center)");
  });
});
