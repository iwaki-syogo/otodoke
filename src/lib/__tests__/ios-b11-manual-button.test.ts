import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 1.0 (11): the black button of the manual form was cut flat at the top and bottom. A Form row clips its content
 * to the row's own shape, so a button that draws its own black as the content is cut; the black is the row's
 * background instead.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const FORM = stripComments(read("ios/Otodoke/Screens/Parcels/ManualParcelView.swift"));

const problems = (src: string) => {
  const button = src.match(/private var submitButton: some View \{[\s\S]*?\n    \}\n/)?.[0] ?? "";
  const out: string[] = [];
  if (!button) out.push("unreadable");
  if (/\.background\(Color\.primary/.test(button)) out.push("the button draws its own black");
  if (!/\.listRowBackground\(RoundedRectangle\(cornerRadius: 12\)\.fill\(Color\.primary\)/.test(src)) out.push("the row has no black background");
  if (!/\.listRowBackground\(RoundedRectangle[^\n]*\n\s*\.listRowInsets\(EdgeInsets\(\)\)/.test(src)) out.push("the row keeps its insets, so the ends of the band do not press");
  if (!/\.frame\(maxWidth: \.infinity\)[\s\S]*?\.contentShape\(Rectangle\(\)\)/.test(button)) out.push("the label does not fill the row");
  return out;
};

describe("the black button of the manual form is not cut flat by its list row", () => {
  it("the black is the row background", () => {
    expect(problems(FORM)).toEqual([]);
  });

  it("negative control: the old shape, a different row background and an unreadable file are caught", () => {
    const old = FORM.replace(".padding(.vertical, 24)\n            .contentShape(Rectangle())", ".background(Color.primary, in: RoundedRectangle(cornerRadius: 12))");
    expect(old).not.toBe(FORM);
    expect(problems(old)).toContain("the button draws its own black");
    const capsule = FORM.replace(".listRowBackground(RoundedRectangle", ".listRowBackground(Capsule");
    expect(capsule).not.toBe(FORM);
    expect(problems(capsule)).toContain("the row has no black background");
    const noInset = FORM.replace(/(\.listRowBackground\(RoundedRectangle[^\n]*)\n\s*\.listRowInsets\(EdgeInsets\(\)\)/, "$1");
    expect(noInset).not.toBe(FORM);
    expect(problems(noInset)).toContain("the row keeps its insets, so the ends of the band do not press");
    const narrow = FORM.replace(/\.frame\(maxWidth: \.infinity\)(?=\s*\.padding\(\.vertical, 24\))/, "");
    expect(narrow).not.toBe(FORM);
    expect(problems(narrow)).toContain("the label does not fill the row");
    expect(problems("")).toContain("unreadable");
  });
});
