import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { forwardingConfirmUrl } from "@/lib/forwarding";

/**
 * The SQL for decision 7 and the daily purge, after the review of 2026-11-06 (R1-2, R1-4, E-5).
 *
 * `supabase db query --linked -f` returns only the last result and exits 0 even on an error, so a
 * verify file that prints OK as a NOTICE says nothing: each verify file ends in one SELECT whose
 * row carries the verdict, and one file does one job (they used to be three parts in one file).
 * What these files do was run on a local Postgres 17 on 2026-11-06, with negative controls; this
 * test only keeps their shape.
 */

const root = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, "");

/** The last statement of a file: what `supabase db query` shows. */
function lastStatement(sql: string): string {
  const code = withoutComments(sql).replace(/\$\$[\s\S]*?\$\$/g, "$$…$$").trim();
  const parts = code.split(";").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1];
}

const VERIFY = [
  "supabase/verify/20261114090000_drop_unsealed_plaintext.before.sql",
  "supabase/verify/20261114090000_drop_unsealed_plaintext.after.sql",
  "supabase/verify/20261114090000_drop_unsealed_plaintext.count-control.sql",
  "supabase/verify/20261106180000_screen_events_daily_purge.before.sql",
  "supabase/verify/20261106180000_screen_events_daily_purge.sql",
  "supabase/verify/20261106180000_screen_events_daily_purge.after-first-run.sql",
  "supabase/verify/20261106170000_issued_inbox_local_parts.sql",
  "supabase/verify/20261106190000_claude_usage_keeps_deleted_calls.sql",
];

describe("verify files answer with a result row", () => {
  for (const file of VERIFY) {
    it(`${file}: ends in a SELECT (with a verdict where there is something to judge), no OK by NOTICE`, () => {
      const sql = read(file);
      const last = lastStatement(sql);
      expect(last, file).toMatch(/^(with|select)\b/i);
      if (!file.includes("daily_purge.before")) expect(last, file).toMatch(/\bas verdict\b/);
      expect(withoutComments(sql), file).not.toMatch(/raise\s+notice/i);
    });
  }

  it("the combined decision-7 verify file is gone, and the pending SQL names the split ones", () => {
    expect(existsSync(path.join(root, "supabase/verify/20261114090000_drop_unsealed_plaintext.sql"))).toBe(false);
    const pending = read("supabase/pending/20261114090000_drop_unsealed_plaintext.sql");
    for (const part of ["before", "after", "count-control"]) expect(pending).toContain(`20261114090000_drop_unsealed_plaintext.${part}.sql`);
  });

  it("negative control: a file whose verdict is a NOTICE is caught", () => {
    const old = "select 1;\ndo $$ begin raise notice 'x: OK'; end $$;";
    expect(lastStatement(old)).toMatch(/^do\b/);
    expect(withoutComments(old)).toMatch(/raise\s+notice/i);
  });
});

describe("decision 7 keeps the Gmail approval link (R1-2)", () => {
  const sql = withoutComments(read("supabase/pending/20261114090000_drop_unsealed_plaintext.sql"));
  // The SQL string literal after `from`, with its doubled quotes undone.
  const pattern = sql.match(/substring\(e\.text_body from '((?:[^']|'')*)'\)/)?.[1]?.replace(/''/g, "'");

  it("moves the link from the body into forwarding_confirm_url in the update that drops the body", () => {
    expect(sql).toMatch(/forwarding_confirm_url = coalesce\(\s*e\.forwarding_confirm_url,\s*case when e\.classification = 'forwarding_confirmation'/);
    expect(sql).toContain("substring(e.html_body from");
    expect(pattern).toBeDefined();
  });

  it("its pattern finds every link the settings page would show (Postgres ARE, mirrored in JavaScript)", () => {
    // (?i) and [:space:] are ARE syntax; this is the same pattern for JavaScript.
    expect(pattern).toBe(`(?i)https://mail-settings\\.google\\.com/mail/[^[:space:]<>"')]*`);
    const mirror = /https:\/\/mail-settings\.google\.com\/mail\/[^\s<>"')]*/i;
    for (const body of [
      "確認: https://mail-settings.google.com/mail/vf-%5Bxyz%5D-abc",
      '<a href="https://mail-settings.google.com/mail/vf-abc?x=1&amp;y=2">confirm</a>',
      "(https://mail-settings.google.com/mail/u/0/?ui=2)",
    ]) {
      const shown = forwardingConfirmUrl(body);
      expect(shown, body).not.toBeNull();
      expect(body.match(mirror)?.[0], body).toBe(shown);
    }
    // What it moves but the page refuses is never shown: the page checks the link again.
    expect(forwardingConfirmUrl("HTTPS://MAIL-SETTINGS.GOOGLE.COM/mail/vf-abc")).toBeNull();
  });
});
