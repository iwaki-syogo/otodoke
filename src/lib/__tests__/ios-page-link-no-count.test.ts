import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「受け取り済み」「キャンセルした荷物」 on the iOS parcel tab are the name and an arrow: no number, no 「件」 (the
 * owner's wish). The number is shown by the page each one opens, beside its heading, written as the Web writes it
 * (delivered: DeliveredHeading in filter-form.tsx, cancelled: cancelled/page.tsx, both toLocaleString("ja-JP")).
 * The number is not read for the list any more (one request fewer per read); the unread mail is still counted.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => {
  if (!existsSync(path.join(ROOT, p))) throw new Error(`cannot read ${p}`);
  return readFileSync(path.join(ROOT, p), "utf8");
};
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
const ios = (p: string) => stripComments(read(`ios/Otodoke/${p}`));

/** Whatever would put a number or 「件」 on a page link, or keep the counts the number came from. */
const COUNT_ON_LINK = /PageLinkRow\([^)]*\bcount:|PageLinkText|deliveredCount|cancelledCount/;

describe("the page links of the list carry no count", () => {
  const list = ios("Screens/Parcels/ParcelListView.swift");
  const calendar = ios("Screens/Calendar/CalendarView.swift");
  const row = ios("Screens/Parcels/PageLinkRow.swift");

  it("both links are the name alone, as the calendar's one is", () => {
    expect(list).toContain('PageLinkRow(label: "受け取り済み") {');
    expect(list).toContain('PageLinkRow(label: "キャンセルした荷物") {');
    expect(calendar).toContain('PageLinkRow(label: "受け取り済み") {');
    expect(list).not.toMatch(COUNT_ON_LINK);
    expect(calendar).not.toMatch(COUNT_ON_LINK);
  });

  it("PageLinkRow has no count, no 「件」 and no number formatter", () => {
    expect(row).not.toMatch(/\bcount\b/);
    expect(row).not.toContain("件");
    expect(row).not.toContain("NumberFormatter");
    expect(row).toContain('Text("›")');
  });

  it("the list's model keeps no delivered or cancelled count, and the reader does not read one", () => {
    const model = ios("Screens/Parcels/ParcelListModel.swift");
    expect(model).not.toMatch(/deliveredCount|cancelledCount|addToDelivered/);
    const reader = ios("Data/ParcelReader.swift");
    expect(reader).not.toMatch(/statusCount|delivered:|cancelled:/);
    expect(reader).toMatch(/struct ParcelCounts[^{]*\{\s*var unread: LoadResult<Int>\s*\}/);
  });

  it("negative control: the detector sees a count put back on a link", () => {
    expect(list.replace('PageLinkRow(label: "受け取り済み") {', 'PageLinkRow(label: "受け取り済み", count: model.n) {')).toMatch(COUNT_ON_LINK);
    expect(calendar.replace('PageLinkRow(label: "受け取り済み")', 'PageLinkRow(label: "受け取り済み", count: nil)')).toMatch(COUNT_ON_LINK);
    expect(`${list}\nvar deliveredCount: Int? { nil }`).toMatch(COUNT_ON_LINK);
  });
});

describe("the opened pages show the number by the heading, as the Web does", () => {
  it("both pages hand the model's count to the heading", () => {
    expect(ios("Screens/Delivered/DeliveredView.swift")).toContain("StatusPageHeading(title: DeliveredModel.title, count: model.count");
    expect(ios("Screens/Cancelled/CancelledView.swift")).toContain("StatusPageHeading(title: CancelledModel.title, count: model.count");
  });

  it("the heading draws the number beside the title, grouped as ja-JP", () => {
    const view = ios("Screens/Delivered/DeliveredView.swift");
    expect(view).toMatch(/if let count \{\s*Text\(StatusPageText\.number\(count\)\)/);
    expect(view).toContain('f.locale = Locale(identifier: "ja_JP")');
    expect(view).toContain("f.usesGroupingSeparator = true");
  });

  it("the Web draws the same number in the same way", () => {
    expect(read("src/app/app/delivered/filter-form.tsx")).toContain('{count.toLocaleString("ja-JP")}');
    expect(read("src/app/app/cancelled/page.tsx")).toContain("{parcels.length.toLocaleString(\"ja-JP\")}");
  });
});
