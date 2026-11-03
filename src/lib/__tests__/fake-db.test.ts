import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";

/** The in-memory database behaves like PostgREST where the pipeline tests depend on it. */
describe("FakeDb", () => {
  const seed = () =>
    new FakeDb({
      parcels: [
        { id: "a", user_id: "u1", category: null, category_source: null, updated_at: "2026-11-01T00:00:00Z" },
        { id: "b", user_id: "u1", category: "hobby", category_source: "user", updated_at: "2026-11-01T00:00:00Z" },
        { id: "c", user_id: "u2", category: "food", category_source: "auto", updated_at: "2026-11-01T00:00:00Z" },
      ],
      parcel_items: [
        { id: "i1", user_id: "u1", parcel_id: "a", name: "自分の品目" },
        { id: "i2", user_id: "u2", parcel_id: "a", name: "他人の品目" },
      ],
    });

  it("filters an embedded table without dropping the parent", async () => {
    const db = seed();
    const { data } = await db.from("parcels").select("*, parcel_items(name)").eq("user_id", "u1").eq("parcel_items.user_id", "u1");
    const a = (data as Array<{ id: string; parcel_items: Array<{ name: string }> }>).find((r) => r.id === "a")!;
    expect(a.parcel_items.map((i) => i.name)).toEqual(["自分の品目"]);
    expect((data as unknown[]).length).toBe(2);
  });

  it("treats null as distinct from 'user' in or(), and neq as never matching null", async () => {
    const db = seed();
    await db.from("parcels").update({ category: "daily", category_source: "auto" }).or("category_source.is.null,category_source.neq.user");
    expect(db.find("parcels", "a")!.category).toBe("daily");
    expect(db.find("parcels", "b")!.category).toBe("hobby");
    expect(db.find("parcels", "c")!.category).toBe("daily");

    const db2 = seed();
    await db2.from("parcels").update({ category: "daily" }).neq("category_source", "user");
    expect(db2.find("parcels", "a")!.category).toBeNull();
  });

  it("moves updated_at on every parcels update, so a stale updated_at matches nothing", async () => {
    const db = seed();
    await db.from("parcels").update({ title: "x" }).eq("id", "a");
    const { data } = await db.from("parcels").update({ title: "y" }).eq("id", "a").eq("updated_at", "2026-11-01T00:00:00Z").select("id");
    expect(data).toEqual([]);
    expect(db.find("parcels", "a")!.title).toBe("x");
  });

  it("returns at most 1000 rows without a range, and the exact count when asked", async () => {
    const db = new FakeDb({ parcels: Array.from({ length: 1500 }, (_, i) => ({ id: `p${i}`, user_id: "u1" })) });
    const { data } = await db.from("parcels").select("*").eq("user_id", "u1");
    expect((data as unknown[]).length).toBe(1000);
    const { count } = await db.from("parcels").select("id", { count: "exact", head: true }).eq("user_id", "u1");
    expect(count).toBe(1500);
    const { data: page } = await db.from("parcels").select("*").order("id").range(1000, 1999);
    expect((page as unknown[]).length).toBe(500);
  });

  it("records every query", async () => {
    const db = seed();
    await db.from("parcels").delete().in("id", ["a"]).eq("user_id", "u1");
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].filters).toEqual([
      { method: "in", args: ["id", ["a"]] },
      { method: "eq", args: ["user_id", "u1"] },
    ]);
    expect(db.find("parcels", "a")).toBeUndefined();
  });
});
