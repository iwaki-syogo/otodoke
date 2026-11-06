import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BEFORE_YOU_START,
  BEFORE_YOU_START_HEADING,
  FORWARDING_CHECK,
  FORWARDING_GUIDES,
  FORWARDING_LEAD,
  FORWARDING_LEAD_NOTE,
  FORWARDING_PITFALLS,
  FORWARDING_TITLE,
  GMAIL_FILTER,
  PITFALLS_HEADING,
  PITFALLS_LEAD,
} from "../forwarding-guide";

/**
 * The iOS forwarding guide (ios/Otodoke/Screens/Settings/ForwardingGuideText.swift and DeliveryHelpText.swift) holds
 * the same sentences as the Web: src/lib/forwarding-guide.ts is the one copy of the words. Nothing outside this repo is read.
 *
 * The Web draws the pitfall numbers (1. 2. 3.) and the step numbers itself; iOS draws them in its views too, so the
 * numbers are not in the data and not in the Swift literals. The Web's chip labels and the button to the settings
 * (FORWARDING_CHECK_ACTION) have no place on iOS.
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

/** The title iOS shows for a service: the Web's title and, in full-width brackets, its addresses. */
const iosTitle = (g: { title: string; addresses?: string }) => (g.addresses ? `${g.title}（${g.addresses}）` : g.title);

/** What the iOS text file must hold, in the order of its source: every sentence of the Web data except the chips. */
function expectedGuideLiterals(): string[] {
  const out: string[] = [FORWARDING_TITLE, FORWARDING_LEAD, FORWARDING_LEAD_NOTE, BEFORE_YOU_START_HEADING, ...BEFORE_YOU_START];
  for (const g of FORWARDING_GUIDES) {
    out.push(iosTitle(g));
    if (g.time) out.push(g.time);
    if (g.link) out.push(g.link.label, g.link.href);
    if (g.linkNote) out.push(g.linkNote);
    for (const group of g.groups) {
      if (group.heading) out.push(group.heading);
      for (const s of group.steps) out.push(s.text);
    }
    if (g.intro) out.push(g.intro);
    out.push(...g.notes);
  }
  out.push(FORWARDING_CHECK.heading, ...FORWARDING_CHECK.lines);
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

  it("every link is https", () => {
    const urls = [...iosTextLiterals(), ...iosHelpLiterals()].filter((s) => /^https?:/.test(s));
    expect(urls).toHaveLength(5);
    for (const u of urls) expect(u.startsWith("https://"), u).toBe(true);
  });

  it("the Yamato domains are the Web's three", () => {
    expect(FORWARDING_PITFALLS[0].codes).toEqual(["@kuronekoyamato.co.jp", "@ml.kuronekoyamato.co.jp", "@ml2.kuronekoyamato.co.jp"]);
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
