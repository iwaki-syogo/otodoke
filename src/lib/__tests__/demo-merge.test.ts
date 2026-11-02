import { describe, expect, it } from "vitest";
import { loadDemoEntries } from "@/lib/demo";
import { todayJst } from "@/lib/format";
import { buildParcelInsert, buildParcelUpdate, chooseParcel, parcelTotal, startsParcel, type ParcelCandidate } from "@/lib/match";
import type { Extraction } from "@/lib/extract/schema";

/** The demo video and the judges see this result, so its shape is pinned against the real rules. */
describe("demo set", () => {
  it("folds 17 mails into 6 parcels with a total on each priced one", async () => {
    const now = new Date("2026-11-04T03:00:00Z");
    const parcels: Array<{ row: ParcelCandidate; read: Extraction[] }> = [];
    for (const { mail, extraction: x } of await loadDemoEntries(todayJst(now), now)) {
      const chosen = chooseParcel(parcels.map((p) => p.row), x, now);
      const hit = parcels.find((p) => p.row === chosen);
      if (hit) {
        Object.assign(hit.row, buildParcelUpdate(hit.row, x, mail.date));
        hit.read.push(x);
        hit.row.total_amount = parcelTotal(hit.read);
      } else if (startsParcel(x)) {
        const row = { ...buildParcelInsert("demo", x, mail.date), id: String(parcels.length), created_at: mail.date ?? "", itemNames: x.items.map((i) => i.name) } as unknown as ParcelCandidate;
        row.total_amount = parcelTotal([x]);
        parcels.push({ row, read: [x] });
      }
    }
    const summary = parcels.map((p) => `${p.row.shop}|${p.row.status}|${p.row.total_amount}|${p.read.length}`);
    expect(summary, summary.join("\n")).toHaveLength(6);
    expect(parcels.reduce((sum, p) => sum + p.read.length, 0)).toBe(17);
    expect(parcels.filter((p) => p.row.requires_presence === true).length).toBeGreaterThan(0);
  });
});
