import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Encryption is done by the server by itself, so the app shows no card, no 「暗号化する」 button and no 「未暗号化 n 通」
 * badge, and does not count plain mail at all. A file that cannot be read is a failure, not a pass.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const S = "ios/Otodoke/Screens/Settings";
const FILES = [`${S}/SettingsKeyPage.swift`, `${S}/SettingsView.swift`, `${S}/SettingsMenuText.swift`, `${S}/SettingsModel.swift`, "ios/Otodoke/Data/SettingsReader.swift"];

/** What must not be in the app's settings code; empty means it is gone. */
function leftovers(sources: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const src = stripComments(text);
    if (!src) out.push(`${file}: not found`);
    if (/暗号化されていないメール|暗号化する/.test(src)) out.push(`${file}: the card or its button`);
    if (/未暗号化/.test(src) || /plainBadge/.test(src)) out.push(`${file}: the badge`);
    if (/plainCount|plainMailNote/.test(src)) out.push(`${file}: the count of plain mail`);
    if (/"body_state", value: "plain"/.test(src)) out.push(`${file}: a read of plain mail`);
  }
  return out;
}

describe("iOS settings: no encryption card, button, badge or count of plain mail", () => {
  const sources = Object.fromEntries(FILES.map((f) => [f, read(f)]));

  it("none of them is left", () => {
    expect(leftovers(sources)).toEqual([]);
  });

  it("the key page keeps its other cards: make the key, change the password, the earlier-key line, Face ID", () => {
    const key = stripComments(sources[`${S}/SettingsKeyPage.swift`]);
    expect(key).toContain('"鍵を作る"');
    expect(key).toContain('"パスワードを変える"');
    expect(key).toContain("model.oldKeyNote");
    expect(key).toContain("FaceIDToggleRow(model: model)");
  });

  it("the key badge keeps the other badges: 未設定, 鍵を作れませんでした, 確認できません", () => {
    const view = stripComments(sources[`${S}/SettingsView.swift`]);
    expect(view).toContain("SettingsMenuText.keyNoneBadge");
    expect(view).toContain("SettingsMenuText.keyStepFailedBadge");
    expect(view).toMatch(/case let \.present\(oldKeyCount\)\?:\s*if case \.failed = oldKeyCount \{ return \.init\(text: SettingsMenuText\.keyUnknownBadge/);
  });

  it("negative control: each of the removed things is caught when put back", () => {
    const withIn = (file: string, extra: string) => leftovers({ ...sources, [file]: sources[file] + "\n" + extra });
    expect(withIn(FILES[0], 'SettingsParts.primaryButton("暗号化する") {}')).toEqual([`${FILES[0]}: the card or its button`]);
    expect(withIn(FILES[0], 'Text(verbatim: "暗号化されていないメールが \\(n) 通あります")')).toEqual([`${FILES[0]}: the card or its button`]);
    expect(withIn(FILES[2], 'static func plainBadge(_ n: Int) -> String { "未暗号化 \\(n) 通" }')).toContain(`${FILES[2]}: the badge`);
    expect(withIn(FILES[3], "async let plain = reader.plainCount()")).toEqual([`${FILES[3]}: the count of plain mail`]);
    expect(withIn(FILES[4], '.eq("body_state", value: "plain")')).toEqual([`${FILES[4]}: a read of plain mail`]);
    expect(leftovers({ ...sources, [FILES[1]]: "" })).toEqual([`${FILES[1]}: not found`]);
  });
});
