import type { AdminClient } from "@/lib/supabase/admin";
import { readAll } from "@/lib/supabase/read-all";
import { arrivingSign, type ParcelExclusion, type ParcelRow } from "@/lib/match";
import { domainOf } from "@/lib/mail-seal";
import { isAutoExcludableDomain, personalMailReason } from "@/lib/screen-senders";
import type { Extraction } from "@/lib/extract/schema";

/**
 * 「荷物ではありません」 learned by the app (the pipeline's side, with the service role). A parcel the person took
 * out is a `user` mark; one the app took out by itself is a `rule` mark. Every write here is the safe way round:
 * a failure leaves the parcel shown (shown too much), never hidden by a half-finished write.
 */

/** Marks of the same sender and kind the person must have made before the app does it by itself. */
export const MARKS_BEFORE_AUTO = 2;

/**
 * The kinds of mail the app may take a parcel out for. Also in public.auto_exclusion_would_start() (the SQL is
 * checked against this list, and against MARKS_BEFORE_AUTO, by auto-exclude-sql-parity.test.ts).
 */
export const AUTO_EXCLUDE_KINDS: readonly string[] = ["order", "payment"];

/**
 * The signs of arrival arrivingSign looks at, with the parcels column public.mark_rule_exclusion() requires empty
 * for the same sign (null: a sign of the reading that no parcels column holds). One table, so a sign added to one
 * side only is caught by auto-exclude-sql-parity.test.ts. Behaviour is in arrivingSign and the SQL, not here.
 */
export const ARRIVAL_SIGN_COLUMNS: Readonly<Record<string, string | null>> = {
  tracking_number: "tracking_number",
  carrier: "carrier",
  package_description: null,
  requires_presence: "requires_presence",
  expected_date: "expected_date",
  expected_text: "expected_text",
  expected_window_start: "expected_window_start",
  expected_window_end: "expected_window_end",
};

export interface ExclusionRow extends ParcelExclusion {
  parcel_id: string;
}

const PAGE = 1000;

/**
 * Every mark of this user. Paged by parcel_id: the table has no `id` column (readAll orders by `id`), and a
 * failed page throws, never an empty list in place of an error.
 */
export async function readExclusions(db: AdminClient, userId: string): Promise<ExclusionRow[]> {
  const rows: ExclusionRow[] = [];
  let total: number | null = null;
  for (;;) {
    const from = rows.length;
    const { data, error, count } = await db
      .from("parcel_exclusions")
      .select("parcel_id, kind, from_domain, relevance, counted", { count: "exact" })
      .eq("user_id", userId)
      .order("parcel_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`parcel_exclusions lookup failed: ${error.message}`);
    if (total === null) {
      if (count === null) throw new Error("parcel_exclusions lookup returned no count");
      total = count;
    }
    const page = data ?? [];
    rows.push(...page);
    if (rows.length >= total) return rows;
    if (page.length === 0) throw new Error(`parcel_exclusions lookup: expected ${total} rows, got ${rows.length}`);
  }
}

/** Takes the app's own mark off a parcel. Answers the error message, or null when it is done (or there was none). */
export async function clearRuleExclusion(db: AdminClient, userId: string, parcelId: string): Promise<string | null> {
  const { error } = await db.from("parcel_exclusions").delete().eq("parcel_id", parcelId).eq("user_id", userId).eq("kind", "rule");
  return error ? error.message : null;
}

/** Whether the parcel has the app's own mark now. Throws when it cannot tell. */
export async function hasRuleExclusion(db: AdminClient, userId: string, parcelId: string): Promise<boolean> {
  const { data, error } = await db.from("parcel_exclusions").select("kind").eq("parcel_id", parcelId).eq("user_id", userId).eq("kind", "rule").maybeSingle();
  if (error) throw new Error(`parcel_exclusions lookup failed: ${error.message}`);
  return data !== null;
}

/** The login address of the user, or null when the client cannot say (never in production). Throws on a failed lookup. */
async function ownEmailOf(db: AdminClient, userId: string): Promise<string | null> {
  if (!db.auth?.admin) return null;
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error) throw new Error(`user lookup failed: ${error.message}`);
  return data.user?.email ?? null;
}

export interface NewParcelFacts {
  userId: string;
  parcelId: string;
  /** The From address and subject of the mail that opened the parcel. */
  from: string;
  subject: string;
  x: Extraction;
  /** A public sample mail: never taken out by itself. */
  sample: boolean;
}

/**
 * Right after a parcel was created from a mail: take it out by itself when every one of these holds
 *  1. the person took out at least two parcels of this sender and kind by hand (counted marks);
 *  2. the mail is an order or a payment notice, never a shipment or later;
 *  3. the reading carries no sign of arrival (arrivingSign);
 *  4. the sender's domain is not a shared one, nor one that stands for many shops;
 *  5. the mail is not one forwarded by hand, nor from the person's own domain;
 *  6. no parcel of this sender is shown (a shown one is proof the sender sends real parcels);
 *  7. not a sample.
 * The mark itself is written by one SQL statement that looks at the parcel's row as it is then
 * (mark_rule_exclusion), so a shipment mail that got there first keeps the parcel shown. Never throws.
 */
export async function autoExcludeNewParcel(db: AdminClient, f: NewParcelFacts): Promise<void> {
  try {
    if (f.sample) return;
    if (!AUTO_EXCLUDE_KINDS.includes(f.x.relevance)) return;
    if (arrivingSign(f.x)) return;
    const domain = domainOf(f.from);
    if (!isAutoExcludableDomain(domain)) return;
    if (personalMailReason({ from_domain: domain, subject: f.subject }, await ownEmailOf(db, f.userId))) return;

    const marks = await readExclusions(db, f.userId);
    const counted = marks.filter((m) => m.kind === "user" && m.counted && m.from_domain === domain && m.relevance === f.x.relevance);
    if (counted.length < MARKS_BEFORE_AUTO) return;

    // Parcels of this sender: those a mail from its domain was read for.
    const readings = await readAll(() =>
      db.from("extractions").select("id, parcel_id, emails!inner(from_domain)", { count: "exact" }).eq("user_id", f.userId).eq("emails.from_domain", domain).not("parcel_id", "is", null),
    );
    const hidden = new Set(marks.map((m) => m.parcel_id));
    if (readings.some((r) => r.parcel_id !== null && r.parcel_id !== f.parcelId && !hidden.has(r.parcel_id))) return;

    const { error } = await db.rpc("mark_rule_exclusion", { p_user: f.userId, p_parcel_id: f.parcelId, p_from_domain: domain, p_relevance: f.x.relevance });
    if (error) console.error("auto exclusion failed:", error.message);
  } catch (err) {
    console.error("auto exclusion failed:", err instanceof Error ? err.message : "unknown");
  }
}

/**
 * Two parcels with one tracking number become one (the `keep` row stays, the rest are deleted and their marks
 * go with them). What the person said must survive that, and what the app guessed must not hide a parcel
 * that is real:
 *  - the kept row is a typed-in parcel: no mark moves, user or rule. It stays shown.
 *  - a folded row has a `user` mark: the kept row gets it first (so a failure part-way leaves it hidden,
 *    as the person said). A `rule` mark on the kept row becomes the person's.
 *  - the kept row has a `rule` mark and no folded row has a `user` mark: when some folded row is shown, the
 *    kept row's mark is taken off (a parcel with a tracking number is a real one).
 * Answers false when a write failed; the caller then leaves the parcels apart.
 */
export async function carryExclusionsOnMerge(db: AdminClient, userId: string, keep: Pick<ParcelRow, "id" | "source">, absorb: Pick<ParcelRow, "id">[]): Promise<boolean> {
  if (keep.source === "manual") return true;
  const { data, error } = await db
    .from("parcel_exclusions")
    .select("parcel_id, kind, from_domain, relevance, counted")
    .eq("user_id", userId)
    .in("parcel_id", [keep.id, ...absorb.map((p) => p.id)]);
  if (error) {
    console.error("parcel_exclusions lookup failed:", error.message);
    return false;
  }
  const marks = new Map<string, ExclusionRow>((data ?? []).map((m) => [m.parcel_id, m]));
  const kept = marks.get(keep.id);
  const said = absorb.map((p) => marks.get(p.id)).find((m) => m?.kind === "user");
  if (said) {
    if (kept?.kind === "user") return true;
    const values = { kind: "user", from_domain: said.from_domain, relevance: said.relevance, counted: said.counted };
    const written = kept
      ? await db.from("parcel_exclusions").update(values).eq("parcel_id", keep.id).eq("user_id", userId)
      : await db.from("parcel_exclusions").insert({ parcel_id: keep.id, user_id: userId, ...values });
    if (written.error) {
      console.error("parcel_exclusions carry failed:", written.error.message);
      return false;
    }
    return true;
  }
  if (kept?.kind === "rule" && absorb.some((p) => !marks.has(p.id))) {
    const message = await clearRuleExclusion(db, userId, keep.id);
    if (message) {
      console.error("parcel_exclusions clear failed:", message);
      return false;
    }
  }
  return true;
}
