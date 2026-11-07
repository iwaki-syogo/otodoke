import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BEFORE_YOU_START,
  BEFORE_YOU_START_ACTION,
  BEFORE_YOU_START_HEADING,
  FORWARDING_CHECK,
  FORWARDING_CHECK_ACTION,
  FORWARDING_GUIDES,
  FORWARDING_LEAD,
  FORWARDING_LEAD_NOTE,
  FORWARDING_PITFALLS,
  FORWARDING_TITLE,
  GMAIL_FILTER,
  PITFALLS_HEADING,
  PITFALLS_LEAD,
  VIDEO_CREDIT,
  VIDEO_LABEL,
} from "../forwarding-guide";

/**
 * The iOS forwarding guide (ios/Otodoke/Screens/Settings/ForwardingGuideText.swift and DeliveryHelpText.swift) holds
 * the same sentences as the Web: src/lib/forwarding-guide.ts is the one copy of the words. Nothing outside this repo is read.
 *
 * The Web draws the pitfall numbers (1. 2. 3.) and the step numbers itself; iOS draws them in its views too, so the
 * numbers are not in the data and not in the Swift literals. The Web's chip labels have no place on iOS.
 * BEFORE_YOU_START_ACTION (「転送先アドレスを開く」) is left out on purpose: the Web's button jumps from the guide page to
 * the settings' address, while iOS draws the guide on the same 「メールの転送」 page that holds the address, so there
 * is nowhere to go. FORWARDING_CHECK_ACTION (「「うまく届かないとき」を開く」) is on iOS: a link to that page.
 *
 * The explainer videos are on iOS too (ForwardingGuide.video, VIDEO_LABEL, VIDEO_CREDIT): a row under each service's
 * time that opens the video in Safari (nothing is played in the app), and the credit once at the end, always. Their paths and
 * seconds are compared below, and so is the rounding of the length (the Web's own two lines are run).
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const TEXT = "ios/Otodoke/Screens/Settings/ForwardingGuideText.swift";
const HELP = "ios/Otodoke/Screens/Settings/DeliveryHelpText.swift";
const VIEWS = [
  "ios/Otodoke/Screens/Settings/ForwardingGuideView.swift",
  "ios/Otodoke/Screens/Settings/SettingsPages.swift",
];

/** Every string literal of a Swift file, in order (the guide text holds no escaped quote). */
const literals = (src: string) => [...stripComments(src).matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);
const IDS = /^(gmail|icloud|outlook|others)$/;
const iosTextLiterals = () => literals(read(TEXT)).filter((s) => !IDS.test(s));
const iosHelpLiterals = () => literals(read(HELP));

/** The Web draws a service's title alone and its addresses on a line of their own under it (C13); iOS does the same. */
const iosTitle = (g: { title: string; addresses?: string }) => (g.addresses ? [g.title, g.addresses] : [g.title]);

/** The text of the block opened by the first "{" at or after `from` (braces balanced). */
function braceBlock(src: string, from: number): string {
  const open = src.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}
/** The credit is in the body's VStack, not inside the `if !servicesOnly { ... }` blocks, so both forms draw it. */
function creditIsOutsideServicesOnly(view: string): boolean {
  const at = view.indexOf("Text(T.videoCredit)");
  if (at < 0) return false;
  let from = 0;
  for (;;) {
    const i = view.indexOf("if !servicesOnly", from);
    if (i < 0) return true;
    const block = braceBlock(view, i);
    const start = view.indexOf(block, i);
    if (at >= start && at < start + block.length) return false;
    from = i + 1;
  }
}
/** Inside serviceBody: the meta (time) row, then the video row, then the link, in that order. */
function videoRowSitsBetweenTimeAndLink(view: string): boolean {
  const start = view.indexOf("private func serviceBody");
  const body = braceBlock(view, start);
  const meta = body.indexOf("service.meta");
  const video = body.indexOf("service.video");
  const link = body.indexOf("service.link");
  return meta >= 0 && video > meta && link > video;
}

/** Every `static let <name> = "<literal>"`. */
function swiftConstants(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s*static let (\w+)(?:\s*:\s*\w+)?\s*=\s*"([^"\\]*)"/gm)) out.set(m[1], m[2]);
  return out;
}

/** What the iOS text file must hold, in the order of its source: every sentence of the Web data except the chips. */
function expectedGuideLiterals(): string[] {
  const out: string[] = [FORWARDING_TITLE, FORWARDING_LEAD, FORWARDING_LEAD_NOTE, BEFORE_YOU_START_HEADING, ...BEFORE_YOU_START];
  for (const g of FORWARDING_GUIDES) {
    out.push(...iosTitle(g));
    if (g.time) out.push(g.time);
    if (g.video) out.push(g.video.src);
    if (g.link) out.push(g.link.label, g.link.href);
    if (g.linkNote) out.push(g.linkNote);
    for (const group of g.groups) {
      if (group.heading) out.push(group.heading);
      for (const s of group.steps) out.push(s.text);
    }
    if (g.intro) out.push(g.intro);
    out.push(...g.notes);
  }
  out.push(FORWARDING_CHECK.heading, ...FORWARDING_CHECK.lines, FORWARDING_CHECK_ACTION, VIDEO_LABEL, VIDEO_CREDIT);
  return out;
}

/** What the iOS help file holds, in the order the Web draws a pitfall: body[0], label, steps, codes lead, codes, after, rest, links. */
function expectedHelpLiterals(): string[] {
  const out: string[] = [PITFALLS_HEADING, PITFALLS_LEAD];
  for (const p of FORWARDING_PITFALLS) {
    const [first, ...rest] = p.body;
    out.push(p.title);
    if (first) out.push(first);
    if (p.steps) {
      if (p.stepsLabel) out.push(p.stepsLabel);
      out.push(...p.steps);
    }
    if (p.codes) {
      if (p.codesLead) out.push(p.codesLead);
      out.push(...p.codes);
    }
    out.push(...(p.after ?? []), ...rest);
    for (const l of p.links ?? []) out.push(l.label, l.href);
  }
  return out;
}

describe("the iOS forwarding guide and the Web data (src/lib/forwarding-guide.ts)", () => {
  it("the Web data is the one that was checked: the four guides and the three pitfalls", () => {
    expect(FORWARDING_GUIDES.map((g) => g.id)).toEqual(["gmail", "icloud", "outlook", "other"]);
    expect(FORWARDING_PITFALLS).toHaveLength(3);
    expect(FORWARDING_GUIDES[0].groups.flatMap((g) => g.steps)).toHaveLength(9);
  });

  it("the guide text holds exactly the Web's sentences, word for word and in the Web's order", () => {
    // Sorted lists would hide a changed order; the lists are compared as they are.
    expect(iosTextLiterals()).toEqual(expectedGuideLiterals());
  });

  it("the help text holds exactly the Web's pitfalls, word for word and in the Web's order", () => {
    expect(iosHelpLiterals()).toEqual(expectedHelpLiterals());
  });

  it("Gmail: the steps run 1 to 9 through both groups and the filter text sits under the step that carries the copy box", () => {
    const gmail = FORWARDING_GUIDES[0];
    const steps = gmail.groups.flatMap((g) => g.steps);
    const copyAt = steps.findIndex((s) => s.copy === "gmailFilter") + 1;
    expect(copyAt).toBe(7);
    expect(read(TEXT)).toContain(`filterAfterStep: ${copyAt},`);
    // Only Gmail has a filter box.
    expect(read(TEXT).match(/filterAfterStep: \d+/g)).toHaveLength(1);
    const filter = read("ios/Otodoke/Screens/Settings/SettingsModel.swift").match(/static let gmailFilter = "([^"]+)"/)?.[1];
    expect(filter).toBe(GMAIL_FILTER);
  });

  it("each video row is the Web's: path and seconds per service, none for the others, drawn under the time and above the link", () => {
    const text = read(TEXT);
    const withVideo = FORWARDING_GUIDES.filter((g) => g.video).map((g) => g.id);
    expect(withVideo).toEqual(["gmail", "icloud", "outlook"]);
    const found = [...text.matchAll(/video: Video\(path: "([^"]+)", seconds: (\d+)\)/g)].map((m) => ({ src: m[1], seconds: Number(m[2]) }));
    expect(found).toEqual(FORWARDING_GUIDES.flatMap((g) => (g.video ? [{ src: g.video.src, seconds: g.video.seconds }] : [])));
    expect(text.match(/video: nil,/g)).toHaveLength(FORWARDING_GUIDES.length - withVideo.length);
    for (const g of FORWARDING_GUIDES) if (g.video) expect(existsSync(path.join(ROOT, "public", g.video.src)), g.video.src).toBe(true);
    expect(swiftConstants(stripComments(text)).get("videoLabel")).toBe(VIDEO_LABEL);
    expect(swiftConstants(stripComments(text)).get("videoCredit")).toBe(VIDEO_CREDIT);
    // Position in the view, by structure (see `structure` below).
    const view = stripComments(read(VIEWS[0]));
    expect(creditIsOutsideServicesOnly(view)).toBe(true);
    expect(videoRowSitsBetweenTimeAndLink(view)).toBe(true);
    // The credit is drawn once and always (the Web shows it under the cards and at the end of /guide/forwarding).
    expect(view.match(/Text\(T\.videoCredit\)/g)).toHaveLength(1);
    expect(view).not.toMatch(/showsCredit/);
    expect(stripComments(read("ios/Otodoke/Screens/Settings/ForwardingGuideVideo.swift"))).not.toMatch(/showsCredit/);
    // The video row's hint is a fixed sentence, set on the row only.
    expect(swiftConstants(stripComments(read("ios/Otodoke/Screens/Settings/ForwardingGuideVideo.swift"))).get("openHint")).toBe("Safari で動画を開きます");
    expect(view.match(/\.accessibilityHint\(ForwardingGuideVideo\.openHint\)/g)).toHaveLength(1);
    // Opened in Safari through the https-only opener; no player is added.
    expect(view).toMatch(/ForwardingGuideVideo\.url\(path: video\.path\)[\s\S]*SettingsWeb\.openPage\(url, openURL\)/);
    expect(view).not.toMatch(/AVKit|VideoPlayer|AVPlayer/);
    expect(read("ios/project.yml")).not.toMatch(/AVKit/);
  });

  /** The Web's two lines (GuideVideo in src/components/forwarding-steps.tsx), run as they are. */
  function webMinutes(seconds: number): string {
    const src = read("src/components/forwarding-steps.tsx");
    const halvesLine = src.match(/const halves = (.+);/)?.[1];
    const minutesLine = src.match(/const minutes = (.+);/)?.[1];
    if (!halvesLine || !minutesLine) throw new Error("GuideVideo's rounding lines are not found");
    return new Function("video", `const halves = ${halvesLine}; return ${minutesLine};`)({ seconds }) as string;
  }

  it("the length is rounded as the Web does: 89, 90, 91, 131, 150 and the table the Swift test holds", () => {
    expect([89, 90, 91, 131, 150, 14, 45].map(webMinutes)).toEqual(["1 分半", "1 分半", "1 分半", "2 分", "2 分半", "半分", "1 分"]);
    const swiftTest = read("ios/OtodokeTests/ForwardingGuideVideoTests.swift");
    const table = swiftTest.slice(swiftTest.indexOf("WEB-TABLE-BEGIN"), swiftTest.indexOf("WEB-TABLE-END"));
    const rows = [...table.matchAll(/\((\d+), "([^"]+)"\)/g)].map((m) => ({ seconds: Number(m[1]), minutes: m[2] }));
    const seconds = rows.map((r) => r.seconds);
    for (const s of [89, 90, 91, 131, 150, ...FORWARDING_GUIDES.flatMap((g) => (g.video ? [g.video.seconds] : []))]) expect(seconds).toContain(s);
    for (const r of rows) expect(r.minutes, `${r.seconds} seconds`).toBe(webMinutes(r.seconds));
    // The Swift side computes it the same way: nearest half minute, at least half a minute.
    const impl = stripComments(read("ios/Otodoke/Screens/Settings/ForwardingGuideVideo.swift"));
    expect(impl).toContain("max(0.5, (Double(seconds) / 30).rounded(.toNearestOrAwayFromZero) / 2)");
    // The literals hold interpolations ("\\(...)"), so they are read with a pattern that allows a backslash.
    const words = [...impl.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((l) => /分|約/.test(l));
    expect(words).toEqual(["\\(Int(halves)) 分", "半分", "\\(Int(halves.rounded(.down))) 分半", "\\(ForwardingGuideText.videoLabel)・約 \\(minutes(seconds: seconds))"]);
  });

  it("negative control: a wrong row, a missing video and a changed length are caught", () => {
    expect(webMinutes(131)).not.toBe("2 分半");
    expect(webMinutes(150)).not.toBe("2 分");
    const text = read(TEXT);
    const found = (t: string) => [...t.matchAll(/video: Video\(path: "([^"]+)", seconds: (\d+)\)/g)].map((m) => ({ src: m[1], seconds: Number(m[2]) }));
    expect(found(text.replace("seconds: 131", "seconds: 130"))).not.toEqual(found(text));
    expect(found(text.replace(/video: Video\([^)]+\),/, "video: nil,"))).not.toEqual(found(text));
    // The structure checks catch the credit moved into the servicesOnly branch and the video row moved under the link.
    const viewSrc = stripComments(read(VIEWS[0]));
    const movedCredit = viewSrc.replace("if !servicesOnly {\n                verify", "if !servicesOnly {\n                Text(T.videoCredit)\n                verify");
    // A second copy of the credit (or none) is caught by the count above.
    expect(viewSrc.replace("verify\n            }", "verify\n                Text(T.videoCredit)\n            }").match(/Text\(T\.videoCredit\)/g)).toHaveLength(2);
    expect(viewSrc.replace("Text(T.videoCredit)", "EmptyView()").match(/Text\(T\.videoCredit\)/g)).toBeNull();
    expect(creditIsOutsideServicesOnly(viewSrc)).toBe(true);
    expect(creditIsOutsideServicesOnly(movedCredit)).toBe(false);
    const videoRow = /            if let video = service\.video \{[\s\S]*?\n            \}\n/.exec(viewSrc)?.[0] ?? "";
    expect(videoRow).not.toBe("");
    const movedVideo = viewSrc.replace(videoRow, "").replace("            if let body = service.body {", videoRow + "            if let body = service.body {");
    expect(videoRowSitsBetweenTimeAndLink(movedVideo)).toBe(false);
    const withoutVideos = literals(text.replace(/video: Video\(path: "[^"]+"/g, "video: Video(path: \"\"")).filter((s) => !IDS.test(s));
    expect(withoutVideos).not.toEqual(expectedGuideLiterals());
  });

  it("every link is https", () => {
    const urls = [...iosTextLiterals(), ...iosHelpLiterals()].filter((s) => /^https?:/.test(s));
    expect(urls).toHaveLength(5);
    for (const u of urls) expect(u.startsWith("https://"), u).toBe(true);
  });

  it("the Yamato domains are the Web's three", () => {
    expect(FORWARDING_PITFALLS[0].codes).toEqual(["@kuronekoyamato.co.jp", "@ml.kuronekoyamato.co.jp", "@ml2.kuronekoyamato.co.jp"]);
  });

  it("the button under 「設定できたか確かめる」 is the Web's FORWARDING_CHECK_ACTION and opens the 「うまく届かないとき」 page", () => {
    expect(FORWARDING_CHECK_ACTION).toBe("「うまく届かないとき」を開く");
    expect(swiftConstants(stripComments(read(TEXT))).get("checkAction")).toBe(FORWARDING_CHECK_ACTION);
    const view = stripComments(read(VIEWS[0]));
    expect(view).toMatch(/NavigationLink\(value: SettingsPage\.delivery\)\s*\{\s*Text\(T\.checkAction\)/);
    // BEFORE_YOU_START_ACTION is not on iOS.
    expect(iosTextLiterals()).not.toContain(BEFORE_YOU_START_ACTION);
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

  it("negative control: a changed word, a dropped sentence and a swapped order are all caught", () => {
    const expected = expectedGuideLiterals();
    const changed = iosTextLiterals().map((s) => s.replace("貼り付けます", "貼ります"));
    expect(changed).not.toEqual(expected);
    const dropped = iosTextLiterals().filter((s) => s !== "「保存」を押します。");
    expect(dropped).not.toEqual(expected);
    const swapped = [...iosHelpLiterals()];
    [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
    expect(swapped).not.toEqual(expectedHelpLiterals());
  });
});
