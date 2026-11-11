import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("presence badge on delivered parcels", () => {
  it("showsPresence is false for delivered and true for the other states", async () => {
    const { showsPresence } = await import("@/app/app/parcel-card");
    expect(showsPresence({ status: "delivered" })).toBe(false);
    for (const status of ["ordered", "shipped", "out_for_delivery"] as const) {
      expect(showsPresence({ status } as never)).toBe(true);
    }
  });

  it("the detail page and the list card both gate the badge with showsPresence", () => {
    const page = read("src/app/app/parcels/[id]/page.tsx");
    const card = read("src/app/app/parcel-card.tsx");
    expect(page).toMatch(/showsPresence\(parcel\)\s*\?\s*<PresenceBadge/);
    expect(card).toMatch(/showsPresence\(parcel\)\s*\?\s*<PresenceBadge/);
  });
});
