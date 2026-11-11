import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PARTLY_RESTORED_NOTICE } from "@/lib/format";
import { runUndo } from "@/lib/undo-outcome";

const CONTROLS = readFileSync(path.resolve(__dirname, "../../app/app/delivered-controls.tsx"), "utf8");

describe("what 元に戻す shows", () => {
  it("everything went back: the notice closes", async () => {
    expect(await runUndo(async () => ({ leftReceived: false }))).toBe("done");
  });

  it("only some went back: the notice says some parcels are still received", async () => {
    expect(await runUndo(async () => ({ leftReceived: true }))).toBe("partly");
    expect(PARTLY_RESTORED_NOTICE).toBe("受け取り済みのままの荷物があります");
  });

  it("an exception is the failure text, not a partial one", async () => {
    expect(await runUndo(async () => { throw new Error("offline"); })).toBe("failed");
    expect(CONTROLS).toContain("元に戻せませんでした");
  });

  it("the toast uses the outcome: it shows the notice for a partial undo and does not drop the result", () => {
    expect(CONTROLS).toMatch(/runUndo\(\(\) => restoreStatuses\(items\)\)/);
    expect(CONTROLS).toMatch(/outcome === "partly"\) setToast\(\{ text: PARTLY_RESTORED_NOTICE, undo: null \}\)/);
  });
});

const IOS = path.resolve(__dirname, "../../../ios/Otodoke");
const swiftSources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? swiftSources(path.join(dir, e.name)) : e.name.endsWith(".swift") ? [readFileSync(path.join(dir, e.name), "utf8")] : []));

// The same sentence must exist in the iOS app, but build 14 (feature/ios-b14) has not been merged into
// this branch yet, so the app does not have it. Change it.skip to it after merging build 14.
describe("iOS parity of the partial-undo sentence", () => {
  it.skip("the iOS Swift sources contain PARTLY_RESTORED_NOTICE verbatim", () => {
    expect(swiftSources(IOS).some((src) => src.includes(PARTLY_RESTORED_NOTICE))).toBe(true);
  });
});
