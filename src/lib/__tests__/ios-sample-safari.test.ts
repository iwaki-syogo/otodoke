import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「サンプルで試す」 stays in the app: the page no longer says that it opens the browser, and neither button opens a Web
 * page (the sample load and clear-everything go through DemoModel). A body that cannot be cut out is a failure, not a pass.
 * (The file keeps its first name; it used to check the opposite.)
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const OLD_SENTENCE = "どちらもブラウザで Web 版を開きます。";
const OLD_SAFARI = `どちらも ${"Safari"} の Web 版で開きます。`;

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
function problems(src: string, panel: string): string[] {
  const body = sampleBody(stripComments(src));
  if (!body) return ["body not found"];
  const out: string[] = [];
  if (body.includes(OLD_SENTENCE) || body.includes(OLD_SAFARI)) out.push("says it opens the browser");
  if (/Safari|openURL|SettingsWeb|WebLink/.test(body)) out.push("opens the Web");
  if (!/SettingsDemoPanel\(model: demo/.test(body)) out.push("panel missing");
  if (!/secondaryText\(DemoText\.lead\)/.test(body)) out.push("lead missing");
  const ui = stripComments(panel);
  if (!ui) out.push("panel file not found");
  if (/openURL|SettingsWeb|WebLink|Safari/.test(ui)) out.push("panel opens the Web");
  if (!/model\.load\(\)/.test(ui) || !/model\.clear\(confirmed:/.test(ui)) out.push("buttons do not call the model");
  return out;
}

describe("「サンプルで試す」: stays in the app", () => {
  const IOS = read("ios/Otodoke/Screens/Settings/SettingsPages.swift");
  const PANEL = read("ios/Otodoke/Screens/Settings/SettingsDemoPanel.swift");

  it("no sentence about the browser, no Web link, and the buttons call the model", () => {
    expect(problems(IOS, PANEL)).toEqual([]);
  });

  it("negative control: the old sentence, a Web link, a missing panel or no body is caught", () => {
    expect(problems(IOS.replace("SettingsParts.secondaryText(DemoText.lead)", `SettingsParts.secondaryText("${OLD_SENTENCE}")`), PANEL)).toContain("says it opens the browser");
    expect(problems(IOS.replace("SettingsParts.secondaryText(DemoText.lead)", "SettingsParts.secondaryText(DemoText.lead)\n            let u = WebLink.settingsDemo"), PANEL)).toContain("opens the Web");
    expect(problems(IOS.replace("SettingsDemoPanel(model: demo", "Other(model: demo"), PANEL)).toContain("panel missing");
    expect(problems(IOS, PANEL.replace("model.load()", "openURL(WebLink.settingsDemo)"))).toEqual(expect.arrayContaining(["panel opens the Web", "buttons do not call the model"]));
    expect(problems(IOS, "")).toContain("panel file not found");
    expect(problems(IOS.replace("struct SettingsSamplePage", "struct Other"), PANEL)).toEqual(["body not found"]);
  });

  it("the settings model no longer lists the two Web actions", () => {
    const model = read("ios/Otodoke/Screens/Settings/SettingsModel.swift");
    expect(model).not.toMatch(/case sample\b|case clearAll\b/);
    expect(model).toMatch(/var demo: DemoModel\?/);
  });
});
