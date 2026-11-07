import { describe, expect, it } from "vitest";
import { loadDemoEntries, type DemoEntry } from "@/lib/demo";
import { todayJst } from "@/lib/format";
import { buildParcelInsert, buildParcelUpdate, chooseParcel, parcelTotal, startsParcel, type ParcelCandidate } from "@/lib/match";
import type { Extraction } from "@/lib/extract/schema";

/** The demo video and the judges see this result, so its shape is pinned against the real rules. */

type Folded = { row: ParcelCandidate; read: Extraction[]; files: string[] };

function fold(entries: DemoEntry[], now: Date): Folded[] {
  const parcels: Folded[] = [];
  for (const { mail, extraction: x } of entries) {
    const chosen = chooseParcel(parcels.map((p) => p.row), x, now);
    const hit = parcels.find((p) => p.row === chosen);
    if (hit) {
      Object.assign(hit.row, buildParcelUpdate(hit.row, x, mail.date));
      hit.read.push(x);
      hit.files.push(mail.file);
      hit.row.total_amount = parcelTotal(hit.read);
    } else if (startsParcel(x)) {
      const row = { ...buildParcelInsert("demo", x, mail.date), id: String(parcels.length), created_at: mail.date ?? "", itemNames: x.items.map((i) => i.name) } as unknown as ParcelCandidate;
      row.total_amount = parcelTotal([x]);
      parcels.push({ row, read: [x], files: [mail.file] });
    }
  }
  return parcels;
}

const isHistory = (file: string) => file.startsWith("history/");
const summary = (parcels: Folded[]) => parcels.map((p) => `${p.row.shop}|${p.row.status}|${p.row.total_amount}|${p.read.length}|${p.row.expected_date}|${p.row.requires_presence}`);

describe("demo set", () => {
  const now = new Date("2026-11-04T03:00:00Z");

  it("folds the 17 real mails into 6 parcels with a total on each priced one", async () => {
    const real = (await loadDemoEntries(todayJst(now), now)).filter((e) => !isHistory(e.mail.file));
    const parcels = fold(real, now);
    expect(summary(parcels), summary(parcels).join("\n")).toHaveLength(6);
    expect(parcels.reduce((sum, p) => sum + p.read.length, 0)).toBe(17);
    expect(parcels.filter((p) => p.row.requires_presence === true).length).toBeGreaterThan(0);
  });

  it("with the made-up history: the same 6 parcels, and each history mail one delivered parcel of its own", async () => {
    const all = await loadDemoEntries(todayJst(now), now);
    expect(all).toHaveLength(97);
    const parcels = fold(all, now);
    expect(parcels).toHaveLength(86);
    const real = parcels.filter((p) => p.files.every((f) => !isHistory(f)));
    const history = parcels.filter((p) => p.files.every(isHistory));
    // No parcel mixes the two.
    expect(real.length + history.length).toBe(86);
    expect(summary(real)).toEqual(summary(fold(all.filter((e) => !isHistory(e.mail.file)), now)));
    expect(history).toHaveLength(80);
    for (const p of history) {
      expect(p.read, p.files[0]).toHaveLength(1);
      expect(p.row.status, p.files[0]).toBe("delivered");
      expect(p.row.total_amount, p.files[0]).toBeGreaterThan(0);
      expect(p.row.ordered_at! < todayJst(now), p.files[0]).toBe(true);
      expect(p.row.category, p.files[0]).toBeTruthy();
      expect(p.row.requires_presence, p.files[0]).toBe(false);
    }
  });
});
