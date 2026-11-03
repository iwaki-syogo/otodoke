import { describe, expect, it } from "vitest";

/**
 * undeliveredStatus(row) -> "shipped" | "ordered", exported from src/lib/undelivered.ts (not a
 * "use server" file). Where a parcel goes back to when the user says it has not arrived, decided
 * from the row read from the database: with a tracking number or a carrier it was shipped,
 * without either it goes back to ordered. Empty text and text of spaces only count as none.
 */

type Row = { tracking_number: string | null; carrier: string | null };
const undeliveredStatus = async (row: Row) => (await import("@/lib/undelivered")).undeliveredStatus(row);

describe("undeliveredStatus", () => {
  it("goes back to shipped when the parcel has a tracking number", async () => {
    expect(await undeliveredStatus({ tracking_number: "123456789012", carrier: "佐川急便" })).toBe("shipped");
    expect(await undeliveredStatus({ tracking_number: "123456789012", carrier: null })).toBe("shipped");
  });

  it("goes back to shipped when only the carrier is known", async () => {
    expect(await undeliveredStatus({ tracking_number: null, carrier: "ヤマト運輸" })).toBe("shipped");
  });

  it("goes back to ordered when neither is known", async () => {
    expect(await undeliveredStatus({ tracking_number: null, carrier: null })).toBe("ordered");
  });

  it("counts empty text and spaces only as none", async () => {
    expect(await undeliveredStatus({ tracking_number: "", carrier: "" })).toBe("ordered");
    expect(await undeliveredStatus({ tracking_number: "   ", carrier: null })).toBe("ordered");
    expect(await undeliveredStatus({ tracking_number: null, carrier: " 　 " })).toBe("ordered");
  });

  it("still counts a value with spaces around it", async () => {
    expect(await undeliveredStatus({ tracking_number: " 123456789012 ", carrier: null })).toBe("shipped");
    expect(await undeliveredStatus({ tracking_number: "", carrier: " 日本郵便 " })).toBe("shipped");
  });
});
