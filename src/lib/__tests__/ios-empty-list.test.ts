import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS empty list] The empty parcel list shows one of three guides, as the Web's EMPTY_GUIDE
 * (src/app/app/page.tsx) does: the two sentences and the first button's words are compared with page.tsx, character
 * for character; the button's destination is the iOS screen that is the same page as the Web's href; the view holds
 * none of those words as literals and keeps the sample button as it was. A negative control shows the comparison
 * fails when a word differs.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

type Guide = { lines: [string, string]; button: string; href: string };

/** The three entries of EMPTY_GUIDE, read from the Web's source. */
function webGuides(src: string): Record<"none" | "received" | "approval", Guide> {
  const out: Partial<Record<"none" | "received" | "approval", Guide>> = {};
  for (const m of src.matchAll(/^\s*(none|received|approval): \{ lines: \["([^"]+)", "([^"]+)"\], button: "([^"]+)", href: "([^"]+)" \}/gm)) {
    out[m[1] as "none"] = { lines: [m[2], m[3]], button: m[4], href: m[5] };
  }
  expect(Object.keys(out).sort()).toEqual(["approval", "none", "received"]);
  return out as Record<"none" | "received" | "approval", Guide>;
}

/** Every `static let <name> = "<literal>"` of a Swift text. */
function swiftConstants(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s*static let (\w+)\s*=\s*"([^"\\]*)"/gm)) out.set(m[1], m[2]);
  return out;
}

/** The names Swift gives each Web value; what differs between the Web and a Swift text, as a list. */
function differences(web: ReturnType<typeof webGuides>, swift: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const kind of ["none", "received", "approval"] as const) {
    const want: Record<string, string> = { [`${kind}First`]: web[kind].lines[0], [`${kind}Second`]: web[kind].lines[1], [`${kind}Button`]: web[kind].button };
    for (const [name, text] of Object.entries(want)) if (swift.get(name) !== text) diffs.push(`${name}: ${swift.get(name)} != ${text}`);
  }
  return diffs;
}

const page = read("src/app/app/page.tsx");
const text = read("ios/Otodoke/Screens/Parcels/ParcelEmptyText.swift");
const view = stripComments(read("ios/Otodoke/Screens/Parcels/ParcelListView.swift"));

describe("the empty list's three guides", () => {
  const web = webGuides(page);

  it("the Web's guides are the ones this test expects (so the comparison below is not against nothing)", () => {
    expect(web.none.lines[0]).toBe("メールの自動転送を設定しますか？");
    expect(web.received.button).toBe("設定を見る");
    expect(web.approval.href).toBe("/app/settings/forwarding#gmail-approval");
  });

  it("every sentence and button word is the Web's", () => {
    const swift = swiftConstants(stripComments(text));
    expect(differences(web, swift)).toEqual([]);
    // Nine words, no more: a constant without a Web sentence would be an invented one.
    expect([...swift.keys()].sort()).toEqual(
      ["approvalButton", "approvalFirst", "approvalSecond", "noneButton", "noneFirst", "noneSecond", "receivedButton", "receivedFirst", "receivedSecond"],
    );
  });

  it("negative control: a changed word is reported", () => {
    const swift = swiftConstants(stripComments(text));
    swift.set("receivedSecond", "荷物のメールが届くまで、お待ちください");
    swift.delete("approvalButton");
    expect(differences(web, swift)).toHaveLength(2);
  });

  it("each button goes to the iOS screen of the Web's page", () => {
    const body = stripComments(text);
    const mapping: Record<string, string> = {
      "/app/settings/forwarding": "forwarding",
      "/app/settings/forwarding#gmail-approval": "forwarding",
      "/app/settings/trouble": "trouble",
    };
    for (const kind of ["none", "received", "approval"] as const) {
      const dest = mapping[web[kind].href];
      expect(dest, web[kind].href).toBeDefined();
      expect(body).toMatch(new RegExp(`case \\.${kind}: EmptyGuide\\(first: ${kind}First, second: ${kind}Second, button: ${kind}Button, destination: \\.${dest}\\)`));
    }
  });

  it("the view reads the constants: no word of the guides, nor the old sentence, as a literal", () => {
    for (const g of Object.values(web)) for (const w of [...g.lines, g.button]) expect(view, w).not.toContain(w);
    for (const old of ["転送用アドレスに送ると", "転送先を確認してください", "転送先を見る"]) expect(view, old).not.toContain(old);
    expect(view).toMatch(/Text\(verbatim: "\\\(guide\.first\)\\n\\\(guide\.second\)"\)/);
    expect(view).toMatch(/Text\(guide\.button\)/);
  });

  it("the sample button is as it was, and opens the in-app 「サンプルで試す」 page", () => {
    expect(view).toMatch(/Text\("サンプルで試す"\)/);
    expect(view).toMatch(/openDemo: \{ \(openSample \?\? openSettings\)\(\) \}/);
    expect(view).not.toContain("WebLink.settingsDemo");
    expect(stripComments(read("ios/Otodoke/Screens/MainTabView.swift"))).toMatch(/openSample:\s*\{\s*route\.showSample\(\)\s*\}/);
    expect(page).toContain("サンプルで試す");
  });

  it("the tabs open 「うまく届かないとき」 for the trouble page and 「メールの転送」 for the forwarding page", () => {
    const tabs = stripComments(read("ios/Otodoke/Screens/MainTabView.swift"));
    expect(tabs).toMatch(/openTrouble:\s*\{\s*route\.showTrouble\(\)\s*\}/);
    expect(tabs).toMatch(/mutating func showTrouble\(\)\s*\{\s*settingsPath = \[\.delivery\]/);
    expect(tabs).toMatch(/mutating func showForwarding\(\)\s*\{\s*settingsPath = \[\.forward\]/);
    expect(view).toMatch(/case \.trouble: \(openTrouble \?\? openSettings\)\(\)/);
    expect(view).toMatch(/case \.forwarding: \(openForwarding \?\? openSettings\)\(\)/);
  });
});

describe("the mail-so-far rule (SettingsReader.mailSoFar) follows the Web's readMailSoFar", () => {
  const swift = stripComments(read("ios/Otodoke/Data/SettingsReader.swift"));
  const web = stripComments(read("src/app/app/settings/settings-reads.ts"));

  it("same order: confirmation read, after-check when it has a link and a time, then the plain counts", () => {
    expect(web).toMatch(/if \(confirmation\.failed\) return null;[\s\S]*countArrivedAfter[\s\S]*later === null \|\| later <= 0 \? "approval" : "received"/);
    expect(swift).toMatch(/guard case let \.loaded\(rows\) = await forwardingConfirmations\(\) else \{ return nil \}/);
    expect(swift).toMatch(/guard case let \.loaded\(later\) = await arrivedAfter\(at\) else \{ return \.approval \}\s*return later <= 0 \? \.approval : \.received/);
    expect(web).toMatch(/forwarded > 0 \|\| \(screened\.count \?\? 0\) > 0\) return "received";\s*return \(confirmations\.count \?\? 0\) > 0 \? "approval" : "none"/);
    expect(swift).toMatch(/all - samples - confirmations > 0 \|\| screened > 0 \{ return \.received \}\s*return confirmations > 0 \? \.approval : MailSoFar\.none/);
  });

  it("the empty list reads it only for an empty list, and a failed read is none", () => {
    const model = stripComments(read("ios/Otodoke/Screens/Parcels/ParcelListModel.swift"));
    expect(model).toMatch(/if case let \.loaded\(fresh\) = readList, fresh\.isEmpty, let readMail \{ mail = await readMail\(\) \}/);
    // A failed read again keeps the guide shown; only a first failed read, or a list with parcels, is none.
    expect(model).toMatch(/if !fresh\.isEmpty \{\s*mailSoFar = \.none\s*mailKnown = false\s*\} else if let mail \{\s*mailSoFar = mail\s*mailKnown = true\s*\} else if !mailKnown \{\s*mailSoFar = \.none\s*\}/);
    expect(page).toContain('(await readMailSoFar(supabase, userId, "parcels page")) ?? "none"');
  });
});
