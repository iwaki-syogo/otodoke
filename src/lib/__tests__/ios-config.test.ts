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

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (_, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return XML_ENTITIES[name];
  });
}

/**
 * An XML property list as plain values (dict, array, string, integer, real, true, false; data and date
 * as their text). Only what a privacy manifest uses; anything else throws. Read in Node so that the test
 * runs off macOS too (no plutil).
 */
function parsePlist(xml: string): PlistValue {
  const body = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "");
  const tokens = body.match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const next = () => {
    while (i < tokens.length && !tokens[i].startsWith("<") && tokens[i].trim() === "") i++;
    return tokens[i++];
  };
  const textUntil = (close: string) => {
    let text = "";
    while (tokens[i] !== close) {
      if (i >= tokens.length || tokens[i].startsWith("<")) throw new Error(`plist: expected ${close}`);
      text += tokens[i++];
    }
    i++;
    return unescapeXml(text);
  };
  const value = (tag: string | undefined): PlistValue => {
    switch (tag) {
      case "<true/>":
        return true;
      case "<false/>":
        return false;
      case "<array/>":
        return [];
      case "<dict/>":
        return {};
      case "<string/>":
        return "";
      case "<string>":
        return textUntil("</string>");
      case "<data>":
        return textUntil("</data>").replace(/\s+/g, "");
      case "<date>":
        return textUntil("</date>");
      case "<integer>":
      case "<real>": {
        const n = Number(textUntil(tag === "<integer>" ? "</integer>" : "</real>").trim());
        if (!Number.isFinite(n)) throw new Error("plist: bad number");
        return n;
      }
      case "<array>": {
        const out: PlistValue[] = [];
        for (let t = next(); t !== "</array>"; t = next()) out.push(value(t));
        return out;
      }
      case "<dict>": {
        const out: { [key: string]: PlistValue } = {};
        for (let t = next(); t !== "</dict>"; t = next()) {
          if (t !== "<key>") throw new Error(`plist: expected <key>, got ${t}`);
          const key = textUntil("</key>");
          out[key] = value(next());
        }
        return out;
      }
      default:
        throw new Error(`plist: unexpected ${tag}`);
    }
  };
  const open = next();
  if (open === undefined || !/^<plist[\s>]/.test(open)) throw new Error("plist: no <plist>");
  const root = value(next());
  if (next() !== "</plist>") throw new Error("plist: expected </plist>");
  return root;
}

/** Independent declaration contract; never derive the expected set or order from the manifest. */
const COLLECTED_DATA_TYPES = [
  "NSPrivacyCollectedDataTypeEmailAddress",
  "NSPrivacyCollectedDataTypeUserID",
  "NSPrivacyCollectedDataTypePurchaseHistory",
  "NSPrivacyCollectedDataTypeEmailsOrTextMessages",
  "NSPrivacyCollectedDataTypeOtherUserContent",
  "NSPrivacyCollectedDataTypeProductInteraction",
  "NSPrivacyCollectedDataTypeOtherUsageData",
  "NSPrivacyCollectedDataTypeOtherDiagnosticData",
] as const;
const APP_FUNCTIONALITY = "NSPrivacyCollectedDataTypePurposeAppFunctionality";
type PlistDictionary = { [key: string]: PlistValue };

function readPrivacyManifest(): PlistValue {
  return parsePlist(readFileSync(path.join(ROOT, "ios/Otodoke/Support/PrivacyInfo.xcprivacy"), "utf8"));
}

/** Shared by the real-source positive and every negative control, including strict Boolean values. */
function assertPrivacyManifest(value: PlistValue): void {
  expect(value).toBeTypeOf("object");
  expect(Array.isArray(value)).toBe(false);
  const manifest = value as PlistDictionary;
  expect(Object.keys(manifest).sort()).toEqual([
    "NSPrivacyAccessedAPITypes", "NSPrivacyCollectedDataTypes", "NSPrivacyTracking", "NSPrivacyTrackingDomains",
  ]);
  expect(manifest.NSPrivacyTracking).toBe(false);
  expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
  expect(manifest.NSPrivacyAccessedAPITypes).toEqual([]);
  expect(Array.isArray(manifest.NSPrivacyCollectedDataTypes)).toBe(true);
  const types = manifest.NSPrivacyCollectedDataTypes as PlistDictionary[];
  const names = types.map((entry) => entry.NSPrivacyCollectedDataType);
  expect(new Set(names).size, "no duplicate data-type dictionaries").toBe(types.length);
  expect(names, "the exact reviewed set in its declared order").toEqual([...COLLECTED_DATA_TYPES]);
  for (const [index, entry] of types.entries()) {
    const name = COLLECTED_DATA_TYPES[index];
    expect(entry.NSPrivacyCollectedDataTypeLinked, name).toBe(true);
    expect(entry.NSPrivacyCollectedDataTypeTracking, name).toBe(false);
    expect(entry.NSPrivacyCollectedDataTypePurposes, name).toEqual([APP_FUNCTIONALITY]);
    expect(entry, name).toEqual({
      NSPrivacyCollectedDataType: name,
      NSPrivacyCollectedDataTypeLinked: true,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: [APP_FUNCTIONALITY],
    });
  }
}

const ADDED_TYPE_MUTATIONS = [
  "missing-type", "linked-false", "linked-string", "tracking-true", "tracking-string",
  "purpose-missing", "purpose-other", "purpose-extra", "purpose-duplicate", "duplicate-type", "unknown-type",
] as const;

describe("privacy manifest: the data the app handles", () => {
  it("reads an XML property list", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<!-- a comment -->
\t<key>A &amp; B</key>
\t<string>x &lt;y&gt;</string>
\t<key>T</key><true/>
\t<key>F</key><false/>
\t<key>Empty</key><array/>
\t<key>N</key><integer>42</integer>
\t<key>List</key>
\t<array>
\t\t<dict><key>k</key><string>v</string></dict>
\t\t<string/>
\t</array>
</dict>
</plist>`;
    expect(parsePlist(xml)).toEqual({
      "A & B": "x <y>",
      T: true,
      F: false,
      Empty: [],
      N: 42,
      List: [{ k: "v" }, ""],
    });
    expect(() => parsePlist("<plist><dict><string>x</string></dict></plist>")).toThrow();
    expect(() => parsePlist("<plist><dict><key>k</key><true/>")).toThrow();
    expect(() => parsePlist("<dict></dict>")).toThrow();
  });

  // On macOS only: the reader gives what plutil gives for the real manifest.
  it.skipIf(process.platform !== "darwin")("reads the manifest as plutil does (macOS only)", () => {
    const file = path.join(ROOT, "ios/Otodoke/Support/PrivacyInfo.xcprivacy");
    const viaPlutil = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
    expect(parsePlist(readFileSync(file, "utf8"))).toEqual(viaPlutil);
  });

  it("declares each type linked, for app functionality, with no tracking", () => {
    assertPrivacyManifest(readPrivacyManifest());
  });

  it.each(COLLECTED_DATA_TYPES.slice(5).flatMap((name) => ADDED_TYPE_MUTATIONS.map((mutation) => ({ name, mutation }))))(
    "negative control: rejects $mutation for $name", ({ name, mutation }) => {
      const original = readPrivacyManifest();
      assertPrivacyManifest(original);
      const mutated = structuredClone(original) as PlistDictionary;
      const types = mutated.NSPrivacyCollectedDataTypes as PlistDictionary[];
      const index = types.findIndex((entry) => entry.NSPrivacyCollectedDataType === name);
      expect(index).toBeGreaterThanOrEqual(0);
      const entry = types[index];
      switch (mutation) {
        case "missing-type": types.splice(index, 1); break;
        case "linked-false": entry.NSPrivacyCollectedDataTypeLinked = false; break;
        case "linked-string": entry.NSPrivacyCollectedDataTypeLinked = "true"; break;
        case "tracking-true": entry.NSPrivacyCollectedDataTypeTracking = true; break;
        case "tracking-string": entry.NSPrivacyCollectedDataTypeTracking = "false"; break;
        case "purpose-missing": delete entry.NSPrivacyCollectedDataTypePurposes; break;
        case "purpose-other": entry.NSPrivacyCollectedDataTypePurposes = ["NSPrivacyCollectedDataTypePurposeAnalytics"]; break;
        case "purpose-extra": entry.NSPrivacyCollectedDataTypePurposes = [APP_FUNCTIONALITY, "NSPrivacyCollectedDataTypePurposeAnalytics"]; break;
        case "purpose-duplicate": entry.NSPrivacyCollectedDataTypePurposes = [APP_FUNCTIONALITY, APP_FUNCTIONALITY]; break;
        case "duplicate-type": types.push(structuredClone(entry)); break;
        case "unknown-type": types.push({ ...entry, NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeFutureUnknown" }); break;
      }
      expect(mutated, "the mutation must change the actual parsed manifest").not.toEqual(original);
      expect(() => assertPrivacyManifest(mutated)).toThrow();
    },
  );

  it.each(["swapped-order", "top-level-tracking", "tracking-domain", "accessed-api"] as const)(
    "negative control: rejects %s outside the per-type values", (mutation) => {
      const original = readPrivacyManifest();
      assertPrivacyManifest(original);
      const mutated = structuredClone(original) as PlistDictionary;
      const types = mutated.NSPrivacyCollectedDataTypes as PlistDictionary[];
      switch (mutation) {
        case "swapped-order": [types[5], types[6]] = [types[6], types[5]]; break;
        case "top-level-tracking": mutated.NSPrivacyTracking = true; break;
        case "tracking-domain": mutated.NSPrivacyTrackingDomains = ["tracker.example.test"]; break;
        case "accessed-api": mutated.NSPrivacyAccessedAPITypes = [{ NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults", NSPrivacyAccessedAPITypeReasons: ["CA92.1"] }]; break;
      }
      expect(mutated, "the mutation must change the actual parsed manifest").not.toEqual(original);
      expect(() => assertPrivacyManifest(mutated)).toThrow();
    },
  );
});
