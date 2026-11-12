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

import { readFileSync } from "node:fs";

/** Read the real gateway contract so pipeline tests cannot silently accept an SQL-rejected column. */
const mailRunSql = readFileSync(new URL("../../../supabase/migrations/20261113100000_parcel_write_conflicts.sql", import.meta.url), "utf8");
export const MAIL_RUN_ALLOWED_COLUMNS = new Map(
  [...mailRunSql.matchAll(/when '(emails|extractions|parcel_items|parcels)' then[\s\S]*?v_allow := array\[([\s\S]*?)\];/g)]
    .map((match) => [match[1], new Set([...match[2].matchAll(/'([^']+)'/g)].map((column) => column[1]))] as const),
);
if (MAIL_RUN_ALLOWED_COLUMNS.size !== 4) throw new Error("fake-db: could not read all mail gateway column allowlists");

/** The fake reads the database's one retention constant; it never keeps a second period. */
let consentWaitingRetention: number | null = null;
export function consentWaitingRetentionMs(): number {
  if (consentWaitingRetention !== null) return consentWaitingRetention;
  const sql = readFileSync(new URL("../../../supabase/migrations/20261113120000_consent_waiting_storage.sql", import.meta.url), "utf8");
  const body = sql.match(/function public\.ai_consent_waiting_retention\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$/i)?.[1];
  const days = body?.match(/interval\s+'(\d+) days'/i);
  if (!days || Number(days[1]) <= 0) throw new Error("fake-db: could not read consent-waiting retention");
  consentWaitingRetention = Number(days[1]) * 24 * 3600_000;
  return consentWaitingRetention;
}

/** Derive the fake's policy from the real SQL function instead of a second behavioral constant. */
function parcelReceiptRetentionMs(): number {
  const sql = readFileSync(new URL("../../../supabase/migrations/20261113130000_received_receipts.sql", import.meta.url), "utf8");
  const body = sql.match(/function public\.parcel_receipt_retention\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$/i)?.[1];
  const hours = body?.match(/interval '([0-9]+) hours'/i);
  if (!hours || Number(hours[1]) <= 0) throw new Error("fake-db: could not read receipt retention");
  return Number(hours[1]) * 3600_000;
}

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
  mailRun?: { emailId: string; runId: string };
  /** A query simulated inside an RPC, not another HTTP round trip. */
  viaRpc?: boolean;
  requestHeaders?: Record<string, string>;
}

export interface Result {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

export type Hook = (q: Query, db: FakeDb) => Result | void;

type CreateParcelArgs = { p_email_id:string; p_run_id:string; p_snapshot:Array<{id:string;updated_at:string;item_names:string[]}>;p_values:Row;p_items:Row[] };
type UpdateParcelArgs = CreateParcelArgs & {p_parcel_id:string;p_expected_updated_at:string;p_category:Row|null};
type EnsureItemsArgs = { p_email_id:string; p_run_id:string; p_parcel_id:string;p_expected_updated_at:string;p_items:Row[] };
type StoreArgs = { p_user_id: string; p_email_id: string; p_run_id: string; p_columns: Row; p_expected_created_at: string | null; p_limits: { user_count:number; global_count:number; user_bytes:number; global_bytes:number } };
type OwnedArgs = { p_email_id:string; p_run_id:string; p_table:string; p_operation:string; p_values:Row; p_filters:Filter[] };

type ClaimArgs = { p_user_id: string; p_user_limit: number; p_global_limit: number };

export interface RpcCall {
  name: string;
  args: unknown;
  internal?: boolean;
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
  check_dismissed_at: null,
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
  received_at: null,
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
  emails: { processing_run_id: null, processing_lease_until: null, consent_waiting_until: null, classification: null, processing_status: "pending", error: null, sent_at: null, message_id: null, body_state: "plain", body_envelope: null, from_domain: null, forwarding_confirm_url: null },
  extractions: { parcel_id: null, confidence: null },
  parcel_items: { quantity: null, unit_price: null, evidence: null },
};

function isNil(v: unknown): boolean {
  return v === null || v === undefined;
}

/** PostgreSQL compares timestamptz instants, retaining microseconds unlike JavaScript Date. */
function instantMicros(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  const belowMillis = (value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6);
  return BigInt(millis) * BigInt(1000) + BigInt(belowMillis);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const timeA = instantMicros(a);
  const timeB = instantMicros(b);
  if (timeA !== null && timeB !== null) return timeA < timeB ? -1 : timeA > timeB ? 1 : 0;
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
      this.tables[table] = rows.map((r) => ({ ...(DEFAULTS[table] ?? {}), ...(table === "parcels" ? { created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" } : {}), ...r }));
    }
    for (const row of this.rows("emails")) {
      if (String(row.provider_email_id ?? "").startsWith("demo:")) {
        if (row.sample_generation && !this.rows("sample_generations").some((g) => g.user_id === row.user_id)) this.rows("sample_generations").push({ user_id: row.user_id, generation: row.sample_generation });
        row.sample_generation ??= this.sampleGeneration(String(row.user_id));
      }
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
    const headers: Record<string, string> = {};
    let done: Promise<Result> | null = null;
    const run = () => done ??= Promise.resolve().then(() => this.executeRpc(name, args, headers));
    // PostgrestBuilder starts only when awaited, after request headers have been set.
    const builder = {
      setHeader: (key: string, value: string) => { headers[key.toLowerCase()] = value; return builder; },
      then: <A = Result, B = never>(resolve?: ((value: Result) => A | PromiseLike<A>) | null, reject?: ((reason: unknown) => B | PromiseLike<B>) | null) => run().then(resolve, reject),
      catch: (reject: (reason: unknown) => unknown) => run().catch(reject),
      finally: (finish: () => void) => run().finally(finish),
    };
    return builder as unknown as Promise<Result>;
  }

  private async receiptUser(): Promise<string | null> {
    const client = this as unknown as { auth?: { getUser(): Promise<{data:{user:{id:string}|null}}> } };
    return (await client.auth?.getUser())?.data.user?.id ?? null;
  }

  private async markParcelsReceived(ids: string[]): Promise<Result> {
    if (!Array.isArray(ids) || ids.length>200 || ids.some((id)=>typeof id!=="string")) return {data:null,error:{code:"22023",message:"invalid receipt ids"}};
    const userId=await this.receiptUser();
    if (!userId) return {data:null,error:{code:"42501",message:"signed in owner required"}};
    const before=structuredClone(this.tables); const data:Row[]=[];
    for (const id of [...new Set(ids)].sort()) {
      const row=this.find("parcels",id);
      if (!row || row.user_id!==userId || row.status==="cancelled" || (row.received_at!==null && !Number.isFinite(Date.parse(String(row.received_at))))) {data.push({id,outcome:"changed"});continue;}
      if (row.received_at!==null) {data.push({id,outcome:"already_received"});continue;}
      const previous={...row}; const receivedAt=new Date().toISOString();
      const query=this.from("parcels").update({status:"delivered",received_at:receivedAt}).eq("id",id).eq("user_id",userId).eq("updated_at",row.updated_at).select("*").query;
      query.viaRpc=true;
      const result=this.execute(query); const saved=Array.isArray(result.data)?result.data[0] as Row:undefined;
      if(result.error || !saved || saved.status!=="delivered" || saved.received_at!==receivedAt) {this.tables=before;return {data:null,error:result.error??{code:"42501",message:"received parcel was not stored as requested"}};}
      const receipt={parcel_id:id,user_id:userId,receipt_id:crypto.randomUUID(),previous_status:previous.status,previous_received_at:previous.received_at,
        written_received_at:saved.received_at,written_updated_at:saved.updated_at,undone_at:null,undone_updated_at:null,
        created_at:receivedAt,expires_at:new Date(Date.parse(receivedAt)+parcelReceiptRetentionMs()).toISOString()};
      const journal=this.rows("parcel_receipt_undos").find((j)=>j.parcel_id===id);
      if(journal) Object.assign(journal,receipt);else this.rows("parcel_receipt_undos").push(receipt);
      data.push({id,outcome:"written",receipt_id:receipt.receipt_id,received_at:saved.received_at,updated_at:saved.updated_at,previous_status:previous.status,previous_received_at:previous.received_at});
    }
    return {data,error:null};
  }

  private async restoreParcelReceipts(keys:Array<{id:string;receipt_id:string}>):Promise<Result> {
    if(!Array.isArray(keys)||keys.length>200) return {data:null,error:{code:"22023",message:"invalid undo receipts"}};
    const userId=await this.receiptUser();
    if(!userId) return {data:null,error:{code:"42501",message:"signed in owner required"}};
    const before=structuredClone(this.tables);const data:Row[]=[];
    for(const key of [...new Map(keys.map((k)=>[k.id,k])).values()].sort((a,b)=>a.id<b.id?-1:1)) {
      const row=this.find("parcels",key.id);const journal=this.rows("parcel_receipt_undos").find((j)=>j.parcel_id===key.id&&j.user_id===userId);
      const outcome=(outcome:string)=>data.push({id:key.id,outcome});
      if(!row||row.user_id!==userId) {outcome("changed");continue;}
      if(!journal) {outcome("failed");continue;}
      if(journal.receipt_id!==key.receipt_id) {outcome("changed");continue;}
      if(Date.parse(String(journal.expires_at))<=Date.now()) {outcome("failed");continue;}
      if(journal.undone_at!==null) {
        outcome(row.updated_at===journal.undone_updated_at&&row.status===journal.previous_status&&row.received_at===journal.previous_received_at?"restored":"changed");continue;
      }
      if(row.status!=="delivered"||row.received_at!==journal.written_received_at||row.updated_at!==journal.written_updated_at) {outcome("changed");continue;}
      const query=this.from("parcels").update({status:journal.previous_status,received_at:journal.previous_received_at}).eq("id",key.id).eq("user_id",userId).eq("updated_at",journal.written_updated_at).select("*").query;
      query.viaRpc=true;
      const result=this.execute(query);const saved=Array.isArray(result.data)?result.data[0] as Row:undefined;
      if(result.error||!saved||saved.status!==journal.previous_status||saved.received_at!==journal.previous_received_at) {this.tables=before;return {data:null,error:result.error??{code:"42501",message:"undo parcel was not stored as requested"}};}
      journal.undone_at=new Date().toISOString();journal.undone_updated_at=saved.updated_at;outcome("restored");
    }
    return {data,error:null};
  }

  private purgeReceiptAndConsent(): Result {
    const before=structuredClone(this.tables); const now=Date.now(); let count=0;
    // The real wrapper finishes existing consent cleanup before touching child receipt rows.
    for(const mail of [...this.rows("emails")]) {
      if(mail.body_state!=="plain" || mail.processing_status==="processed" || !mail.consent_waiting_until || Date.parse(String(mail.consent_waiting_until))>now
        || (mail.processing_status==="pending"&&Date.parse(String(mail.processing_lease_until??mail.created_at))+(!mail.processing_lease_until?180_000:0)>now)) continue;
      if(this.rows("extractions").some((x)=>x.email_id===mail.id)) Object.assign(mail,{subject:null,from_address:null,from_name:null,text_body:null,html_body:null,body_envelope:null,body_state:"dropped",processing_status:"discarded",error:"ai_consent_wait_expired",processing_run_id:null,processing_lease_until:null});
      else this.tables.emails=this.rows("emails").filter((row)=>row!==mail);
      count++;
    }
    const query=this.from("parcel_receipt_undos").delete().lte("expires_at",new Date(now).toISOString()).select("parcel_id").query;
    query.viaRpc=true;const removed=this.execute(query);
    if(removed.error || this.rows("parcel_receipt_undos").some((j)=>Date.parse(String(j.expires_at))<=now)) {this.tables=before;return {data:null,error:removed.error??{code:"42501",message:"expired receipt journals were not removed"}};}
    return {data:count+(Array.isArray(removed.data)?removed.data.length:0),error:null};
  }

  private sampleGeneration(userId: string): string {
    let row = this.rows("sample_generations").find((r) => r.user_id === userId);
    if (!row) { row = { user_id: userId, generation: crypto.randomUUID() }; this.rows("sample_generations").push(row); }
    return String(row.generation);
  }

  private sampleFence(userId: unknown, headers: Record<string, string>, required = false): Result | null {
    const generation = headers["x-otodoke-sample-generation"];
    const owner = headers["x-otodoke-sample-user"];
    if (!generation && !owner && !required) return null;
    if (!generation || owner !== userId || this.rows("sample_generations").find((r) => r.user_id === userId)?.generation !== generation) {
      return { data: null, error: { code: "55000", message: "sample load was cleared; load it again" } };
    }
    return null;
  }

  private executeRpc(name: string, args: unknown, headers: Record<string, string>): Promise<Result> {
    this.rpcCalls.push({ name, args });
    if (name === "purge_old_screen_events") return Promise.resolve(this.purgeReceiptAndConsent());
    if (name === "mark_parcels_received") return this.markParcelsReceived((args as { p_ids: string[] }).p_ids);
    if (name === "restore_parcel_receipts") return this.restoreParcelReceipts((args as { p_receipts: Array<{id:string;receipt_id:string}> }).p_receipts);
    if (name === "update_mail_parcel") return Promise.resolve(this.updateMailParcel(args as UpdateParcelArgs, headers));
    if (name === "create_mail_parcel") return Promise.resolve(this.createMailParcel(args as CreateParcelArgs, headers));
    if (name === "ensure_mail_parcel_items") return Promise.resolve(this.ensureMailParcelItems(args as EnsureItemsArgs, headers));
    if (name === "mail_parcel_snapshot") return Promise.resolve({ data: this.parcelSnapshot((args as { p_user_id: string }).p_user_id), error: null });
    if (name === "begin_sample_load") return Promise.resolve({ data: this.sampleGeneration((args as { p_user_id: string }).p_user_id), error: null });
    if (name === "receive_sample_parcels") {
      const a = args as { p_user_id: string; p_parcel_ids: string[]; p_received_at: string };
      const denied = this.sampleFence(a.p_user_id, headers, true);
      if (denied) return Promise.resolve(denied);
      const sampleIds = new Set(this.rows("emails").filter((m) => m.user_id === a.p_user_id && String(m.provider_email_id ?? "").startsWith("demo:")).map((m) => m.id));
      const parcelIds = this.rows("extractions").filter((x) => x.user_id === a.p_user_id && sampleIds.has(x.email_id)).map((x) => x.parcel_id);
      const query = this.from("parcels").update({ received_at: a.p_received_at }).in("id", a.p_parcel_ids.filter((id) => parcelIds.includes(id))).eq("user_id", a.p_user_id).eq("status", "delivered").is("received_at", null).query;
      query.requestHeaders = headers;
      query.viaRpc = true;
      return Promise.resolve(this.execute(query));
    }
    if (name === "clear_all_parcels") {
      const userId = (args as { p_user_id: string }).p_user_id;
      const before = structuredClone(this.tables);
      this.sampleGeneration(userId);
      const generation = crypto.randomUUID();
      this.rows("sample_generations").find((r) => r.user_id === userId)!.generation = generation;
      for (const table of ["parcels", "emails"]) {
        const result = this.execute(this.from(table).delete().eq("user_id", userId).query);
        if (result.error) { this.tables = before; return Promise.resolve(result); }
      }
      for (const table of ["extractions", "parcel_items", "parcel_receipt_undos"]) this.tables[table] = this.rows(table).filter((r) => r.user_id !== userId);
      return Promise.resolve({ data: generation, error: null });
    }
    if (name === "store_mail_run") {
      const a = args as StoreArgs;
      const denied = this.sampleFence(a.p_user_id, headers, String(a.p_columns.provider_email_id ?? "").startsWith("demo:"));
      return Promise.resolve(denied ?? this.storeMailRun(a, headers));
    }
    if (name === "mail_run_write") return this.mailRunWrite(args as OwnedArgs, headers);
    if (name === "claim_ai_reading_backlog") return Promise.resolve(this.claimAiReadingBacklog(args as { p_user_id: string; p_decided_at: string }));
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
      // Before supabase/migrations/20261112020000_claude_call_release.sql is applied (or after its rollback).
      if (this.claudeReleaseMissing) return Promise.resolve({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` } });
      if (name === "claim_claude_call_v2") return Promise.resolve(this.claimClaudeCall(args as ClaimArgs, true));
      return Promise.resolve(this.releaseClaudeCall(args as { p_claim_id: number; p_user_id: string }));
    }
    return Promise.resolve({ data: "ok", error: null });
  }

  /** The grant and journal are checked/written synchronously, like the SQL's row lock and UPSERT. */
  private claimAiReadingBacklog(a: { p_user_id: string; p_decided_at: string }): Result {
    const stamp = instantMicros(a.p_decided_at);
    const consent = this.rows("ai_reading_consents").find((r) => r.user_id === a.p_user_id);
    if (stamp === null || !consent || consent.decision !== "granted" || instantMicros(consent.decided_at) !== stamp) return { data: false, error: null };
    const journal = this.rows("ai_consent_read_runs");
    const claimed = journal.find((r) => r.user_id === a.p_user_id);
    if (claimed && instantMicros(claimed.consent_decided_at) === stamp) return { data: false, error: null };
    const value = { user_id: a.p_user_id, consent_decided_at: a.p_decided_at };
    if (claimed) Object.assign(claimed, value);
    else journal.push(value);
    return { data: true, error: null };
  }

  private storeMailRun(a: StoreArgs, headers: Record<string, string> = {}): Result {
    const answer = (verdict: string): Result => ({ data: [{ verdict, email_id: a.p_email_id }], error: null });
    const old = this.rows("emails").find((r) => r.id === a.p_email_id && r.user_id === a.p_user_id);
    if (old?.processing_status === "discarded" && old.error === "ai_consent_wait_expired") return answer("consent_wait_expired");
    if (old?.processing_status === "processed") return answer("duplicate");
    if (old?.processing_status === "pending" && Date.parse(String(old.processing_lease_until ?? new Date(Date.parse(String(old.created_at)) + 180_000).toISOString())) > Date.now()) return answer("busy");
    if ((old?.created_at ?? null) !== a.p_expected_created_at) return answer("busy");
    if (old?.body_state === "plain" && old.processing_status !== "processed" && old.consent_waiting_until && Date.parse(String(old.consent_waiting_until)) <= Date.now()) {
      if (this.rows("extractions").some((r) => r.email_id === old.id && r.user_id === old.user_id)) {
        Object.assign(old, { subject: null, from_address: null, from_name: null, text_body: null, html_body: null, body_state: "dropped", body_envelope: null, processing_status: "discarded", error: "ai_consent_wait_expired", forwarding_confirm_url: null, processing_run_id: null, processing_lease_until: null });
      } else this.tables.emails = this.rows("emails").filter((r) => r !== old);
      return answer("consent_wait_expired");
    }
    const bytes = (r: Row) => ["subject","from_address","from_name","text_body","html_body"].reduce((n,k) => n + Buffer.byteLength(String(r[k] ?? ""), "utf8"),0);
    const unread = this.rows("emails").filter((r) => r.id !== a.p_email_id && r.body_state === "plain" && r.processing_status !== "processed");
    const global = unread.filter((r) => !r.consent_waiting_until);
    const own = unread.filter((r) => r.user_id === a.p_user_id);
    const now = new Date().toISOString();
    const arrival = old?.received_at ?? now;
    const consented = this.rows("ai_reading_consents").some((r) => r.user_id === a.p_user_id && r.decision === "granted");
    const waitingUntil = old?.consent_waiting_until ?? (!consented && a.p_columns.processing_status !== "processed" && (a.p_columns.body_state ?? "plain") === "plain" && !String(a.p_columns.provider_email_id ?? "").startsWith("demo:")
      ? new Date(Date.parse(String(arrival)) + consentWaitingRetentionMs()).toISOString() : null);
    let reason: string | null = null;
    if (a.p_columns.processing_status !== "processed" && (a.p_columns.body_state ?? "plain") === "plain" && (!old || bytes(a.p_columns) > bytes(old))) {
      if (own.length + 1 > a.p_limits.user_count || own.reduce((n,r) => n + bytes(r),0) + bytes(a.p_columns) > a.p_limits.user_bytes) reason = "user_storage_limit";
      else if (!waitingUntil && (global.length + 1 > a.p_limits.global_count || global.reduce((n,r) => n + bytes(r),0) + bytes(a.p_columns) > a.p_limits.global_bytes)) reason = "global_storage_limit";
    }
    if (reason) {
      const notice = this.rows("mail_intake_notices").find((r) => r.user_id === a.p_user_id);
      const values = { user_id: a.p_user_id, reason, limited_at: new Date().toISOString() };
      if (notice) Object.assign(notice,values); else this.rows("mail_intake_notices").push(values);
      return answer(reason);
    }
    if (!old && a.p_columns.provider_email_id && this.rows("emails").some((r) => r.user_id === a.p_user_id && r.provider_email_id === a.p_columns.provider_email_id)) return answer("busy");
    const columns = { ...a.p_columns, received_at: arrival, consent_waiting_until: waitingUntil, processing_run_id: a.p_run_id, processing_lease_until: new Date(Date.now()+360_000).toISOString(), created_at: now };
    const q = old ? this.from("emails").update(columns).eq("id",a.p_email_id).eq("user_id",a.p_user_id).eq("processing_status",old.processing_status).eq("created_at",old.created_at) : this.from("emails").insert({ id:a.p_email_id,user_id:a.p_user_id,...columns });
    const query = q.select("id").maybeSingle().query;
    query.viaRpc = true;
    query.requestHeaders = headers;
    const result = this.execute(query);
    if (result.error?.code === "23505") return answer("busy");
    if (result.error) return result;
    return result.data ? answer("ok") : answer("busy");
  }

  private activeMail(emailId: string, runId: string) {
    return this.rows("emails").find((r) => r.id === emailId && r.processing_run_id === runId && r.processing_status === "pending" && Date.parse(String(r.processing_lease_until)) > Date.now());
  }

  private parcelSnapshot(userId: string) {
    return this.rows("parcels").filter((p) => p.user_id === userId).map((p) => ({ id:p.id,updated_at:p.updated_at,
      item_names:this.rows("parcel_items").filter((i) => i.parcel_id===p.id && i.user_id===userId).map((i) => String(i.name)) }));
  }

  private sameParcelSnapshot(snapshot: CreateParcelArgs["p_snapshot"],userId:string) {
    const normalize = (rows: Array<{id:unknown;updated_at:unknown;item_names:string[]}>) => rows.map((r) => ({...r,
      updated_at:typeof r.updated_at === "string" ? new Date(r.updated_at).toISOString() : r.updated_at,
      item_names:[...r.item_names].sort((x,y) => x<y ? -1 : x>y ? 1 : 0),
    })).sort((x,y) => String(x.id)<String(y.id) ? -1 : String(x.id)>String(y.id) ? 1 : 0);
    return Array.isArray(snapshot) && new Set(snapshot.map((r)=>r.id)).size===snapshot.length && JSON.stringify(normalize(snapshot))===JSON.stringify(normalize(this.parcelSnapshot(userId)));
  }

  private updateMailParcel(a: UpdateParcelArgs, headers: Record<string, string> = {}): Result {
    this.fenceHeaders = headers;
    const mail=this.activeMail(a.p_email_id,a.p_run_id);
    if(!mail) return {data:null,error:{code:"42501",message:"mail run no longer owns the lease"}};
    const retry=():Result=>({data:[{verdict:"retry",parcel_id:null,parcel_row:null}],error:null});
    const parcel=this.find("parcels",a.p_parcel_id);
    if(!this.sameParcelSnapshot(a.p_snapshot,String(mail.user_id)) || !parcel || parcel.user_id!==mail.user_id || Date.parse(String(parcel.updated_at))!==Date.parse(a.p_expected_updated_at)) return retry();
    const before=structuredClone(this.tables);
    const values={...a.p_values,...(parcel.category_source==="user"?{}:a.p_category??{})};
    const noop=Object.keys(values).length===0;
    if(noop) values.shop=parcel.shop;
    let saved=parcel;
    if(Object.keys(values).length) {
      const result=this.ownedMutation({p_email_id:a.p_email_id,p_run_id:a.p_run_id,p_table:"parcels",p_operation:"update",p_values:values,
        p_filters:[{method:"eq",args:["id",a.p_parcel_id]},{method:"eq",args:["user_id",mail.user_id]},{method:"eq",args:["updated_at",a.p_expected_updated_at]}]});
      if(result.error) return result;
      if(!Array.isArray(result.data)) return {data:null,error:{message:"parcel update returned no saved row"}};
      if(result.data.length===0) return retry();
      saved=result.data[0] as Row;
    }
    if(noop && saved.updated_at===a.p_expected_updated_at) {this.tables=before;return {data:null,error:{code:"42501",message:"mail confirmation did not advance the parcel version"}};}
    const ensured=this.ensureMailParcelItems({...a,p_expected_updated_at:String(saved.updated_at)});
    if(ensured.error) {this.tables=before;return ensured;}
    if((ensured.data as Row[])[0]?.verdict!=="ok") {this.tables=before;return retry();}
    return {data:[{verdict:"ok",parcel_id:a.p_parcel_id,parcel_row:saved}],error:null};
  }

  private createMailParcel(a: CreateParcelArgs, headers: Record<string, string> = {}): Result {
    this.fenceHeaders = headers;
    const mail = this.activeMail(a.p_email_id,a.p_run_id);
    if (!mail) return {data:null,error:{code:"42501",message:"mail run no longer owns the lease"}};
    if (!this.sameParcelSnapshot(a.p_snapshot,String(mail.user_id))) return {data:[{verdict:"retry",parcel_id:null}],error:null};
    const before = structuredClone(this.tables);
    const result = this.ownedMutation({ p_email_id:a.p_email_id,p_run_id:a.p_run_id,p_table:"parcels",p_operation:"insert",p_values:a.p_values,p_filters:[] });
    if (result.error) { this.tables=before; return result; }
    const parcelId = (result.data as Row[])[0]?.id;
    if (!parcelId) { this.tables=before; return {data:null,error:{message:"parcel creation returned no saved row"}}; }
    if (a.p_items.length) {
      const inserted = this.ownedMutation({ p_email_id:a.p_email_id,p_run_id:a.p_run_id,p_table:"parcel_items",p_operation:"insert",p_values:a.p_items.map((i) => ({...i,parcel_id:parcelId})) as unknown as Row,p_filters:[] });
      if (inserted.error) { this.tables=before; return inserted; }
    }
    return {data:[{verdict:"ok",parcel_id:parcelId}],error:null};
  }

  private ensureMailParcelItems(a: EnsureItemsArgs, headers: Record<string, string> = {}): Result {
    this.fenceHeaders = headers;
    const mail = this.activeMail(a.p_email_id,a.p_run_id);
    if (!mail) return {data:null,error:{code:"42501",message:"mail run no longer owns the lease"}};
    const parcel = this.find("parcels",a.p_parcel_id);
    if (!parcel || parcel.user_id !== mail.user_id || Date.parse(String(parcel.updated_at)) !== Date.parse(a.p_expected_updated_at)) return {data:[{verdict:"retry"}],error:null};
    if (!this.rows("parcel_items").some((i) => i.parcel_id===a.p_parcel_id && i.user_id===mail.user_id) && a.p_items.length) {
      const result = this.ownedMutation({p_email_id:a.p_email_id,p_run_id:a.p_run_id,p_table:"parcel_items",p_operation:"insert",p_values:a.p_items.map((i) => ({...i,parcel_id:a.p_parcel_id})) as unknown as Row,p_filters:[]});
      if (result.error) return result;
    }
    return {data:[{verdict:"ok"}],error:null};
  }

  private async mailRunWrite(a: OwnedArgs, headers: Record<string, string> = {}): Promise<Result> {
    const mail = this.find("emails", a.p_email_id);
    const denied = this.sampleFence(mail?.user_id, headers, String(mail?.provider_email_id ?? "").startsWith("demo:"));
    if (denied) return denied;
    const owner = () => this.rows("emails").find((r) => r.id === a.p_email_id && r.processing_run_id === a.p_run_id && r.processing_status === "pending" && Date.parse(String(r.processing_lease_until)) > Date.now());
    if (!owner()) return { data: null, error: { code: "42501", message: "mail run no longer owns the lease" } };
    if (a.p_operation === "claim") {
      const result = await this.rpc(a.p_table,a.p_values);
      this.rpcCalls[this.rpcCalls.length-1].internal = true;
      return result;
    }
    return this.ownedMutation(a, headers);
  }

  /** The request headers of the RPC being run, so its inner writes carry the same sample fence. */
  private fenceHeaders: Record<string, string> = {};

  private ownedMutation(a: OwnedArgs, headers: Record<string, string> = this.fenceHeaders): Result {
    const mail = this.activeMail(a.p_email_id,a.p_run_id);
    if (!mail) return {data:null,error:{code:"42501",message:"mail run no longer owns the lease"}};
    const allowed = MAIL_RUN_ALLOWED_COLUMNS.get(a.p_table);
    if (!allowed) return { data: null, error: { code: "22023", message: "unsupported mail table" } };
    if (a.p_operation === "insert" || a.p_operation === "update") {
      const rows = Array.isArray(a.p_values) ? a.p_values : [a.p_values];
      if (rows.some((row) => Object.keys(row).some((column) => !allowed.has(column)))) {
        return { data: null, error: { code: "22023", message: "unsupported mail column" } };
      }
    }
    let q = this.from(a.p_table);
    if (a.p_operation === "insert") {
      const own = (r: Row) => ({...r,user_id:mail.user_id});
      q = q.insert(Array.isArray(a.p_values) ? a.p_values.map(own) : own(a.p_values));
    }
    else if (a.p_operation === "update") q = q.update(a.p_values);
    else q = q.delete();
    for (const f of a.p_filters) q = (q as unknown as Record<string,(...v:unknown[])=>FakeQuery>)[f.method](...f.args);
    const query = q.select("*").query;
    query.viaRpc = true;
    query.requestHeaders = headers;
    query.mailRun = { emailId: a.p_email_id, runId:a.p_run_id };
    return this.execute(query);
  }

  /** True: claim_claude_call_v2 and release_claude_call do not exist yet (PostgREST answers PGRST202). */
  claudeReleaseMissing = false;
  /** The clock the Claude allowance reads (now() in the functions). A test moves it across midnight. */
  claudeNow: () => number = () => Date.now();

  private jstDay(): string {
    return new Date(this.claudeNow() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /**
   * supabase/migrations/20261112020000_claude_call_release.sql: claim_claude_call and claim_claude_call_v2
   * count the same row by the same rule (the day in Asia/Tokyo, the app-wide sum first, then the
   * person's row); v2 also records a claim and answers `[{ verdict, claim_id }]`. The real functions
   * are exercised on Postgres; this mirrors their rules.
   */
  private claimClaudeCall(a: ClaimArgs, v2: boolean): Result {
    if (!this.rows("ai_reading_consents").some((row) => row.user_id === a.p_user_id && row.decision === "granted")) {
      return { data: null, error: { code: "42501", message: "ai_consent_required" } };
    }
    const day = this.jstDay();
    const usage = this.rows("claude_usage_daily");
    const answer = (verdict: string, claimId: number | null): Result => ({ data: v2 ? [{ verdict, claim_id: claimId }] : verdict, error: null });
    if (usage.filter((r) => r.day === day).reduce((n, r) => n + Number(r.calls), 0) >= a.p_global_limit) return answer("global_limit", null);
    if (a.p_user_limit <= 0) return answer("user_limit", null);
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
    if (q.op !== "select" && ["emails", "parcels", "extractions", "parcel_items"].includes(q.table)) {
      const rows = q.op === "insert" || q.op === "upsert" ? (Array.isArray(q.values) ? q.values : [q.values]) as Row[] : this.matching(q);
      for (const row of rows) {
        const denied = this.sampleFence(row.user_id, q.requestHeaders ?? {}, q.table === "emails" && q.op === "insert" && String(row.provider_email_id ?? "").startsWith("demo:"));
        if (denied) return denied;
      }
    }
    if (q.mailRun) {
      const m = this.find("emails",q.mailRun.emailId);
      if (!m || m.processing_run_id !== q.mailRun.runId || m.processing_status !== "pending" || !m.processing_lease_until || Date.parse(String(m.processing_lease_until)) <= Date.now()) return { data:null,error:{code:"42501",message:"mail run no longer owns the lease"} };
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
      if (q.table === "emails" && String(row.provider_email_id ?? "").startsWith("demo:")) row.sample_generation = q.requestHeaders?.["x-otodoke-sample-generation"] ?? null;
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
      const before = { ...row };
      Object.assign(row, q.values as Row);
      if (q.table === "emails") {
        if (before.received_at !== undefined) row.received_at = before.received_at;
        if (before.consent_waiting_until) row.consent_waiting_until = before.consent_waiting_until;
        const consented = this.rows("ai_reading_consents").some((c) => c.user_id === row.user_id && c.decision === "granted");
        if (!row.consent_waiting_until && row.body_state === "plain" && row.processing_status !== "processed"
          && !String(row.provider_email_id ?? "").startsWith("demo:") && row.classification !== "forwarding_confirmation"
          && (!consented || row.error === "ai_consent_required" || row.error === "ai_consent_unknown")) {
          // Seeded legacy fixtures may omit the DB's non-null received_at column.
          const arrival = row.received_at ?? row.created_at;
          row.consent_waiting_until = new Date(Date.parse(String(arrival)) + consentWaitingRetentionMs()).toISOString();
        }
      }
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
    if(q.table==="parcels") this.tables.parcel_receipt_undos=this.rows("parcel_receipt_undos").filter((r)=>!hits.some((p)=>p.id===r.parcel_id));
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
  setHeader(name: string, value: string): this {
    (this.q.requestHeaders ??= {})[name.toLowerCase()] = value;
    return this;
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
