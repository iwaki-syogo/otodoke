import { describe, expect, it, vi } from "vitest";
import type { ParcelRow } from "@/lib/match";
import { FakeDb } from "./fake-db";

/**
 * Review R2-4, the Server Action: a typed-in parcel's empty amount that a mail filled in above the
 * typing bound (12,000,000) is saved back unchanged from its edit form. The action reads the
 * stored amount and gives it to manualParcelSchemaFor.
 */

const USER = { id: "00000000-0000-4000-8000-00000000000a" };
const MANUAL_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return { RedirectSignal, state: { db: null as unknown } };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.RedirectSignal(url);
  },
  notFound: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: USER }, error: null }) } }),
  getUser: async () => USER,
}));

const { updateManualParcel } = await import("@/app/app/parcels/manual-actions");
const { manualFormDefaults } = await import("@/app/app/parcels/manual-form");

const stored = {
  id: MANUAL_ID,
  user_id: USER.id,
  source: "manual",
  title: "手入力の品名",
  shop: "手入力の店",
  shop_key: "other",
  ordered_at: "2026-11-01",
  expected_date: null,
  total_amount: 12_000_000,
  category: null,
  category_source: null,
  tracking_number: "123456789012",
  tracking_url: null,
  carrier: "ヤマト運輸",
  requires_presence: null,
  status: "ordered",
  last_email_at: "2026-11-05T01:00:00Z",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-05T01:00:00Z",
};

async function save(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  try {
    return await updateManualParcel({ error: null, values: {} }, fd);
  } catch (err) {
    if (err instanceof mocks.RedirectSignal) return "redirected";
    throw err;
  }
}

describe("saving the edit form of a typed-in parcel whose amount a mail filled in", () => {
  it("saves it unchanged", async () => {
    const db = new FakeDb({ parcels: [{ ...stored }] });
    mocks.state.db = db;
    const values = { ...manualFormDefaults(stored as unknown as ParcelRow, "2026-11-06"), id: MANUAL_ID, updated_at: stored.updated_at, expected_date: "2026-11-09" };
    expect(await save(values)).toBe("redirected");
    expect(db.find("parcels", MANUAL_ID)).toMatchObject({ total_amount: 12_000_000, expected_date: "2026-11-09" });
  });

  it("still refuses a changed amount above the typing bound", async () => {
    const db = new FakeDb({ parcels: [{ ...stored }] });
    mocks.state.db = db;
    const values = { ...manualFormDefaults(stored as unknown as ParcelRow, "2026-11-06"), id: MANUAL_ID, updated_at: stored.updated_at, total_amount: "13000000" };
    expect(await save(values)).toMatchObject({ error: "金額が正しくありません" });
    expect(db.find("parcels", MANUAL_ID)).toMatchObject({ total_amount: 12_000_000 });
  });
});
