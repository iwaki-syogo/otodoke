import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The order of the sections of 「メールの転送」: the Web's settings/forwarding/page.tsx draws the address, then the
 * Gmail approval card (with its failure sentence), then the guides; iOS's SettingsForwardPage draws them in that order.
 * An order that cannot be read is a failure, not a pass.
 * (The Web also draws 「ログイン中」 under the address; the iOS page has no such line and none is added here.)
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

type Section = "address" | "approval" | "guides";
/** Names of the sections, in the order their markers first appear; empty when a marker is missing. */
function order(src: string, markers: Record<Section, RegExp>): Section[] {
  const found = (Object.keys(markers) as Section[]).map((name) => ({ name, at: src.search(markers[name]) }));
  if (found.some((f) => f.at < 0)) return [];
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

const WEB = read("src/app/app/settings/forwarding/page.tsx");
const webOrder = (src: string) => order(src, { address: /<h2[^>]*>転送先アドレス<\/h2>/, approval: /gmail-approval/, guides: /<ForwardingGuides \/>/ });
const swiftBody = (src: string) => {
  const at = src.indexOf("struct SettingsForwardPage");
  const open = src.indexOf("SettingsParts.page(spacing: 32) {", at);
  let depth = 0;
  for (let i = src.indexOf("{", open); i >= 0 && i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
};
const iosOrder = (src: string) => order(swiftBody(stripComments(src)), { address: /\baddressSection\b/, approval: /\.approvalSection\b/, guides: /ForwardingGuideView\(/ });

describe("「メールの転送」: the sections come in the Web's order", () => {
  const IOS = read("ios/Otodoke/Screens/Settings/SettingsPages.swift");

  it("the Web's order is read (address, approval card, guides)", () => {
    expect(webOrder(WEB)).toEqual(["address", "approval", "guides"]);
  });

  it("iOS draws the same order", () => {
    expect(iosOrder(IOS)).toEqual(webOrder(WEB));
  });

  it("negative control: the approval card first, or an unreadable order, is caught", () => {
    const first = IOS.replace("SettingsStatusRows(model: model, register: {}).approvalSection", "").replace("            addressSection\n", "            SettingsStatusRows(model: model, register: {}).approvalSection\n            addressSection\n");
    expect(iosOrder(first)).toEqual(["approval", "address", "guides"]);
    expect(iosOrder(first)).not.toEqual(webOrder(WEB));
    expect(iosOrder(IOS.replace("SettingsStatusRows(model: model, register: {}).approvalSection", ""))).toEqual([]);
    expect(webOrder(WEB.replace("gmail-approval", ""))).toEqual([]);
  });
});
