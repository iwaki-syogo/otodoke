import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The auto refresh of the Gmail approval card on iOS (ApprovalRefresher.swift) keeps the Web's three numbers
 * (src/components/refresh-until-approval.tsx): MIN_GAP_MS, POLL_MS, ACTIVE_MS. The behaviour is run in
 * OtodokeTests/ApprovalRefresherTests.swift with a fake clock; here the numbers and the wiring are pinned.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const DIR = "ios/Otodoke/Screens/Settings";
const WEB = read("src/components/refresh-until-approval.tsx");
const SWIFT = stripComments(read(`${DIR}/ApprovalRefresher.swift`));

/** `export const NAME = <expr>;` of the Web file, in seconds. */
const webSeconds = (name: string): number => {
  const expr = WEB.match(new RegExp(`export const ${name} = ([^;]+);`))?.[1];
  if (!expr) throw new Error(`${name} is not found`);
  return (new Function(`return ${expr.replace(/_/g, "")};`)() as number) / 1000;
};
/** `static let NAME: TimeInterval = <expr>` of the Swift file. */
const swiftSeconds = (src: string, name: string): number => {
  const expr = src.match(new RegExp(`static let ${name}: TimeInterval = ([^\\n]+)`))?.[1];
  if (!expr) throw new Error(`${name} is not found`);
  return new Function(`return ${expr};`)() as number;
};

describe("iOS approval auto refresh keeps the Web's numbers", () => {
  it("10 s gap, 20 s poll, 5 min active", () => {
    expect(webSeconds("MIN_GAP_MS")).toBe(10);
    expect(webSeconds("POLL_MS")).toBe(20);
    expect(webSeconds("ACTIVE_MS")).toBe(300);
    expect(swiftSeconds(SWIFT, "minGap")).toBe(webSeconds("MIN_GAP_MS"));
    expect(swiftSeconds(SWIFT, "pollEvery")).toBe(webSeconds("POLL_MS"));
    expect(swiftSeconds(SWIFT, "activeFor")).toBe(webSeconds("ACTIVE_MS"));
  });

  it("negative control: a changed number is caught", () => {
    expect(swiftSeconds(SWIFT.replace("pollEvery: TimeInterval = 20", "pollEvery: TimeInterval = 30"), "pollEvery")).not.toBe(webSeconds("POLL_MS"));
    expect(swiftSeconds(SWIFT.replace("5 * 60", "10 * 60"), "activeFor")).not.toBe(webSeconds("ACTIVE_MS"));
  });

  it("the page starts it after its own read, stops it on leaving and when the app goes away, and counts a return", () => {
    const pages = stripComments(read(`${DIR}/SettingsPages.swift`));
    const forward = pages.slice(pages.indexOf("struct SettingsForwardPage"), pages.indexOf("struct", pages.indexOf("struct SettingsForwardPage") + 10));
    expect(forward).toMatch(/await model\.pageShown\(\)[\s\S]*ApprovalRefresher\([\s\S]*refresher\.pageShown\(\)/);
    expect(forward).toMatch(/\.onDisappear \{ refresher\?\.pageHidden\(\) \}/);
    expect(forward).toMatch(/onChange\(of: scenePhase\)[\s\S]*cameBack\(\)[\s\S]*wentAway\(\)/);
    // The beats run again when the link goes away on a full read.
    expect(forward).toMatch(/onChange\(of: model\.pollsForApproval\)[\s\S]*waitingAgain\(\)/);
    // Only the approval is read again.
    expect(forward).toMatch(/read: \{ await model\.refreshApproval\(\) \}/);
    expect(forward).not.toMatch(/model\.load\(\)\s*\}\s*\n\s*\)/);
    // A page that is left reads nothing (M2), and a return read is cut off by stop() (N5).
    expect(SWIFT).toMatch(/func cameBack\(\) async \{[\s\S]*guard visible else \{ return \}/);
    expect(SWIFT).toMatch(/guard visible, inFront, isWaiting\(\)/);
    expect(SWIFT).toMatch(/returnRead\?\.cancel\(\)/);
  });

  it("the model runs it only for an address on show with no link yet, and reads only the confirmations", () => {
    const model = stripComments(read(`${DIR}/SettingsModel.swift`));
    const polls = model.match(/var pollsForApproval: Bool \{([\s\S]*?)\n {4}\}/)?.[1] ?? "";
    expect(polls).toMatch(/case \.present\? = keyPanel, addressCanBeCopied, confirmURL == nil/);
    const refresh = model.match(/func refreshApproval\(\) async \{([\s\S]*?)\n {4}\}/)?.[1] ?? "";
    expect(refresh).toContain("reader.forwardingConfirmations()");
    expect(refresh).not.toMatch(/reader\.(currentKey|plainCount|unreadCount|dropped|oldKeyCount)|load\(\)/);
    // M1: a cancelled read writes nothing and does not count as a read; S1: a full read that began meanwhile wins.
    expect(refresh).toMatch(/guard !Task\.isCancelled, started == loadsStarted, loadsRunning == 0, pollsForApproval else \{ return \}\s*lastApprovalRead = now\(\)/);
    // S2: the card and the badge are decided in one place, used by load() and the refresh.
    expect(refresh).toContain("applyApproval(confirmation, later: later)");
    expect(model.match(/applyApproval\(/g)).toHaveLength(3);
    // Negative control: without the cancellation guard the check is caught.
    expect(refresh.replace("guard !Task.isCancelled, started", "guard started")).not.toMatch(/guard !Task\.isCancelled, started/);
    // Negative control: a polls rule without the address would be caught.
    expect(polls.replace("addressCanBeCopied, ", "")).not.toMatch(/addressCanBeCopied/);
  });
});
