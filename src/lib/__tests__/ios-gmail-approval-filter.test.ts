import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GMAIL_FILTER } from "@/lib/forwarding-guide";

/**
 * The Gmail approval card of 「メールの転送」 carries the filter text and its copy button (the same as the Web's ApprovalFilterCopy). The sentence above the box is one constant (GmailApprovalText.filterNote); the box is
 * the same part as under the Gmail card's filter step (step 5) (GmailFilterBox: the text from SettingsModel.gmailFilter + CopyButton).
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const DIR = "ios/Otodoke/Screens/Settings";
const ROWS = stripComments(read(`${DIR}/SettingsStatusRows.swift`));
const GUIDE = stripComments(read(`${DIR}/ForwardingGuideView.swift`));
/** The Web's sentence, read from ApprovalFilterCopy itself. */
const WEB_STEPS = read("src/components/forwarding-steps.tsx");
const NOTE = WEB_STEPS.slice(WEB_STEPS.indexOf("export function ApprovalFilterCopy")).match(/<p className="[^"]*">([^<]+)<\/p>/)?.[1] ?? "";

/** The text of the block opened by the first "{" at or after `from` (braces balanced). */
function braceBlock(src: string, from: number): string {
  if (from < 0) return "";
  const open = src.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}
/** Only the permission-checked, Google-checked pending branch, never the surrounding section. */
function pendingBranch(src: string): string {
  const at = src.indexOf("var approvalSection");
  const section = braceBlock(src, at);
  const pending = section.indexOf("if model.mayShowReadingAddress, let url = model.confirmURL, SettingsModel.isApprovalPage(url)");
  return braceBlock(section, pending);
}
const copyBoxInPendingBranch = (src: string) => /GmailFilterBox\(\)/.test(pendingBranch(src)) && pendingBranch(src).includes("GmailApprovalText.filterNote");

describe("Gmail approval card: filter text and copy button", () => {
  it("the sentence is held once, in GmailApprovalText, and is the owner's words", () => {
    const text = read(`${DIR}/GmailApprovalText.swift`);
    expect(text.match(/static let filterNote = "([^"]+)"/)?.[1]).toBe(NOTE);
    // Negative control: the Web's sentence was found, and a changed iOS word would not match it.
    expect(NOTE.length).toBeGreaterThan(20);
    expect(text.replace("「含む」", "『含む』").match(/static let filterNote = "([^"]+)"/)?.[1]).not.toBe(NOTE);
    // Same order as the Web's ApprovalFilterCopy: the sentence, then the shared box (GmailFilterCopy).
    const webCard = WEB_STEPS.slice(WEB_STEPS.indexOf("export function ApprovalFilterCopy"));
    expect(webCard.indexOf(NOTE)).toBeGreaterThan(0);
    expect(webCard.indexOf("<GmailFilterCopy />")).toBeGreaterThan(webCard.indexOf(NOTE));
    expect(ROWS.indexOf("GmailFilterBox()")).toBeGreaterThan(ROWS.indexOf("GmailApprovalText.filterNote"));
    expect(ROWS).not.toContain("フィルタをまだ");
    expect(GUIDE).not.toContain("フィルタをまだ");
  });

  it("the box is the shared part: the text is SettingsModel.gmailFilter (= the Web's GMAIL_FILTER) with the CopyButton", () => {
    const box = braceBlock(GUIDE, GUIDE.indexOf("struct GmailFilterBox"));
    expect(box).toMatch(/Text\(SettingsModel\.gmailFilter\)/);
    expect(box).toMatch(/CopyButton\(text: SettingsModel\.gmailFilter\)/);
    expect(read(`${DIR}/SettingsModel.swift`).match(/static let gmailFilter = "([^"]+)"/)?.[1]).toBe(GMAIL_FILTER);
    // The Gmail card's step 7 uses the same part (no second copy of the box).
    expect(GUIDE).toMatch(/AnyView\(GmailFilterBox\(\)\)/);
    expect(GUIDE.match(/CopyButton\(text: SettingsModel\.gmailFilter\)/g)).toHaveLength(1);
  });

  it("the card shows the sentence and the box, under the button that opens the approval page, only while an approval is pending", () => {
    const branch = pendingBranch(ROWS);
    expect(branch).not.toBe("");
    const button = branch.indexOf('primaryButton("承認ページを開く")');
    const note = branch.indexOf("GmailApprovalText.filterNote");
    const box = branch.indexOf("GmailFilterBox()");
    expect(button).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(button);
    expect(box).toBeGreaterThan(note);
    // Once in the whole file, and the failure branch (approvalNote) has none.
    expect(ROWS.match(/GmailFilterBox\(\)/g)).toHaveLength(1);
    expect(ROWS.match(/GmailApprovalText\.filterNote/g)).toHaveLength(1);
    expect(copyBoxInPendingBranch(ROWS)).toBe(true);
  });

  it("negative control: a box outside the pending branch, or a missing one, is caught", () => {
    const outside = ROWS.replace("GmailFilterBox()", "EmptyView()").replace("} else if let note = model.approvalNote {", "} else if let note = model.approvalNote {\n GmailFilterBox()");
    expect(outside).not.toBe(ROWS);
    expect(copyBoxInPendingBranch(outside)).toBe(false);
    expect(copyBoxInPendingBranch(ROWS.replace("GmailFilterBox()", "EmptyView()"))).toBe(false);
    expect(copyBoxInPendingBranch(ROWS.replace("GmailApprovalText.filterNote", "\"\""))).toBe(false);
    expect(copyBoxInPendingBranch(ROWS.replace("if model.mayShowReadingAddress, let url", "if let url"))).toBe(false);
    expect(copyBoxInPendingBranch(ROWS.replace(", SettingsModel.isApprovalPage(url)", ""))).toBe(false);
    expect(pendingBranch(ROWS.replace("var approvalSection", "var otherSection"))).toBe("");
  });
});
