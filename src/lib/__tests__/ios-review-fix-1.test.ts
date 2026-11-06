import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS batch 2, M1, review fix 1] Checks on ios/ that the Swift tests cannot see: the views use what
 * the models now decide.
 *  - M1 = SEC-M1: the approval page is opened only through SettingsModel.isApprovalPage;
 *  - S2: the passphrase card and the approval section show the two notes;
 *  - S3: the login widget is shown through LoginModel.showsWidget;
 *  - N3: the tabs tell the refresher the selection and each appearance by token.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The body of `private var <name>: some View { ... }` (up to the next declaration at 4 spaces). */
function viewProperty(src: string, name: string): string {
  const m = src.match(new RegExp(`var ${name}: some View \\{([\\s\\S]*?)\\n {4}\\}`));
  return m ? m[1] : "";
}

describe("M1 = SEC-M1: the approval page", () => {
  // The settings screen was split into a list and pages: the approval card lives in SettingsStatusRows.
  const view = stripComments(read("ios/Otodoke/Screens/Settings/SettingsStatusRows.swift"));

  it("the approval section checks the URL with SettingsModel.isApprovalPage before it opens", () => {
    const section = viewProperty(view, "approvalSection");
    expect(section, "approvalSection").not.toBe("");
    expect(section).toMatch(/SettingsModel\.isApprovalPage\(/);
  });

  it("the model hands out only URLs that pass the same check", () => {
    const model = stripComments(read("ios/Otodoke/Screens/Settings/SettingsModel.swift"));
    const approval = model.match(/static func approvalURL\([^)]*\)[^{]*\{([\s\S]*?)\n {4}\}/);
    expect(approval, "approvalURL").not.toBeNull();
    expect(approval![1]).toMatch(/isApprovalPage\(/);
  });
});

describe("S2: the two failures are shown", () => {
  // The settings screen was split into a list and pages: the passphrase card lives in SettingsKeyPage,
  // the approval card in SettingsStatusRows.
  const view = stripComments(read("ios/Otodoke/Screens/Settings/SettingsStatusRows.swift"));
  const keyPage = stripComments(read("ios/Otodoke/Screens/Settings/SettingsKeyPage.swift"));

  it("the passphrase card shows model.oldKeyNote", () => {
    expect(viewProperty(keyPage, "keyPanel")).toMatch(/model\.oldKeyNote/);
  });

  it("the approval section shows model.approvalNote", () => {
    expect(viewProperty(view, "approvalSection")).toMatch(/model\.approvalNote/);
  });
});

describe("S3: the login widget", () => {
  it("LoginView shows the widget through model.showsWidget", () => {
    // password-v1: one form, every press needs a token: the widget is always shown, from the model's token.
    const login = stripComments(read("ios/Otodoke/Auth/LoginView.swift"));
    expect(login).toMatch(/if let turnstile = model\.turnstile\s*\{\s*TurnstileView\(token: turnstile\)/);
    expect(login).not.toMatch(/showsWidget/);
  });
});

describe("N3: the front from the selection and the stacks", () => {
  const tabs = stripComments(read("ios/Otodoke/Screens/MainTabView.swift"));

  it("the TabView's selection reaches the refresher", () => {
    expect(tabs).toMatch(/onChange\(of:\s*selection/);
    expect(tabs).toMatch(/\.select\(/);
  });

  it("each screen appears and disappears by token", () => {
    expect(tabs).toMatch(/\.appeared\(/);
    expect(tabs).toMatch(/\.disappeared\(/);
    // The id-keyed register of a detail (one closure per parcel, never let go) is gone.
    expect(tabs).not.toMatch(/\.register\(/);
  });
});
