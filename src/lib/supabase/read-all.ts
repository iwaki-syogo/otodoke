/** Rows per request. PostgREST answers at most this many rows, silently cutting the rest. */
const PAGE = 1000;

type PageResult<T> = { data: T[] | null; error: { message: string } | null; count: number | null };

export interface PageQuery<T> extends PromiseLike<PageResult<T>> {
  order(column: string, options?: { ascending?: boolean }): PageQuery<T>;
  range(from: number, to: number): PageQuery<T>;
}

/**
 * Reads every row of a query, past PostgREST's 1000-row cap.
 *
 * `build()` must return a fresh query each call: `select(..., { count: "exact" })`, the filters
 * and the caller's own order. readAll adds `id` as the last order, so rows that tie on the
 * caller's order cannot move between pages, then requests one range per page. The count from
 * the first page decides how many rows are read. Any failed page throws; it never returns a
 * partial or empty list in place of an error.
 */
export async function readAll<T>(build: () => PageQuery<T>): Promise<T[]> {
  const rows: T[] = [];
  let total: number | null = null;
  for (;;) {
    const from = rows.length;
    const { data, error, count } = await build().order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`readAll: ${error.message}`);
    if (total === null) {
      if (count === null) throw new Error("readAll: the query did not return a count; select with { count: \"exact\" }");
      total = count;
    }
    const page = data ?? [];
    rows.push(...page);
    if (rows.length >= total) return rows;
    // Fewer rows than the count promised and nothing new: the rows changed under us.
    if (page.length === 0) throw new Error(`readAll: expected ${total} rows, got ${rows.length}`);
  }
}
