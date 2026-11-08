import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS, aligned with the Web's origin/dev 84255fc]
 *  - the approval is read as src/app/app/settings/settings-reads.ts reads it (the newest CONFIRMATION_LOOKBACK
 *    confirmation mails by created_at, the first with Google's link; the badge decided by time);
 *  - every Web page the app opens exists under src/app/app/settings/, and no section hash (#demo, #gmail-approval)
 *    is used any more.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

describe("the approval is read as the Web reads it", () => {
  const web = read("src/app/app/settings/settings-reads.ts");
  const reader = stripComments(read("ios/Otodoke/Data/SettingsReader.swift"));

  it("the lookback is the Web's CONFIRMATION_LOOKBACK", () => {
    const webN = Number(web.match(/const CONFIRMATION_LOOKBACK = (\d+);/)?.[1]);
    const iosN = Number(reader.match(/static let confirmationLookback = (\d+)/)?.[1]);
    expect(webN).toBeGreaterThan(0);
    expect(iosN).toBe(webN);
    expect(iosN).toBe(10);
  });

  it("negative control: another number is caught", () => {
    const webN = Number(web.match(/const CONFIRMATION_LOOKBACK = (\d+);/)?.[1]);
    expect(Number(reader.replace("confirmationLookback = 10", "confirmationLookback = 1").match(/static let confirmationLookback = (\d+)/)?.[1])).not.toBe(webN);
  });

  it("the read orders by created_at, newest first, nulls last, and takes the lookback; the picker takes the first valid row", () => {
    expect(web).toMatch(/\.order\("created_at", \{ ascending: false, nullsFirst: false \}\)\s*\.limit\(CONFIRMATION_LOOKBACK\)/);
    expect(reader).toMatch(/\.order\("created_at", ascending: false, nullsFirst: false\)\s*\.limit\(Self\.confirmationLookback\)/);
    const model = stripComments(read("ios/Otodoke/Screens/Settings/SettingsModel.swift"));
    expect(model).toMatch(/for row in rows \{\s*if let url = approvalURL\(row\) \{ return \(url, row\.createdAt\) \}/);
    expect(reader).not.toContain('order("sent_at"');
  });

  it("the badge's time rule is the Web's countArrivedAfter: all - samples - confirmations + screen_events, after `at`", () => {
    expect(web).toContain("(all.count ?? 0) - (samples.count ?? 0) - (confirmations.count ?? 0) + (screened.count ?? 0)");
    expect(reader).toContain("all - samples - confirmations + screened");
    expect(reader).toMatch(/\.gt\("created_at", value: at\)/);
  });
});

describe("the pages the app opens in the browser", () => {
  const SETTINGS_DIR = path.join(ROOT, "src/app/app/settings");
  const pages = () => {
    const out: string[] = [];
    for (const e of readdirSync(SETTINGS_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith("(") && existsSync(path.join(SETTINGS_DIR, e.name, "page.tsx"))) out.push(e.name);
    }
    return out;
  };
  const webLink = stripComments(read("ios/Otodoke/Screens/Shared/OpenWeb.swift"));
  const paths = [...webLink.matchAll(/page\("(\/[^"]*)"\)/g)].map((m) => m[1]);

  it("every /app/settings/<page> path exists as src/app/app/settings/<page>/page.tsx", () => {
    const settingsPaths = paths.filter((p) => p.startsWith("/app/settings"));
    // 「読み取る」 (trouble) and 「これは荷物」 (dropped) finish in the app now: no link to those pages is left.
    expect(settingsPaths.sort()).toEqual(["/app/settings/delete", "/app/settings/password"]);
    const existing = pages();
    for (const p of settingsPaths) expect(existing, p).toContain(p.replace("/app/settings/", ""));
  });

  it("the Web has the eight pages 84255fc lists (the list and seven pages)", () => {
    expect(pages().sort()).toEqual(["delete", "demo", "dropped", "forwarding", "mail-handling", "password", "trouble"]);
    expect(existsSync(path.join(SETTINGS_DIR, "(list)/page.tsx"))).toBe(true);
  });

  it("no old section hash is used anywhere in the app", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".swift")) files.push(rel);
      }
    };
    walk("ios/Otodoke");
    const all = files.map((f) => stripComments(read(f))).join("\n");
    expect(all).not.toMatch(/#demo|#gmail-approval/);
    expect(all).not.toMatch(/page\("\/app\/settings"\)/);
  });

  it("each button's page is the page that holds the button (read from the Web's own files)", () => {
    const has = (file: string, text: string) => expect(read(`src/app/app/settings/${file}`), `${file} has ${text}`).toContain(text);
    has("password-panel.tsx", "鍵を作る");
    has("password-panel.tsx", "パスワードを変える");
    has("trouble/page.tsx", "読み取る");
    has("dropped/page.tsx", "これは荷物");
    has("demo-loader.tsx", "すべての荷物を消す");
    has("demo-loader.tsx", "LOAD_DEMO_LABEL");
    has("demo-labels.ts", "サンプル");
    expect(read("src/app/app/settings/(list)/page.tsx")).toContain('href: "/app/settings/delete"');
    const model = stripComments(read("ios/Otodoke/Screens/Settings/SettingsModel.swift"));
    expect(model).toMatch(/case \.changePassphrase: WebLink\.settingsPassword/);
    expect(model).not.toMatch(/case \.readWaiting|case \.markAsParcel|settingsTrouble|settingsDropped|settingsDemo|createPassphrase|case \.sample|case \.clearAll/);
    expect(model).toMatch(/case \.deleteAccount: WebLink\.settingsDelete/);
  });

  it("negative control: a path with no page under settings is caught", () => {
    expect(pages()).not.toContain("nothing-here");
  });
});
