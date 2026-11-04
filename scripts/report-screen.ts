/**
 * How the pre-check is doing in production. Read-only, no Claude calls.
 *   npm run report:screen
 * Prints counts and sender domains only: never a subject or a body of a user's mail.
 */
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { readAll } from "../src/lib/supabase/read-all";

process.loadEnvFile(path.join(process.cwd(), [".env", "local"].join(".")));

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  // Every event, past the 1000-row cap (a `.limit` above it is still cut at 1000): the counts below are read as totals.
  const events = await readAll<{ decision: string; reason: string | null; from_domain: string | null; flagged_at: string | null }>(() =>
    db.from("screen_events").select("decision, reason, from_domain, flagged_at", { count: "exact" }),
  );
  const { count: read } = await db.from("extractions").select("id", { count: "exact", head: true });
  const { count: parcels } = await db.from("parcels").select("id", { count: "exact", head: true });
  const { count: noOrder } = await db.from("parcels").select("id", { count: "exact", head: true }).is("ordered_at", null);
  const { count: waiting } = await db.from("emails").select("id", { count: "exact", head: true }).eq("processing_status", "over_limit");

  const dropped = events.filter((e) => e.decision === "dropped");
  const rescued = events.filter((e) => e.decision === "rescued");
  const flagged = events.filter((e) => e.flagged_at);

  console.log(`read by Claude: ${read} | dropped free: ${dropped.length} | rescued by second check: ${rescued.length}`);
  console.log(`waiting over the limit: ${waiting}`);
  console.log(`parcels: ${parcels} | with no order date: ${noOrder} (a high share can mean order mails are being lost)`);
  console.log(`marked as wrongly dropped by users: ${flagged.length}`);
  const byDomain = new Map<string, number>();
  for (const e of flagged) byDomain.set(e.from_domain ?? "?", (byDomain.get(e.from_domain ?? "?") ?? 0) + 1);
  for (const [domain, n] of byDomain) console.log(`   ${domain}: ${n}  → get a sample from a consenting user, add it to the regression set, fix the rule`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
