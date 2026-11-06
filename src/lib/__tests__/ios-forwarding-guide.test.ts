import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The iOS forwarding guide (ios/Otodoke/Screens/Settings/ForwardingGuideText.swift and DeliveryHelpText.swift) is
 * the source of the sentences' wording, sentence for sentence: docs/ux-redo/forwarding-guide.md of
 * built-with-claude-japan-2026.
 *
 * TEMPORARY: the Web will hold the same sentences in src/lib/forwarding-guide.ts (not in dev yet). When it is in,
 * point SOURCE at that file's text (or compare both) instead of the markdown.
 */

const ROOT = path.resolve(__dirname, "../../..");
const SOURCE =
  process.env.OTODOKE_FORWARDING_GUIDE_MD ??
  path.join(os.homedir(), "プロジェクト/その他/built-with-claude-japan-2026/docs/ux-redo/forwarding-guide.md");
const haveSource = existsSync(SOURCE);
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const FILES = [
  "ios/Otodoke/Screens/Settings/ForwardingGuideText.swift",
  "ios/Otodoke/Screens/Settings/DeliveryHelpText.swift",
];
const VIEWS = [
  "ios/Otodoke/Screens/Settings/ForwardingGuideView.swift",
  "ios/Otodoke/Screens/Settings/SettingsPages.swift",
];

/** The markdown as plain text: no code ticks, no bold marks, and nothing after the video-script section. */
const plainSource = () =>
  readFileSync(SOURCE, "utf8")
    .split("## 動画の台本の材料")[0]
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/（画面ではこの下にコピー欄）/g, "");

/** Every string literal of a Swift file (the guide text holds no escaped quote). */
const literals = (src: string) => [...stripComments(src).matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);

/** Headings of the source that only organise the file. */
const NOT_DRAWN = new Set(["ページの題と最初の一文"]);

/** What must be on the screen: the bullets, numbered lines and headings of the source, without their labels. */
function sourceSentences(md: string): string[] {
  const out: string[] = [];
  for (const raw of md.split("\n")) {
    if (!/^\s*(#{2,3} |\d+\. |- )/.test(raw)) continue;
    let line = raw.replace(/^\s*(#{2,3} |\d+\. |- )/, "").replace(/^\d+\. /, "");
    line = line.replace(/^(目安|注記|題|一文|補足（小さく）|直リンク|リンク|確かめ方): ?/, "").trim();
    if (!line || /^`?\{/.test(line)) continue;
    for (const part of line.split(/\s*→\s*/)) if (part) out.push(part);
  }
  // Headings that only name the source file or the pages' structure are not drawn.
  return out.filter((s) => !NOT_DRAWN.has(s));
}

describe.skipIf(!haveSource)("the iOS forwarding guide and the sentences' source", () => {
  it("the source is the one that was checked: the three services and the three pitfalls are in it", () => {
    const md = plainSource();
    for (const word of ["## Gmail", "## iCloud メール", "## Outlook", "## そのほかのメール", "### 1. ヤマト運輸", "### 2. ショップ", "### 3. 荷物のメール"]) {
      expect(md).toContain(word);
    }
  });

  it("every sentence the iOS texts hold is in the source, word for word", () => {
    const md = plainSource();
    for (const file of FILES) {
      const found = literals(read(file));
      expect(found.length, `${file} holds literals`).toBeGreaterThan(10);
      for (const text of found) {
        if (/^(gmail|icloud|outlook|others)$/.test(text)) continue; // ids
        expect(md, `${file}: 「${text}」`).toContain(text);
      }
    }
  });

  it("every sentence of the source (steps, notes, links, headings) is on the iOS side", () => {
    const ios = FILES.map((f) => literals(read(f)).join("\n")).join("\n");
    const sentences = sourceSentences(plainSource());
    expect(sentences.length).toBeGreaterThan(40);
    for (const s of sentences) {
      // The steps of the three source lists are written once each; the filter text is SettingsModel.gmailFilter.
      expect(ios, `missing on iOS: 「${s}」`).toContain(s);
    }
  });

  it("the three domains and the Gmail filter text are the source's", () => {
    const md = plainSource();
    for (const d of ["@kuronekoyamato.co.jp", "@ml.kuronekoyamato.co.jp", "@ml2.kuronekoyamato.co.jp"]) expect(md).toContain(d);
    const filter = read("ios/Otodoke/Screens/Settings/SettingsModel.swift").match(/static let gmailFilter = "([^"]+)"/)?.[1];
    expect(filter).toBeTruthy();
    expect(md).toContain(filter!);
  });

  it("every link is https and is one the source lists", () => {
    const md = plainSource();
    const urls = FILES.flatMap((f) => literals(read(f))).filter((s) => /^https?:/.test(s));
    expect(urls.length).toBe(5);
    for (const u of urls) {
      expect(u.startsWith("https://"), u).toBe(true);
      expect(md, u).toContain(u);
    }
  });

  it("the views draw no Japanese literal of their own about the guide (the words come from the text files)", () => {
    const J = /[぀-ヿ㐀-鿿]/;
    const guide = stripComments(read(VIEWS[0]));
    // The copy button's two words are the only ones the view file keeps (they are the Web's CopyButton).
    const own = literals(guide).filter((s) => J.test(s));
    expect(own.sort()).toEqual(["コピー", "コピーしました"].sort());
    const pages = stripComments(read(VIEWS[1]));
    const delivery = pages.slice(pages.indexOf("struct SettingsDeliveryHelpPage"), pages.indexOf("struct SettingsSamplePage"));
    expect(literals(delivery).filter((s) => J.test(s))).toEqual(["確かめ方:"]);
  });

  it("negative control: a changed word and a sentence missing from iOS are both caught", () => {
    const md = plainSource();
    expect(md).not.toContain("転送を有効にするをオンにし");
    const changed = literals(read(FILES[0])).map((s) => s.replace("貼り付けます", "貼ります"));
    expect(changed.some((s) => !md.includes(s))).toBe(true);
    const ios = literals(read(FILES[0])).join("\n").replace("「保存」を押します。", "");
    expect(sourceSentences(md).some((s) => !ios.includes(s))).toBe(true);
  });
});
