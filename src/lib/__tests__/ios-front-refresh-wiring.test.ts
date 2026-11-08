import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A long load or write that finishes while another screen is in front moves DataChanges' version; MainTabView must
 * hear it (onChange of the version) and tell the refresher (dataChanged()), and only while the app is in front.
 * Without this wiring the front screen stays as it was (tsc, the unit tests of the refresher and the build stay green).
 */
const ROOT = path.resolve(__dirname, "../../..");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
const tabs = stripComments(readFileSync(path.join(ROOT, "ios/Otodoke/Screens/MainTabView.swift"), "utf8"));

const problems = (src: string): string[] => {
  const out: string[] = [];
  const block = src.match(/\.onChange\(of: screens\.changes\.version\) \{([\s\S]*?)\n        \}/)?.[1] ?? "";
  if (!block) out.push("MainTabView does not watch screens.changes.version");
  if (!/\bdataChanged\(\)/.test(block)) out.push("the version change does not call dataChanged()");
  if (!/guard scenePhase == \.active else \{ return \}/.test(block)) out.push("the version change is not limited to scenePhase .active");
  return out;
};

describe("MainTabView reads the front screen again when DataChanges moves", () => {
  it("watches the version, calls dataChanged(), and only while the app is active", () => {
    expect(problems(tabs)).toEqual([]);
  });

  it("every tab root tells the refresher how to read when stale", () => {
    for (const tab of ["parcels", "calendar", "spend", "settings"]) {
      expect(tabs, tab).toMatch(new RegExp(`\\.shownScreen\\(\\.${tab}, in: \\.${tab}, screens\\.refresher, refresh: [^\\n]*ifStale:`));
    }
  });

  it("negative control: a missing watcher, a missing call, or a missing active guard is caught", () => {
    expect(problems(tabs.replace("screens.changes.version", "screens.changes.other"))).toContain("MainTabView does not watch screens.changes.version");
    expect(problems(tabs.replace("dataChanged()", "somethingElse()"))).toContain("the version change does not call dataChanged()");
    expect(problems(tabs.replace("guard scenePhase == .active else { return }", ""))).toContain("the version change is not limited to scenePhase .active");
  });
});
