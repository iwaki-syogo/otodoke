import { describe, expect, it, vi } from "vitest";
import { runUndo } from "@/lib/undo-outcome";

const first = { id: "00000000-0000-4000-8000-000000000001", receipt_id: "00000000-0000-4000-8000-000000000011" };
const second = { id: "00000000-0000-4000-8000-000000000002", receipt_id: "00000000-0000-4000-8000-000000000012" };

describe("B-2 undo distinguishes known refusal from an unconfirmed result", () => {
  it("a parcel changed elsewhere is reported as changed, without claiming it is still received", async () => {
    const result = { restored: [], changed: [first.id], failed: [] };
    expect(await runUndo(async () => result, [first])).toEqual(result);
  });

  it("an expired session is failed rather than a changed or received parcel", async () => {
    const result = { restored: [], changed: [], failed: [first.id] };
    expect(await runUndo(async () => result, [first])).toEqual(result);
  });

  it("a lost answer keeps only the affected receipts unconfirmed", async () => {
    expect(await runUndo(async () => { throw new Error("lost answer"); }, [first, second])).toEqual({ restored: [], changed: [], failed: [], unconfirmed: [first.id, second.id] });
  });

  it("preserves an explicitly unconfirmed result beside a known refusal", async () => {
    const result = { restored: [], changed: [], failed: [first.id], unconfirmed: [second.id] };
    expect(await runUndo(async () => result, [first, second])).toEqual(result);
  });

  it("omits the optional group when no requested receipt is unconfirmed", async () => {
    const result = await runUndo(async () => ({ restored: [first.id], changed: [], failed: [], unconfirmed: [] }), [first]);
    expect(result).toEqual({ restored: [first.id], changed: [], failed: [] });
    expect(result).not.toHaveProperty("unconfirmed");
  });

  it("keeps restored and changed facts together without turning either into failure", async () => {
    const result = { restored: [first.id], changed: [second.id], failed: [] };
    expect(await runUndo(async () => result, [first, second])).toEqual(result);
  });

  it("restores 501 receipts through bounded calls and preserves each chunk's result", async () => {
    const receipts = Array.from({ length: 501 }, (_, i) => ({ id: `parcel-${i}`, receipt_id: `receipt-${i}` }));
    const restore = vi.fn(async (chunk: typeof receipts) => ({ restored: chunk.map((item) => item.id), changed: [], failed: [] }));
    const result = await runUndo(restore, receipts);
    expect(restore.mock.calls.map(([chunk]) => chunk.length)).toEqual([200, 200, 101]);
    expect(result).toEqual({ restored: receipts.map((item) => item.id), changed: [], failed: [] });
  });

  it("classifies every distinct asked receipt once when answers omit, overlap or repeat ids", async () => {
    const third = { id: "parcel-3", receipt_id: "receipt-3" };
    const fourth = { id: "parcel-4", receipt_id: "receipt-4" };
    const restore = vi.fn(async () => ({ restored: [first.id, first.id, second.id, "unasked"], changed: [second.id, fourth.id], failed: [] }));
    const result = await runUndo(restore, [first, first, second, third, fourth]);
    expect(restore).toHaveBeenCalledWith([first, second, third, fourth]);
    expect(result).toEqual({ restored: [first.id], changed: [fourth.id], failed: [], unconfirmed: [second.id, third.id] });
    const classified = Object.values(result).flat();
    expect(new Set(classified).size).toBe(4);
    expect(classified).toHaveLength(4);
    expect(classified).not.toContain("unasked");
  });

  it("keeps a valid restored fact when another result group is malformed", async () => {
    const restore = async () => ({ restored: [first.id], changed: null, failed: [] }) as unknown as Awaited<ReturnType<Parameters<typeof runUndo>[0]>>;
    expect(await runUndo(restore, [first, second])).toEqual({ restored: [first.id], changed: [], failed: [], unconfirmed: [second.id] });
  });

  it("multiple group membership is unconfirmed even when one group says failed", async () => {
    const restore = async () => ({ restored: [first.id], changed: [], failed: [second.id], unconfirmed: [second.id] });
    expect(await runUndo(restore, [first, second])).toEqual({ restored: [first.id], changed: [], failed: [], unconfirmed: [second.id] });
  });

  it("continues all 1001 receipts after a middle network failure and partitions the entire request", async () => {
    const receipts = Array.from({ length: 1001 }, (_, i) => ({ id: `parcel-${i}`, receipt_id: `receipt-${i}` }));
    let calls = 0;
    const restore = vi.fn(async (chunk: typeof receipts) => {
      if (++calls === 2) throw new Error("lost middle answer");
      return { restored: chunk.filter((_, i) => i % 2 === 0).map((item) => item.id), changed: chunk.filter((_, i) => i % 2 !== 0).map((item) => item.id), failed: [] };
    });
    const result = await runUndo(restore, receipts);
    expect(restore.mock.calls.map(([chunk]) => chunk.length)).toEqual([200, 200, 200, 200, 200, 1]);
    expect(result).toMatchObject({ failed: [], unconfirmed: receipts.slice(200, 400).map((item) => item.id) });
    const classified = Object.values(result).flat();
    expect(new Set(classified).size).toBe(1001);
    expect(classified).toHaveLength(1001);
    expect(new Set(classified)).toEqual(new Set(receipts.map((item) => item.id)));
  });
});
