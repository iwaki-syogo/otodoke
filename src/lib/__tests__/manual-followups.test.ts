import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeIntoManual, type ParcelRow } from "@/lib/match";
import { processInboundEmail } from "@/lib/pipeline";
import { ManualParcelSchema, manualParcelFields, manualParcelSchemaFor, type ManualFormState } from "@/lib/manual-parcel";
import { manualFormDefaults, manualStatusChoices } from "@/app/app/parcels/manual-form";
import { FakeDb } from "./fake-db";
import { USER, asAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * Two follow-ups on parcels typed in by hand:
 * (a) a cancel notice moves a typed-in parcel to cancelled, and its edit form can then save it as is;
 * (b) saving an edit without changing the category leaves who set it (category_source) alone.
 */

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    RedirectSignal,
    state: { db: null as unknown, user: null as { id: string } | null },
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new mocks.RedirectSignal(url);
  }),
  notFound: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const db = mocks.state.db as FakeDb;
    return Object.assign(db, { auth: { getUser: async () => ({ data: { user: mocks.state.user }, error: null }) } });
  },
  getUser: async () => mocks.state.user,
}));

const { updateManualParcel } = await import("@/app/app/parcels/manual-actions");

const T = "123456789012";
const NOW = new Date("2026-11-03T03:00:00Z");
const MANUAL_ID = "11111111-1111-4111-8111-111111111111";

const typedIn = (over: Record<string, unknown> = {}) =>
  ({
    id: MANUAL_ID,
    user_id: USER,
    source: "manual",
    title: "手入力の品名",
    shop: "手入力の店",
    shop_key: "other",
    ordered_at: "2026-11-01",
    expected_date: null,
    total_amount: 3000,
    category: "hobby",
    category_source: "user",
    tracking_number: T,
    tracking_url: null,
    carrier: null,
    requires_presence: null,
    status: "shipped",
    last_email_at: "2026-11-01T00:00:00Z",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...over,
  }) as unknown as ParcelRow;

const cancelNotice = reading({ relevance: "cancelled", tracking_number: sure("1234-5678-9012") });

async function save(values: Record<string, string>): Promise<ManualFormState | "redirected"> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  try {
    return await updateManualParcel({ error: null, values: {} }, fd);
  } catch (err) {
    if (err instanceof mocks.RedirectSignal) return "redirected";
    throw err;
  }
}

describe("(a) a cancel notice on a typed-in parcel", () => {
  it("moves it to cancelled", () => {
    expect(mergeIntoManual(typedIn({ status: "ordered" }), cancelNotice, "2026-11-03T01:00:00Z").status).toBe("cancelled");
    expect(mergeIntoManual(typedIn({ status: "shipped" }), cancelNotice, "2026-11-03T01:00:00Z").status).toBe("cancelled");
  });

  it("still keeps the typed values", () => {
    const u = mergeIntoManual(typedIn(), cancelNotice, "2026-11-03T01:00:00Z");
    expect(u).not.toHaveProperty("title");
    expect(u).not.toHaveProperty("shop");
    expect(u).not.toHaveProperty("category");
  });

  it("reaches the parcel through the pipeline", async () => {
    const db = new FakeDb({ parcels: [typedIn({ status: "shipped" }) as unknown as Record<string, unknown>] });
    await processInboundEmail(asAdmin(db), mailOf("2026-11-03T01:00:00Z"), { precomputed: precomputed(cancelNotice) });
    const row = db.find("parcels", MANUAL_ID)!;
    expect(row.status).toBe("cancelled");
    expect(row.title).toBe("手入力の品名");
    expect(row.total_amount).toBe(3000);
  });
});

describe("(a) the edit form of a cancelled typed-in parcel", () => {
  it("offers キャンセル only while the parcel is cancelled, and starts on it", () => {
    expect(manualStatusChoices("cancelled")).toContain("cancelled");
    expect(manualStatusChoices("shipped")).not.toContain("cancelled");
    expect(manualStatusChoices("ordered")).not.toContain("cancelled");
    expect(manualFormDefaults(typedIn({ status: "cancelled" }), "2026-11-03").status).toBe("cancelled");
  });

  it("keeps offering 配達中 and 不在・再配達 the same way", () => {
    expect(manualStatusChoices("out_for_delivery")).toContain("out_for_delivery");
    expect(manualStatusChoices("attempted")).toContain("attempted");
    expect(manualStatusChoices("shipped")).toEqual(["ordered", "shipped", "delivered"]);
  });

  it("parses cancelled only for a parcel that is cancelled now", () => {
    const form = manualFormDefaults(typedIn({ status: "cancelled" }), "2026-11-03");
    expect(manualParcelSchemaFor("cancelled").safeParse(form).success).toBe(true);
    expect(manualParcelSchemaFor("shipped").safeParse(form).success).toBe(false);
    expect(manualParcelSchemaFor(null).safeParse(form).success).toBe(false);
    expect(ManualParcelSchema.safeParse(form).success).toBe(false);
  });
});

const form = (over: Record<string, string> = {}) => ({
  id: MANUAL_ID,
  title: "手入力の品名",
  shop: "手入力の店",
  ordered_at: "2026-11-01",
  expected_date: "",
  total_amount: "3000",
  category: "hobby",
  tracking_number: T,
  carrier: "auto",
  presence: "",
  status: "shipped",
  ...over,
});

describe("updateManualParcel with the stored status and category", () => {
  let db: FakeDb;
  const seed = (over: Record<string, unknown>) => {
    db = new FakeDb({ parcels: [typedIn(over) as unknown as Record<string, unknown>] });
    mocks.state.db = db;
  };
  beforeEach(() => {
    mocks.state.user = { id: USER };
  });

  it("(a) saves a cancelled typed-in parcel unchanged", async () => {
    seed({ status: "cancelled" });
    expect(await save(form({ status: "cancelled", title: "直した品名" }))).toBe("redirected");
    const row = db.find("parcels", MANUAL_ID)!;
    expect(row.status).toBe("cancelled");
    expect(row.title).toBe("直した品名");
  });

  it("(a) refuses to make a parcel cancelled from the form", async () => {
    seed({ status: "shipped" });
    const out = await save(form({ status: "cancelled" }));
    expect(out).not.toBe("redirected");
    expect((out as ManualFormState).error).toBeTruthy();
    expect(db.find("parcels", MANUAL_ID)!.status).toBe("shipped");
    expect(db.callsOn("parcels", "update")).toHaveLength(0);
  });

  it("(a) answers 「見つかりません」 for a parcel that is not typed in", async () => {
    seed({ source: "mail", status: "cancelled" });
    const out = await save(form({ status: "cancelled" }));
    expect((out as ManualFormState).error).toContain("見つかりません");
    expect(db.callsOn("parcels", "update")).toHaveLength(0);
  });

  it("(b) keeps an automatic category automatic when it is saved as it was", async () => {
    seed({ category: "food", category_source: "auto" });
    expect(await save(form({ category: "food", title: "直した品名" }))).toBe("redirected");
    const row = db.find("parcels", MANUAL_ID)!;
    expect(row.title).toBe("直した品名");
    expect(row.category).toBe("food");
    expect(row.category_source).toBe("auto");
    const [update] = db.callsOn("parcels", "update");
    expect(update.values).not.toHaveProperty("category");
    expect(update.values).not.toHaveProperty("category_source");
  });

  it("(b) records a changed category as the user's", async () => {
    seed({ category: "food", category_source: "auto" });
    await save(form({ category: "beauty" }));
    const row = db.find("parcels", MANUAL_ID)!;
    expect(row.category).toBe("beauty");
    expect(row.category_source).toBe("user");
  });

  it("(b) clears an automatic category when it is emptied", async () => {
    seed({ category: "food", category_source: "auto" });
    await save(form({ category: "" }));
    const row = db.find("parcels", MANUAL_ID)!;
    expect(row.category).toBeNull();
    expect(row.category_source).toBeNull();
  });

  it("(b) writes no category when none was stored and none is sent", async () => {
    seed({ category: null, category_source: null });
    await save(form({ category: "" }));
    const [update] = db.callsOn("parcels", "update");
    expect(update.values).not.toHaveProperty("category");
    expect(update.values).not.toHaveProperty("category_source");
  });
});

describe("(b) manualParcelFields with the stored category", () => {
  const parsed = (category: string) => {
    const r = ManualParcelSchema.safeParse({ title: "品名", shop: "店", status: "ordered", category });
    if (!r.success) throw new Error(r.error.message);
    return r.data;
  };

  it("leaves both category columns out when the category is unchanged", () => {
    const f = manualParcelFields(parsed("food"), NOW, { category: "food" });
    expect(f).not.toHaveProperty("category");
    expect(f).not.toHaveProperty("category_source");
  });

  it("writes the category as the user's when it changed", () => {
    const f = manualParcelFields(parsed("hobby"), NOW, { category: "food" });
    expect(f.category).toBe("hobby");
    expect(f.category_source).toBe("user");
  });

  it("writes both when nothing is known of the stored value (a new parcel)", () => {
    const f = manualParcelFields(parsed("hobby"), NOW);
    expect(f.category).toBe("hobby");
    expect(f.category_source).toBe("user");
  });
});
