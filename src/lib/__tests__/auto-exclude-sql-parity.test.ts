import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { arrivingSign } from "@/lib/match";
import { ARRIVAL_SIGN_COLUMNS, AUTO_EXCLUDE_KINDS, MARKS_BEFORE_AUTO } from "@/lib/not-parcel-auto";
import { reading, sure } from "./pipeline-fixtures";

/**
 * What decides "taken out by itself" is written twice: in TypeScript (the ingestion: arrivingSign,
 * AUTO_EXCLUDE_KINDS, MARKS_BEFORE_AUTO) and in the database (mark_rule_exclusion's where, and
 * auto_exclusion_would_start, which the "next time it is automatic" toast asks). If one side changes alone, the
 * toast promises what the ingestion does not do, or a parcel with a sign is hidden. This reads the migration's SQL and
 * compares. (The never-automatic domains are checked by no-auto-exclude-migration.test.ts.)
 */
const root = path.resolve(__dirname, "../../..");
const MIGRATION = "supabase/migrations/20261117110000_parcel_exclusions_auto.sql";

interface Ts {
  signColumns: Readonly<Record<string, string | null>>;
  kinds: readonly string[];
  marks: number;
}

/** The text of one `create or replace function public.<name>` up to its `end $$;`. */
function bodyOf(sql: string, name: string): string {
  const start = sql.indexOf(`function public.${name}(`);
  if (start < 0) return "";
  const end = sql.indexOf("end $$;", start);
  return end < 0 ? "" : sql.slice(start, end);
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

/** Every way the two sides differ; empty when they agree. */
export function parityProblems(sql: string, ts: Ts): string[] {
  const problems: string[] = [];

  const mark = bodyOf(sql, "mark_rule_exclusion");
  if (!mark) problems.push("mark_rule_exclusion not found");
  const where = mark.slice(mark.indexOf("where"));
  const isNull = new Set([...where.matchAll(/\bp\.(\w+) is null\b/g)].map((m) => m[1]));
  const notTrue = new Set([...where.matchAll(/\bp\.(\w+) is not true\b/g)].map((m) => m[1]));
  const tsColumns = new Set(Object.values(ts.signColumns).filter((c): c is string => c !== null));
  // requires_presence is "is not true" (false still counts as no sign); every other column must be empty.
  const tsEmpty = sorted([...tsColumns].filter((c) => c !== "requires_presence"));
  if (JSON.stringify(sorted(isNull)) !== JSON.stringify(tsEmpty)) problems.push(`is null columns: sql ${sorted(isNull)} / ts ${tsEmpty}`);
  if (JSON.stringify(sorted(notTrue)) !== JSON.stringify(tsColumns.has("requires_presence") ? ["requires_presence"] : [])) problems.push(`is not true columns: sql ${sorted(notTrue)}`);
  if (!/\bp\.source='mail'/.test(where)) problems.push("source = mail missing");
  if (!/\bp\.status in \('unknown','ordered'\)/.test(where)) problems.push("status in (unknown, ordered) missing");

  const would = bodyOf(sql, "auto_exclusion_would_start");
  if (!would) problems.push("auto_exclusion_would_start not found");
  const kinds = would.match(/v_relevance not in \(([^)]*)\)/)?.[1];
  const sqlKinds = sorted([...(kinds ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]));
  if (!kinds || JSON.stringify(sqlKinds) !== JSON.stringify(sorted(ts.kinds))) problems.push(`kinds: sql ${sqlKinds} / ts ${sorted(ts.kinds)}`);
  const count = would.match(/x\.relevance=v_relevance\)\s*<\s*(\d+)\s+then return false/)?.[1];
  if (count === undefined || Number(count) !== ts.marks) problems.push(`marks before auto: sql ${count} / ts ${ts.marks}`);
  return problems;
}

const TS_NOW: Ts = { signColumns: ARRIVAL_SIGN_COLUMNS, kinds: AUTO_EXCLUDE_KINDS, marks: MARKS_BEFORE_AUTO };
const SQL = readFileSync(path.join(root, MIGRATION), "utf8");

describe("the database and the ingestion agree on when a parcel is taken out by itself", () => {
  it("they agree now", () => {
    expect(parityProblems(SQL, TS_NOW)).toEqual([]);
  });

  it("every sign in the table is one arrivingSign really looks at", () => {
    const alone: Record<string, Parameters<typeof reading>[0]> = {
      tracking_number: { tracking_number: sure("1234-5678-9012") },
      carrier: { carrier: sure("テスト運輸") },
      package_description: { package_description: sure("衣料品") },
      requires_presence: { requires_presence: sure(true) },
      expected_date: { expected_date: sure("2026-11-20") },
      expected_text: { expected_text: "根拠の行" },
      expected_window_start: { expected_window_start: sure("14:00") },
      expected_window_end: { expected_window_end: sure("16:00") },
    };
    expect(sorted(Object.keys(ARRIVAL_SIGN_COLUMNS))).toEqual(sorted(Object.keys(alone)));
    for (const field of Object.keys(ARRIVAL_SIGN_COLUMNS)) expect(arrivingSign(reading({ relevance: "order", ...alone[field] })), field).toBe(true);
  });

  describe("negative controls: a change on one side only is caught", () => {
    it("a sql condition column removed", () => {
      expect(parityProblems(SQL.replace("p.carrier is null and ", ""), TS_NOW)).not.toEqual([]);
      expect(parityProblems(SQL.replace("p.expected_window_end is null and ", ""), TS_NOW)).not.toEqual([]);
      expect(parityProblems(SQL.replace(" and p.requires_presence is not true", ""), TS_NOW)).not.toEqual([]);
    });
    it("a sql condition column added that the table does not know", () => {
      expect(parityProblems(SQL.replace("p.carrier is null and ", "p.carrier is null and p.title is null and "), TS_NOW)).not.toEqual([]);
    });
    it("a column removed from the table", () => {
      const { carrier: _gone, ...rest } = ARRIVAL_SIGN_COLUMNS;
      void _gone;
      expect(parityProblems(SQL, { ...TS_NOW, signColumns: rest })).not.toEqual([]);
    });
    it("the minimum number of marks changed on either side", () => {
      expect(parityProblems(SQL, { ...TS_NOW, marks: 3 })).not.toEqual([]);
      expect(parityProblems(SQL.replace("x.relevance=v_relevance) < 2 then", "x.relevance=v_relevance) < 3 then"), TS_NOW)).not.toEqual([]);
    });
    it("a kind added or removed on either side", () => {
      expect(parityProblems(SQL, { ...TS_NOW, kinds: [...AUTO_EXCLUDE_KINDS, "shipped"] })).not.toEqual([]);
      expect(parityProblems(SQL, { ...TS_NOW, kinds: ["order"] })).not.toEqual([]);
      expect(parityProblems(SQL.replace("not in ('order','payment')", "not in ('order','payment','shipped')"), TS_NOW)).not.toEqual([]);
    });
    it("a function that is missing is caught", () => {
      expect(parityProblems("nothing", TS_NOW)).not.toEqual([]);
    });
  });
});
