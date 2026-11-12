import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PARTLY_RESTORED_NOTICE, UNDO_CHANGED_NOTICE, UNDO_FAILED_NOTICE } from "@/lib/format";
import { runUndo } from "@/lib/undo-outcome";

const receipt = { id: "parcel", receipt_id: "opaque-receipt" };

describe("what 元に戻す knows", () => {
  it("all restored: returns the confirmed restored IDs", async () => {
    expect(await runUndo(async () => ({ restored: [receipt.id], changed: [], failed: [] }), [receipt])).toEqual({ restored: [receipt.id], changed: [], failed: [] });
  });
  it("a change elsewhere says nothing about whether a parcel is still received", async () => {
    expect(await runUndo(async () => ({ restored: [], changed: [receipt.id], failed: [] }), [receipt])).toEqual({ restored: [], changed: [receipt.id], failed: [] });
    expect(UNDO_CHANGED_NOTICE).not.toContain("受け取り済みのまま");
  });
  it("a lost request is failed, not a changed parcel", async () => {
    expect(await runUndo(async () => { throw new Error("offline"); }, [receipt])).toEqual({ restored: [], changed: [], failed: [receipt.id] });
    expect(UNDO_FAILED_NOTICE).toBe("元に戻せませんでした");
  });
});

const IOS = path.resolve(__dirname, "../../../ios/Otodoke");
const swiftSources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? swiftSources(path.join(dir, e.name)) : e.name.endsWith(".swift") ? [readFileSync(path.join(dir, e.name), "utf8")] : []));

// The same sentence must exist in the iOS app (build 14 has it).
describe("iOS parity of the partial-undo sentence", () => {
  it("the iOS Swift sources contain PARTLY_RESTORED_NOTICE verbatim", () => {
    expect(swiftSources(IOS).some((src) => src.includes(PARTLY_RESTORED_NOTICE))).toBe(true);
  });
});
