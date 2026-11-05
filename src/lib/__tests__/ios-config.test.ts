import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS batch 1, fix N1・SEC-N3] Settings the iOS app depends on that live outside Swift.
 *
 * The app reads every parcel page by page and stops at the first page shorter than
 * ParcelReader.pageSize. If PostgREST's max_rows were lower than that, the first page would always be
 * short and the app would show part of the list as if it were all of it. supabase/config.toml is
 * the project's record of the API settings (the dashboard's "Max rows" must match it).
 */

const ROOT = path.resolve(__dirname, "../../..");

/** The value of `key` in the `[section]` table of a TOML file (a bare number). */
function tomlNumber(text: string, section: string, key: string): number | undefined {
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current !== section) continue;
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (pair && pair[1] === key) {
      const n = Number(pair[2].trim());
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

function pageSize(): number {
  const swift = readFileSync(path.join(ROOT, "ios/Otodoke/Data/ParcelReader.swift"), "utf8");
  const m = /static let pageSize = ([0-9_]+)/.exec(swift);
  if (!m) throw new Error("ParcelReader.pageSize not found");
  return Number(m[1].replace(/_/g, ""));
}

describe("PostgREST max_rows and the app's page size", () => {
  it("reads [api] max_rows from config.toml", () => {
    expect(tomlNumber("[api]\nport = 1\nmax_rows = 1000 # rows\n[db]\nmax_rows = 5\n", "api", "max_rows")).toBe(1000);
    expect(tomlNumber("[api.tls]\nmax_rows = 1000\n", "api", "max_rows")).toBeUndefined();
    expect(tomlNumber("[api]\n# max_rows = 1000\n", "api", "max_rows")).toBeUndefined();
  });

  it("max_rows is at least 1,000 and at least the app's page size", () => {
    const toml = readFileSync(path.join(ROOT, "supabase/config.toml"), "utf8");
    const maxRows = tomlNumber(toml, "api", "max_rows");
    expect(maxRows).toBeDefined();
    expect(maxRows!).toBeGreaterThanOrEqual(1000);
    expect(maxRows!).toBeGreaterThanOrEqual(pageSize());
  });

  it("the app's page size is 1,000", () => {
    expect(pageSize()).toBe(1000);
  });
});

describe("privacy manifest: the data the app handles", () => {
  it("declares each type linked, for app functionality, with no tracking", () => {
    const file = path.join(ROOT, "ios/Otodoke/Support/PrivacyInfo.xcprivacy");
    const json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
    const types = (json.NSPrivacyCollectedDataTypes ?? []) as Array<Record<string, unknown>>;
    for (const name of [
      "NSPrivacyCollectedDataTypeEmailAddress",
      "NSPrivacyCollectedDataTypeUserID",
      "NSPrivacyCollectedDataTypePurchaseHistory",
      "NSPrivacyCollectedDataTypeEmailsOrTextMessages",
      "NSPrivacyCollectedDataTypeOtherUserContent",
    ]) {
      const entry = types.find((d) => d.NSPrivacyCollectedDataType === name);
      expect(entry, name).toBeDefined();
      expect(entry!.NSPrivacyCollectedDataTypeLinked, name).toBe(true);
      expect(entry!.NSPrivacyCollectedDataTypeTracking, name).toBe(false);
      expect(entry!.NSPrivacyCollectedDataTypePurposes, name).toEqual(["NSPrivacyCollectedDataTypePurposeAppFunctionality"]);
    }
    expect(json.NSPrivacyTracking).toBe(false);
  });
});
