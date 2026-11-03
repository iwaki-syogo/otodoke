import { describe, expect, it } from "vitest";
import { readAll } from "@/lib/supabase/read-all";

/**
 * readAll(build) reads every row of a query past PostgREST's 1000-row cap.
 *
 * Contract pinned here:
 * - `build()` returns a fresh query (select with `{ count: "exact" }`, filters and the caller's
 *   own order). readAll calls it once per page, adds `.order("id")` as the LAST order so rows
 *   that tie on the caller's order cannot move between pages, then `.range(from, to)`.
 * - The count from the first page decides how many pages are read.
 * - Any page that answers with an error throws; nothing is turned into an empty list.
 */

interface Row {
  id: string;
  ordered_at: string | null;
}

type Page = { data: Row[] | null; error: { message: string } | null; count: number | null };

/** Rows whose order is not fully fixed come back shuffled differently on every request, as in Postgres. */
function server(rows: Row[], opts: { failOnCall?: number; cap?: number } = {}) {
  const cap = opts.cap ?? 1000;
  const log: Array<{ orders: Array<{ column: string; ascending: boolean }>; range: [number, number] | null }> = [];
  let calls = 0;

  function build() {
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let range: [number, number] | null = null;
    let used = false;
    const q = {
      order(column: string, o: { ascending?: boolean } = {}) {
        orders.push({ column, ascending: o.ascending ?? true });
        return q;
      },
      range(from: number, to: number) {
        range = [from, to];
        return q;
      },
      then<A, B = never>(ok?: ((v: Page) => A | PromiseLike<A>) | null, ng?: ((e: unknown) => B | PromiseLike<B>) | null) {
        if (used) return Promise.reject(new Error("a query is sent once; build a new one per page")).then(ok, ng);
        used = true;
        const call = ++calls;
        log.push({ orders: [...orders], range });
        if (opts.failOnCall === call) return Promise.resolve<Page>({ data: null, error: { message: "boom" }, count: null }).then(ok, ng);
        // Tie-break with a different seeded shuffle per request.
        let seed = call * 7919;
        const noise = new Map(rows.map((r) => [r.id, (seed = (seed * 48271) % 2147483647)]));
        const sorted = [...rows].sort((a, b) => {
          for (const o of orders) {
            const x = a[o.column as keyof Row] ?? "";
            const y = b[o.column as keyof Row] ?? "";
            if (x !== y) return (x < y ? -1 : 1) * (o.ascending ? 1 : -1);
          }
          return noise.get(a.id)! - noise.get(b.id)!;
        });
        const [from, to] = range ?? [0, rows.length - 1];
        const data = sorted.slice(from, Math.min(to + 1, from + cap));
        return Promise.resolve<Page>({ data, error: null, count: rows.length }).then(ok, ng);
      },
    };
    return q;
  }

  return { build: () => build().order("ordered_at", { ascending: false }), log, calls: () => calls };
}

/** 2,500 rows on only five order dates, so most rows tie and many ties cross a page boundary. */
function rowsOn(n: number): Row[] {
  const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", null];
  return Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(5, "0")}`, ordered_at: days[i % days.length] }));
}

type Build = Parameters<typeof readAll>[0];

describe("readAll", () => {
  it("returns every row of a 2,500-row result, in pages of 1000", async () => {
    const rows = rowsOn(2500);
    const s = server(rows);
    const got = (await readAll(s.build as unknown as Build)) as Row[];
    expect(got).toHaveLength(2500);
    expect(new Set(got.map((r) => r.id)).size).toBe(2500);
    expect(s.log.map((l) => l.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("reads 1001 rows in two pages", async () => {
    const s = server(rowsOn(1001));
    const got = (await readAll(s.build as unknown as Build)) as Row[];
    expect(new Set(got.map((r) => r.id)).size).toBe(1001);
    expect(s.calls()).toBe(2);
  });

  it("adds id as the last order, so ties on the caller's order neither repeat nor go missing", async () => {
    const rows = rowsOn(2500);
    const s = server(rows);
    const got = (await readAll(s.build as unknown as Build)) as Row[];
    for (const l of s.log) {
      expect(l.orders[0]).toEqual({ column: "ordered_at", ascending: false });
      expect(l.orders.at(-1)?.column).toBe("id");
    }
    // The caller's order is kept, ties broken by id.
    const expected = [...rows].sort((a, b) => {
      const x = a.ordered_at ?? "";
      const y = b.ordered_at ?? "";
      if (x !== y) return x < y ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });
    expect(got.map((r) => r.id)).toEqual(expected.map((r) => r.id));
  });

  it("returns an empty list for no rows, after one request", async () => {
    const s = server([]);
    expect(await readAll(s.build as unknown as Build)).toEqual([]);
    expect(s.calls()).toBe(1);
  });

  it("throws when a later page fails, instead of returning what it had", async () => {
    const s = server(rowsOn(2500), { failOnCall: 2 });
    await expect(readAll(s.build as unknown as Build)).rejects.toThrow();
  });

  it("throws when the first page fails, instead of returning an empty list", async () => {
    const s = server(rowsOn(10), { failOnCall: 1 });
    await expect(readAll(s.build as unknown as Build)).rejects.toThrow();
  });
});
