import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeIntoManual, type ParcelRow } from "@/lib/match";
import { processInboundEmail } from "@/lib/pipeline";
import { CARRIERS } from "@/lib/carriers";
import {
  MANUAL_KEEP_CARRIER,
  ManualParcelSchema,
  manualCarrierChoice,
  manualParcelFields,
  manualParcelRow,
  manualParcelSchemaFor,
  type ManualFormState,
} from "@/lib/manual-parcel";
import { manualFormDefaults, manualStatusChoices } from "@/app/app/parcels/manual-form";
import { FakeDb } from "./fake-db";
import { USER, asConsentingAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

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
    await processInboundEmail(asConsentingAdmin(db), mailOf("2026-11-03T01:00:00Z"), { precomputed: precomputed(cancelNotice) });
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
    expect(manualStatusChoices("shipped")).toEqual(["ordered", "shipped", "delivered", "received"]);
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
  updated_at: "2026-11-01T00:00:00Z",
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

/**
 * Review follow-ups on saving an edit: a save compares with what is stored, so what a mail added
 * stays when the person did not change the field it belongs to ([M1] [S1] [QA-4] [SEC-N2]).
 */
describe("saving an edit keeps what a mail added to unchanged fields", () => {
  let db: FakeDb;
  const seed = (over: Record<string, unknown>) => {
    db = new FakeDb({ parcels: [typedIn(over) as unknown as Record<string, unknown>] });
    mocks.state.db = db;
    return typedIn(over);
  };
  /** The edit form as it starts for this row, with the person's changes. */
  const formOf = (row: ParcelRow, over: Record<string, string> = {}): Record<string, string> => ({ id: MANUAL_ID, updated_at: row.updated_at, ...manualFormDefaults(row, "2026-11-03"), ...over });
  const stored = () => db.find("parcels", MANUAL_ID)!;
  beforeEach(() => {
    mocks.state.user = { id: USER };
  });

  const ranged = {
    expected_date: "2026-11-05",
    expected_date_end: "2026-11-07",
    expected_window_start: "14:00",
    expected_window_end: "16:00",
    expected_text: "11月5日から7日",
  };

  it("[M1] clears the range, time and wording when the date is changed", async () => {
    const row = seed(ranged);
    expect(await save(formOf(row, { expected_date: "2026-11-10" }))).toBe("redirected");
    const p = stored();
    expect(p.expected_date).toBe("2026-11-10");
    expect(p.expected_date_end).toBeNull();
    expect(p.expected_window_start).toBeNull();
    expect(p.expected_window_end).toBeNull();
    expect(p.expected_text).toBeNull();
  });

  it("[M1] clears them too when the date is emptied", async () => {
    const row = seed(ranged);
    await save(formOf(row, { expected_date: "" }));
    const p = stored();
    expect(p.expected_date).toBeNull();
    expect(p.expected_date_end).toBeNull();
    expect(p.expected_text).toBeNull();
  });

  it("[M1] keeps them when the date is not changed", async () => {
    const row = seed(ranged);
    expect(await save(formOf(row, { title: "直した品名" }))).toBe("redirected");
    const p = stored();
    expect(p.title).toBe("直した品名");
    expect(p).toMatchObject(ranged);
  });

  const tracked = { tracking_number: T, carrier: CARRIERS.sagawa.name, tracking_url: "https://example.test/track/123456789012" };

  it("[S1] keeps the tracking URL when the number and carrier are not changed", async () => {
    const row = seed(tracked);
    await save(formOf(row, { title: "直した品名" }));
    expect(stored()).toMatchObject(tracked);
  });

  it("[S1] keeps the tracking URL when the number is sent in another spelling", async () => {
    const row = seed(tracked);
    await save(formOf(row, { tracking_number: "1234-5678-9012" }));
    expect(stored()).toMatchObject(tracked);
  });

  it("[S1] drops the tracking URL when the number changes", async () => {
    const row = seed(tracked);
    await save(formOf(row, { tracking_number: "999988887777" }));
    const p = stored();
    expect(p.tracking_number).toBe("999988887777");
    expect(p.tracking_url).toBeNull();
  });

  it("[S1] drops the tracking URL when the carrier changes", async () => {
    const row = seed(tracked);
    await save(formOf(row, { carrier: "yamato" }));
    const p = stored();
    expect(p.carrier).toBe(CARRIERS.yamato.name);
    expect(p.tracking_url).toBeNull();
  });

  it("[S1] offers a carrier name outside the five as its own choice and keeps it", async () => {
    const other = { tracking_number: T, carrier: "テスト配送", tracking_url: "https://example.test/track/other" };
    const row = seed(other);
    const form = formOf(row, { title: "直した品名" });
    expect(form.carrier).toBe(MANUAL_KEEP_CARRIER);
    expect(ManualParcelSchema.safeParse(form).success).toBe(true);
    await save(form);
    expect(stored()).toMatchObject(other);
  });

  it("[S1] replaces a carrier name outside the five only when another is picked", async () => {
    const row = seed({ tracking_number: T, carrier: "テスト配送", tracking_url: "https://example.test/track/other" });
    await save(formOf(row, { carrier: "sagawa" }));
    const p = stored();
    expect(p.carrier).toBe(CARRIERS.sagawa.name);
    expect(p.tracking_url).toBeNull();
  });

  it("[S1] reads a stored carrier name the number itself gives as 自動判定", () => {
    expect(manualCarrierChoice(CARRIERS.amazon.name, "TBA123456789012")).toBe("auto");
    expect(manualCarrierChoice(null, T)).toBe("auto");
    expect(manualCarrierChoice(CARRIERS.sagawa.name, T)).toBe("sagawa");
    expect(manualCarrierChoice("テスト配送", T)).toBe(MANUAL_KEEP_CARRIER);
  });

  it("[S1] keeps the evidence of how it is received when that is not changed", async () => {
    const row = seed({ requires_presence: true, presence_evidence: "対面でお渡しします" });
    await save(formOf(row, { title: "直した品名" }));
    const p = stored();
    expect(p.requires_presence).toBe(true);
    expect(p.presence_evidence).toBe("対面でお渡しします");
  });

  it("[S1] drops that evidence when the way of receiving changes", async () => {
    const row = seed({ requires_presence: true, presence_evidence: "対面でお渡しします" });
    await save(formOf(row, { presence: "drop" }));
    const p = stored();
    expect(p.requires_presence).toBe(false);
    expect(p.presence_evidence).toBeNull();
  });

  it("[QA-4] keeps the stored order date when it is emptied on edit", async () => {
    const row = seed({ ordered_at: "2026-10-01" });
    await save(formOf(row, { ordered_at: "" }));
    expect(stored().ordered_at).toBe("2026-10-01");
  });

  it("[QA-4] still starts a new parcel's empty order date as today", () => {
    const r = ManualParcelSchema.safeParse({ title: "品名", shop: "店", status: "ordered", ordered_at: "" });
    if (!r.success) throw new Error(r.error.message);
    expect(manualParcelRow(r.data, NOW).ordered_at).toBe("2026-11-03");
  });

  it("[SEC-N2] limits the read and the write to the signed-in user", async () => {
    const row = seed({});
    await save(formOf(row, { title: "直した品名" }));
    const queries = [...db.callsOn("parcels", "select"), ...db.callsOn("parcels", "update")];
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const q of queries) expect(q.filters).toContainEqual({ method: "eq", args: ["user_id", USER] });
  });

  it("[SEC-N2] answers 見つかりません for another user's parcel", async () => {
    const row = seed({ user_id: "00000000-0000-4000-8000-0000000000ff" });
    const out = await save(formOf(row, { title: "直した品名" }));
    expect((out as ManualFormState).error).toContain("見つかりません");
    expect(db.callsOn("parcels", "update")).toHaveLength(0);
  });
});
