import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「サンプルで試す」: both buttons open the Web version in the browser (SettingsWeb.open), so the page says so, above the
 * buttons. This line is iOS-only (the Web has no such sentence). A body that cannot be cut out is a failure, not a pass.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const SENTENCE = "どちらもブラウザで Web 版を開きます。";
// The previous wording, built in pieces so that no source line carries the old phrase.
const OLD_SENTENCE = `どちらも ${"Safari"} の Web 版で開きます。`;
const LOAD = "サンプルのメールを読み込む";
const CLEAR = "すべての荷物を消す";

function sampleBody(src: string): string {
  const at = src.indexOf("struct SettingsSamplePage");
  if (at < 0) return "";
  const open = src.indexOf("SettingsParts.page(", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = src.indexOf("{", open); i >= 0 && i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

/** Names the failures; empty means the page is as intended. */
function problems(src: string): string[] {
  const body = sampleBody(stripComments(src));
  if (!body) return ["body not found"];
  const out: string[] = [];
  const s = body.indexOf(`secondaryText("${SENTENCE}")`);
  const load = body.indexOf(LOAD);
  const clear = body.indexOf(CLEAR);
  if (s < 0) out.push("sentence missing");
  if (load < 0 || clear < 0) out.push("button missing");
  if (s >= 0 && load >= 0 && clear >= 0 && !(s < load && s < clear)) out.push("sentence after a button");
  if (/Safari/.test(body)) out.push("mentions Safari");
  if (!/primaryButton\("サンプルのメールを読み込む"[^\n]*SettingsWeb\.open\(\.sample\b/.test(body)) out.push("load button does not open the browser");
  if (!/Button \{ SettingsWeb\.open\(\.clearAll\b[\s\S]*?すべての荷物を消す/.test(body)) out.push("clear button does not open the browser");
  return out;
}

describe("「サンプルで試す」: says that the buttons open the browser", () => {
  const IOS = read("ios/Otodoke/Screens/Settings/SettingsPages.swift");

  it("the sentence is there, above both buttons, and the buttons open the browser", () => {
    expect(problems(IOS)).toEqual([]);
  });

  it("negative control: no sentence, a sentence after the buttons, a button that no longer opens the browser, or no body, is caught", () => {
    expect(problems(IOS.replace(`SettingsParts.secondaryText("${SENTENCE}")`, ""))).toContain("sentence missing");
    const line = `            SettingsParts.secondaryText("${SENTENCE}")\n`;
    const moved = IOS.replace(line, "").replace("        }\n        .navigationTitle(SettingsMenuText.sampleTitle)", `${line}        }\n        .navigationTitle(SettingsMenuText.sampleTitle)`);
    expect(problems(moved)).toContain("sentence after a button");
    expect(problems(IOS.replace("SettingsWeb.open(.sample, openURL)", "doSomething()"))).toContain("load button does not open the browser");
    expect(problems(IOS.replace("SettingsWeb.open(.clearAll, openURL)", "doSomething()"))).toContain("clear button does not open the browser");
    expect(problems(IOS.replace(SENTENCE, OLD_SENTENCE))).toContain("sentence missing");
    expect(problems(IOS.replace(SENTENCE, OLD_SENTENCE))).toContain("mentions Safari");
    expect(problems(IOS.replace("struct SettingsSamplePage", "struct Other"))).toEqual(["body not found"]);
  });
});
