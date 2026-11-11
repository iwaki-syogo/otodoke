/**
 * A small in-memory stand-in for the Supabase query builder, for tests only.
 *
 * It keeps rows per table, applies the filters the app uses (eq, neq, in, is, not, or, filter,
 * match, gt/gte/lt/lte), embeds related rows named in `select("..., parcel_items(name)")`, and
 * records every query so a test can check which conditions were sent. Like PostgREST, a read
 * without a range returns at most `maxRows` rows, and `neq` / `or(...neq...)` never match null.
 *
 * Hooks run before each query. A hook may change the stored rows (to play another writer that
 * saves in between) or return a result to answer the query itself (to inject an error).
 */

export type Row = Record<string, unknown>;

export interface Filter {
  method: string;
  args: unknown[];
}

export type Op = "select" | "insert" | "update" | "delete" | "upsert";

export interface Query {
  table: string;
  op: Op;
  /** Columns of a plain read. */
  columns: string | null;
  /** Columns asked back after a write (`.insert(...).select("id")`). */
  returning: string | null;
  values: unknown;
  filters: Filter[];
  orders: Array<{ column: string; ascending: boolean; nullsFirst?: boolean }>;
  range: [number, number] | null;
  limit: number | null;
  single: "single" | "maybeSingle" | null;
  count: string | null;
  head: boolean;
}

export interface Result {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

export type Hook = (q: Query, db: FakeDb) => Result | void;

type ClaimArgs = { p_user_id: string; p_user_limit: number; p_global_limit: number };

export interface RpcCall {
  name: string;
  args: unknown;
}

/** to-many: children whose `fk` points at the parent's id. to-one: the row the parent's `fk` points at. */
const RELATIONS: Record<string, Record<string, { many: boolean; table: string; fk: string }>> = {
  parcels: {
    parcel_items: { many: true, table: "parcel_items", fk: "parcel_id" },
    extractions: { many: true, table: "extractions", fk: "parcel_id" },
  },
  extractions: {
    emails: { many: false, table: "emails", fk: "email_id" },
    parcels: { many: false, table: "parcels", fk: "parcel_id" },
  },
  parcel_items: {
    parcels: { many: false, table: "parcels", fk: "parcel_id" },
  },
};

const PARCEL_DEFAULTS: Row = {
  carrier: null,
  category: null,
  category_source: null,
  expected_date: null,
  expected_date_end: null,
  expected_text: null,
  expected_window_end: null,
  expected_window_start: null,
  last_email_at: null,
  needs_review: false,
  order_number: null,
  ordered_at: null,
  presence_evidence: null,
  requires_presence: null,
  shop_key: null,
  source: "mail",
  status: "unknown",
  title: null,
  total_amount: null,
  tracking_number: null,
  tracking_url: null,
};

const DEFAULTS: Record<string, Row> = {
  parcels: PARCEL_DEFAULTS,
  emails: { classification: null, processing_status: "pending", error: null, sent_at: null, message_id: null, body_state: "plain", body_envelope: null, from_domain: null, forwarding_confirm_url: null },
  extractions: { parcel_id: null, confidence: null },
  parcel_items: { quantity: null, unit_price: null, evidence: null },
};

function isNil(v: unknown): boolean {
  return v === null || v === undefined;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function parseLiteral(v: string): unknown {
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

/** Same value for a filter: PostgREST sends values as text, so compare as text. */
function same(a: unknown, b: unknown): boolean {
  if (isNil(a) || isNil(b)) return false;
  return String(a) === String(b);
}

function matchOne(row: Row, column: string, op: string, value: unknown): boolean {
  const v = row[column];
  switch (op) {
    case "eq":
      return same(v, value);
    case "neq":
      return !isNil(v) && !same(v, value);
    case "is":
      return value === null ? isNil(v) : v === value;
    case "isdistinct":
      return isNil(value) ? !isNil(v) : isNil(v) || !same(v, value);
    case "in": {
      const list = Array.isArray(value)
        ? value
        : String(value)
            .replace(/^\(|\)$/g, "")
            .split(",")
            .map((s) => s.replace(/^"|"$/g, ""));
      return list.some((x) => same(v, x));
    }
    case "gt":
      return !isNil(v) && compare(v, value) > 0;
    case "gte":
      return !isNil(v) && compare(v, value) >= 0;
    case "lt":
      return !isNil(v) && compare(v, value) < 0;
    case "lte":
      return !isNil(v) && compare(v, value) <= 0;
    case "like":
    case "ilike": {
      if (isNil(v)) return false;
      const re = new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, op === "ilike" ? "i" : "");
      return re.test(String(v));
    }
    default:
      throw new Error(`fake-db: unsupported operator "${op}" on ${column}`);
  }
}

/** Split "a.eq.1,b.is.null" at top-level commas (not inside parentheses). */
function splitOr(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function matchOrPart(row: Row, part: string): boolean {
  // and(a,b): every inner part holds (PostgREST's and() inside or()).
  const grouped = part.trim().match(/^and\((.*)\)$/);
  if (grouped) return splitOr(grouped[1]).every((inner) => matchOrPart(row, inner));
  const m = part.trim().match(/^([\w.]+?)\.(not\.)?(eq|neq|is|isdistinct|in|gt|gte|lt|lte|like|ilike)\.(.*)$/);
  if (!m) throw new Error(`fake-db: unsupported or() part "${part}"`);
  const [, column, negate, op, raw] = m;
  const value = op === "in" ? raw : parseLiteral(raw);
  const hit = matchOne(row, column, op, value);
  if (!negate) return hit;
  // not.eq / not.is follow SQL: a null never satisfies a comparison.
  if (op === "is") return !hit;
  return !isNil(row[column]) && !hit;
}

function applyFilter(row: Row, f: Filter): boolean {
  const [a, b, c] = f.args;
  switch (f.method) {
    case "eq":
    case "neq":
    case "is":
    case "in":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "like":
    case "ilike":
      return matchOne(row, String(a), f.method, b);
    case "not": {
      const op = String(b);
      const value = op === "in" ? c : typeof c === "string" ? parseLiteral(c) : c;
      if (op === "is") return !matchOne(row, String(a), "is", value);
      return !isNil(row[String(a)]) && !matchOne(row, String(a), op, value);
    }
    case "filter": {
      const op = String(b);
      const value = typeof c === "string" && op !== "in" ? parseLiteral(c) : c;
      if (op.startsWith("not.")) {
        const inner = op.slice(4);
        return inner === "is" ? !matchOne(row, String(a), "is", value) : !isNil(row[String(a)]) && !matchOne(row, String(a), inner, value);
      }
      return matchOne(row, String(a), op, value);
    }
    case "match":
      return Object.entries(a as Row).every(([k, v]) => same(row[k], v));
    case "or":
      return splitOr(String(a)).some((part) => matchOrPart(row, part));
    default:
      throw new Error(`fake-db: unsupported filter "${f.method}"`);
  }
}

/** Embedded resources named in a select: "*, parcel_items(name)" or "result, emails!inner(sent_at)". */
function embedsOf(columns: string | null): Array<{ name: string; inner: boolean }> {
  if (!columns) return [];
  const out: Array<{ name: string; inner: boolean }> = [];
  const re = /(\w+)(!inner)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(columns))) out.push({ name: m[1], inner: Boolean(m[2]) });
  return out;
}

export class FakeDb {
  tables: Record<string, Row[]>;
  calls: Query[] = [];
  rpcCalls: RpcCall[] = [];
  hooks: Hook[] = [];
  /** PostgREST's max-rows: a read without a range never returns more. */
  maxRows = 1000;
  private seq = 0;
  private clock: number;

  /** `startMs`: where the clock behind tick() starts (default: a fixed past date). */
  constructor(seed: Record<string, Row[]> = {}, startMs: number = Date.parse("2026-11-03T00:00:00Z")) {
    this.clock = startMs;
    this.tables = {};
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = rows.map((r) => ({ ...(DEFAULTS[table] ?? {}), ...r }));
    }
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  find(table: string, id: string): Row | undefined {
    return this.rows(table).find((r) => r.id === id);
  }

  /** A timestamp later than any given before, like now() on each write. */
  tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  rpc(name: string, args?: unknown): Promise<Result> {
    this.rpcCalls.push({ name, args });
    if (name === "activate_user_key") return Promise.resolve(this.activateUserKey(args as { p_user_id: string; p_key_id: string; p_challenge_hash: string }));
    if (name === "activate_user_key_checked") {
      const a = args as { p_user_id: string; p_key_id: string; p_challenge_hash: string; p_expected_current_key_id: string | null };
      // supabase/migrations/20261106150000: the same, refused when the key in use is not the expected one.
      const keys = this.rows("user_keys").filter((k) => k.user_id === a.p_user_id);
      if (!keys.some((k) => k.key_id === a.p_key_id && isNil(k.activated_at) && k.challenge_hash === a.p_challenge_hash)) {
        return Promise.resolve({ data: null, error: { message: "activate_user_key: no matching key is waiting to be activated" } });
      }
      const current = keys.find((k) => !isNil(k.activated_at) && isNil(k.retired_at));
      if ((current?.key_id ?? null) !== a.p_expected_current_key_id) return Promise.resolve({ data: null, error: { message: "activate_user_key: the key in use changed" } });
      return Promise.resolve(this.activateUserKey(a));
    }
    if (name === "claim_claude_call") return Promise.resolve(this.claimClaudeCall(args as ClaimArgs, false));
    if (name === "claim_claude_call_v2" || name === "release_claude_call") {
      // Before supabase/pending/20261111100000_claude_call_release.sql is applied (or after its rollback).
      if (this.claudeReleaseMissing) return Promise.resolve({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` } });
      if (name === "claim_claude_call_v2") return Promise.resolve(this.claimClaudeCall(args as ClaimArgs, true));
      return Promise.resolve(this.releaseClaudeCall(args as { p_claim_id: number; p_user_id: string }));
    }
    return Promise.resolve({ data: "ok", error: null });
  }

  /** True: claim_claude_call_v2 and release_claude_call do not exist yet (PostgREST answers PGRST202). */
  claudeReleaseMissing = false;
  /** The clock the Claude allowance reads (now() in the functions). A test moves it across midnight. */
  claudeNow: () => number = () => Date.now();

  private jstDay(): string {
    return new Date(this.claudeNow() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /**
   * supabase/pending/20261111100000_claude_call_release.sql: claim_claude_call and claim_claude_call_v2
   * count the same row by the same rule (the day in Asia/Tokyo, the app-wide sum first, then the
   * person's row); v2 also records a claim and answers `[{ verdict, claim_id }]`. The real functions
   * are exercised on Postgres; this mirrors their rules.
   */
  private claimClaudeCall(a: ClaimArgs, v2: boolean): Result {
    const day = this.jstDay();
    const usage = this.rows("claude_usage_daily");
    const answer = (verdict: string, claimId: number | null): Result => ({ data: v2 ? [{ verdict, claim_id: claimId }] : verdict, error: null });
    if (usage.filter((r) => r.day === day).reduce((n, r) => n + Number(r.calls), 0) >= a.p_global_limit) return answer("global_limit", null);
    let row = usage.find((r) => r.user_id === a.p_user_id && r.day === day);
    if (!row) {
      row = { user_id: a.p_user_id, day, calls: 1 };
      usage.push(row);
    } else if (Number(row.calls) < a.p_user_limit) {
      row.calls = Number(row.calls) + 1;
    } else {
      return answer("user_limit", null);
    }
    if (!v2) return answer("ok", null);
    const id = this.rows("claude_call_claims").reduce((n, r) => Math.max(n, Number(r.id)), 0) + 1;
    this.rows("claude_call_claims").push({ id, user_id: a.p_user_id, day, claimed_at: new Date(this.claudeNow()).toISOString(), released_at: null });
    return answer("ok", id);
  }

  /** release_claude_call: once per claim, to the claim's own day, never below 0; 0 when there is nothing to give back. */
  private releaseClaudeCall(a: { p_claim_id: number; p_user_id: string }): Result {
    const claim = this.rows("claude_call_claims").find((r) => r.id === a.p_claim_id && r.user_id === a.p_user_id && isNil(r.released_at));
    if (!claim) return { data: 0, error: null };
    claim.released_at = new Date(this.claudeNow()).toISOString();
    const row = this.rows("claude_usage_daily").find((r) => r.user_id === a.p_user_id && r.day === claim.day);
    if (!row || Number(row.calls) <= 0) return { data: 0, error: null };
    row.calls = Number(row.calls) - 1;
    return { data: 1, error: null };
  }

  /**
   * supabase/migrations/20261106120000 activate_user_key, in one synchronous step like the one
   * database call: the pending key with this id and challenge hash is activated and the key in use
   * (if any) retired together. The real function is exercised on Postgres; this mirrors its rule.
   */
  private activateUserKey(a: { p_user_id: string; p_key_id: string; p_challenge_hash: string }): Result {
    const keys = this.rows("user_keys").filter((k) => k.user_id === a.p_user_id);
    const pending = keys.find((k) => k.key_id === a.p_key_id && isNil(k.activated_at) && k.challenge_hash === a.p_challenge_hash);
    if (!pending) return { data: null, error: { message: "activate_user_key: no matching key is waiting to be activated" } };
    const now = this.tick();
    for (const k of keys) if (!isNil(k.activated_at) && isNil(k.retired_at)) k.retired_at = now;
    pending.activated_at = now;
    return { data: a.p_key_id, error: null };
  }

  /** Queries on one table with one operation, in the order they ran. */
  callsOn(table: string, op?: Op): Query[] {
    return this.calls.filter((q) => q.table === table && (!op || q.op === op));
  }

  execute(q: Query): Result {
    this.calls.push(q);
    for (const hook of this.hooks) {
      const answer = hook(q, this);
      if (answer) return answer;
    }
    switch (q.op) {
      case "select":
        return this.read(q);
      case "insert":
      case "upsert":
        return this.insert(q);
      case "update":
        return this.update(q);
      case "delete":
        return this.remove(q);
    }
  }

  private matching(q: Query): Row[] {
    const top = q.filters.filter((f) => !this.isEmbeddedFilter(f));
    return this.rows(q.table).filter((row) => top.every((f) => applyFilter(row, f)));
  }

  private isEmbeddedFilter(f: Filter): boolean {
    return ["eq", "neq", "is", "in", "gt", "gte", "lt", "lte", "not", "filter"].includes(f.method) && String(f.args[0]).includes(".");
  }

  private withEmbeds(table: string, row: Row, q: Query): Row | null {
    const out: Row = { ...row };
    for (const { name, inner } of embedsOf(q.columns ?? q.returning)) {
      const rel = RELATIONS[table]?.[name];
      if (!rel) throw new Error(`fake-db: no relation ${table} -> ${name}`);
      const nested = q.filters
        .filter((f) => this.isEmbeddedFilter(f) && String(f.args[0]).startsWith(`${name}.`))
        .map((f) => ({ ...f, args: [String(f.args[0]).slice(name.length + 1), ...f.args.slice(1)] }));
      if (rel.many) {
        const children = this.rows(rel.table)
          .filter((c) => same(c[rel.fk], row.id))
          .filter((c) => nested.every((f) => applyFilter(c, f)))
          .map((c) => ({ ...c }));
        if (inner && children.length === 0) return null;
        out[name] = children;
      } else {
        const target = this.rows(rel.table).find((c) => same(c.id, row[rel.fk]));
        const ok = target && nested.every((f) => applyFilter(target, f));
        if (inner && !ok) return null;
        out[name] = ok ? { ...target } : null;
      }
    }
    return out;
  }

  private ordered(rows: Row[], q: Query): Row[] {
    if (q.orders.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const o of q.orders) {
        const x = a[o.column];
        const y = b[o.column];
        if (isNil(x) && isNil(y)) continue;
        const nullsFirst = o.nullsFirst ?? !o.ascending;
        if (isNil(x)) return nullsFirst ? -1 : 1;
        if (isNil(y)) return nullsFirst ? 1 : -1;
        const c = compare(x, y);
        if (c !== 0) return o.ascending ? c : -c;
      }
      return 0;
    });
  }

  private shape(q: Query, rows: Row[], total: number): Result {
    if (q.head) return { data: null, error: null, count: q.count ? total : null };
    const count = q.count ? total : null;
    if (q.single === "single") {
      if (rows.length !== 1) return { data: null, error: { message: `JSON object requested, multiple (or no) rows returned (${rows.length})` }, count };
      return { data: rows[0], error: null, count };
    }
    if (q.single === "maybeSingle") {
      if (rows.length > 1) return { data: null, error: { message: "multiple rows returned" }, count };
      return { data: rows[0] ?? null, error: null, count };
    }
    return { data: rows, error: null, count };
  }

  private read(q: Query): Result {
    const rows = this.matching(q)
      .map((r) => this.withEmbeds(q.table, r, q))
      .filter((r): r is Row => r !== null);
    const sorted = this.ordered(rows, q);
    let page = sorted;
    if (q.range) page = page.slice(q.range[0], q.range[1] + 1);
    if (q.limit !== null) page = page.slice(0, q.limit);
    page = page.slice(0, this.maxRows);
    return this.shape(q, page, rows.length);
  }

  private insert(q: Query): Result {
    const list = (Array.isArray(q.values) ? q.values : [q.values]) as Row[];
    const inserted = list.map((v) => {
      const stamp = this.tick();
      const row: Row = {
        ...(DEFAULTS[q.table] ?? {}),
        id: `${q.table}-new-${++this.seq}`,
        created_at: stamp,
        updated_at: stamp,
        ...v,
      };
      this.rows(q.table).push(row);
      return row;
    });
    if (!q.returning) return { data: null, error: null };
    return this.shape(
      q,
      inserted.map((r) => ({ ...r })),
      inserted.length,
    );
  }

  private update(q: Query): Result {
    const hits = this.matching(q);
    for (const row of hits) {
      Object.assign(row, q.values as Row);
      // parcels_set_updated_at: every update moves updated_at.
      if (q.table === "parcels") row.updated_at = this.tick();
    }
    if (!q.returning) return { data: null, error: null };
    return this.shape(
      q,
      hits.map((r) => ({ ...r })),
      hits.length,
    );
  }

  private remove(q: Query): Result {
    const hits = this.matching(q);
    this.tables[q.table] = this.rows(q.table).filter((r) => !hits.includes(r));
    if (!q.returning) return { data: null, error: null };
    return this.shape(
      q,
      hits.map((r) => ({ ...r })),
      hits.length,
    );
  }
}

export class FakeQuery implements PromiseLike<Result> {
  private q: Query;
  private done: Result | null = null;
  private throwOnErrorFlag = false;

  constructor(
    private db: FakeDb,
    table: string,
  ) {
    this.q = { table, op: "select", columns: null, returning: null, values: undefined, filters: [], orders: [], range: null, limit: null, single: null, count: null, head: false };
  }

  get query(): Query {
    return this.q;
  }

  select(columns = "*", opts: { count?: string; head?: boolean } = {}): this {
    if (this.q.op === "select") this.q.columns = columns;
    else this.q.returning = columns;
    if (opts.count) this.q.count = opts.count;
    if (opts.head) this.q.head = true;
    return this;
  }
  insert(values: unknown): this {
    this.q.op = "insert";
    this.q.values = values;
    return this;
  }
  upsert(values: unknown): this {
    this.q.op = "upsert";
    this.q.values = values;
    return this;
  }
  update(values: unknown): this {
    this.q.op = "update";
    this.q.values = values;
    return this;
  }
  delete(): this {
    this.q.op = "delete";
    return this;
  }

  private push(method: string, args: unknown[]): this {
    this.q.filters.push({ method, args });
    return this;
  }
  eq(column: string, value: unknown) {
    return this.push("eq", [column, value]);
  }
  neq(column: string, value: unknown) {
    return this.push("neq", [column, value]);
  }
  gt(column: string, value: unknown) {
    return this.push("gt", [column, value]);
  }
  gte(column: string, value: unknown) {
    return this.push("gte", [column, value]);
  }
  lt(column: string, value: unknown) {
    return this.push("lt", [column, value]);
  }
  lte(column: string, value: unknown) {
    return this.push("lte", [column, value]);
  }
  like(column: string, value: unknown) {
    return this.push("like", [column, value]);
  }
  ilike(column: string, value: unknown) {
    return this.push("ilike", [column, value]);
  }
  is(column: string, value: unknown) {
    return this.push("is", [column, value]);
  }
  in(column: string, values: unknown[]) {
    return this.push("in", [column, values]);
  }
  not(column: string, op: string, value: unknown) {
    return this.push("not", [column, op, value]);
  }
  or(expr: string, opts?: { foreignTable?: string; referencedTable?: string }) {
    if (opts?.foreignTable || opts?.referencedTable) throw new Error("fake-db: or() on an embedded table is not supported");
    return this.push("or", [expr]);
  }
  filter(column: string, op: string, value: unknown) {
    return this.push("filter", [column, op, value]);
  }
  match(values: Row) {
    return this.push("match", [values]);
  }
  order(column: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    this.q.orders.push({ column, ascending: opts.ascending ?? true, nullsFirst: opts.nullsFirst });
    return this;
  }
  limit(n: number): this {
    this.q.limit = n;
    return this;
  }
  range(from: number, to: number): this {
    this.q.range = [from, to];
    return this;
  }
  single(): this {
    this.q.single = "single";
    return this;
  }
  maybeSingle(): this {
    this.q.single = "maybeSingle";
    return this;
  }
  abortSignal(): this {
    return this;
  }
  returns(): this {
    return this;
  }
  throwOnError(): this {
    this.throwOnErrorFlag = true;
    return this;
  }

  then<A = Result, B = never>(onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    try {
      this.done ??= this.db.execute(this.q);
      if (this.throwOnErrorFlag && this.done.error) throw new Error(this.done.error.message);
      return Promise.resolve(this.done).then(onfulfilled, onrejected);
    } catch (err) {
      return Promise.reject(err).then(onfulfilled, onrejected);
    }
  }
}

/** A filter that limits the query to one user's rows. */
export function scopedToUser(q: Query, userId: string): boolean {
  return q.filters.some(
    (f) =>
      (f.method === "eq" && f.args[0] === "user_id" && f.args[1] === userId) ||
      (f.method === "match" && (f.args[0] as Row).user_id === userId),
  );
}

/** A filter on an embedded table's user_id, e.g. `.eq("parcel_items.user_id", userId)`. */
export function embedScopedToUser(q: Query, relation: string, userId: string): boolean {
  return q.filters.some((f) => f.method === "eq" && f.args[0] === `${relation}.user_id` && f.args[1] === userId);
}

/** Human-readable form of a query, for failure messages. */
export function describeQuery(q: Query): string {
  const filters = q.filters.map((f) => `.${f.method}(${f.args.map((a) => JSON.stringify(a)).join(", ")})`).join("");
  const what = q.op === "select" ? `select(${JSON.stringify(q.columns)})` : `${q.op}(${JSON.stringify(q.values)?.slice(0, 80)})`;
  return `${q.table}.${what}${filters}`;
}
