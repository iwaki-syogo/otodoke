/**
 * Give a category to one person's parcels that have none. A one-off for parcels read before
 * categories existed. --apply CALLS THE PAID CLAUDE API and writes to the database.
 *
 *   npx tsx scripts/categorize.ts --user <email>                        dry run: counts and a cost estimate only
 *   npx tsx scripts/categorize.ts --user <email> --apply --max-usd 0.5  categorize and write
 *
 * Sends only each parcel's title, item names and shop, 40 parcels per call. A failed call is
 * never retried (it may have been billed); the run stops there. Before each call its cost is
 * reserved from --max-usd on a generous estimate, and the run stops before passing the limit.
 * Writes only where the category is still empty and was not chosen by the person, with
 * category_source = "auto". The ids written go to fixtures/raw/categorize/ (git-ignored): to undo,
 * set category and category_source back to null on those ids where category_source is still "auto".
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
process.loadEnvFile(path.join(root, [".env", "local"].join(".")));

const MODEL = "claude-haiku-5-5";
/** Characters of one item name or title sent; the start of a name says what it is. */
const NAME_CHARS = 80;
const ITEMS_PER_PARCEL = 5;
/** Room for the output schema the API adds to the prompt. */
const SCHEMA_CHARS = 3000;
/** One answer is an id and a key in JSON: well under 80 tokens. */
const maxTokensFor = (parcels: number) => 200 + 80 * parcels;

interface Target {
  id: string;
  shop: string;
  title: string | null;
  category_source: string | null;
  items: string[];
}

async function main() {
  const { parseCategorizeArgs, toBatches, acceptAnswers, estimateCallUsd, createBudget, affordableCount } = await import("../src/lib/categorize");

  let args: ReturnType<typeof parseCategorizeArgs>;
  try {
    args = parseCategorizeArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error("usage: npx tsx scripts/categorize.ts --user <email> [--dry-run | --apply --max-usd <usd>]");
    process.exit(2);
  }

  // Imported after the env file is loaded: env() reads process.env once.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const { z } = await import("zod");
  const { CATEGORIES, categoryLabel } = await import("../src/lib/category");
  const { categoryForUpdate } = await import("../src/lib/match/category");
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { beginMailGeneration } = await import("../src/lib/sample-generation-db");
  const { readAll } = await import("../src/lib/supabase/read-all");
  const { requireEnv } = await import("../src/lib/env");
  const { PRICES } = await import("./prices");

  const price = PRICES[MODEL];
  if (!price) throw new Error(`no price known for ${MODEL}; add it to scripts/prices.ts after checking the pricing page`);

  let db = createAdminClient();
  const userId = await findUserId(db, args.user);
  // An apply run fixes its owner and clear generation before any paid work; dry-run stays read-only.
  if (args.apply) db = await beginMailGeneration(db, userId);

  // Only parcels with no category that the person has not set themselves.
  const parcels = await readAll<{ id: string; shop: string; title: string | null; category_source: string | null }>(() =>
    db
      .from("parcels")
      .select("id, shop, title, category_source", { count: "exact" })
      .eq("user_id", userId)
      .is("category", null)
      .or("category_source.is.null,category_source.neq.user")
      .order("created_at", { ascending: true }),
  );
  const items = await readAll<{ parcel_id: string; name: string }>(() =>
    db.from("parcel_items").select("parcel_id, name", { count: "exact" }).eq("user_id", userId).order("parcel_id", { ascending: true }),
  );
  const namesOf = new Map<string, string[]>();
  for (const it of items) {
    const names = namesOf.get(it.parcel_id) ?? [];
    names.push(it.name);
    namesOf.set(it.parcel_id, names);
  }
  const targets: Target[] = parcels.map((p) => ({ ...p, items: namesOf.get(p.id) ?? [] }));

  const system = [
    "買い物の荷物を、支出の分類 7 つのどれかに分けます。",
    `分類: ${CATEGORIES.map((c) => `${c}=${categoryLabel(c)}`).join(" / ")}`,
    "各荷物の店・品名・品目名から判断し、荷物ごとに id とその分類を 1 つ返してください。",
    "id は入力のものをそのまま使います。品名も店も分からず判断できない荷物は category を null にしてください。",
  ].join("\n");
  const userText = (batch: Target[]) =>
    batch
      .map((t) =>
        JSON.stringify({
          id: t.id,
          shop: t.shop.slice(0, NAME_CHARS),
          title: t.title?.slice(0, NAME_CHARS) ?? null,
          items: t.items.slice(0, ITEMS_PER_PARCEL).map((n) => n.slice(0, NAME_CHARS)),
        }),
      )
      .join("\n");
  const estimateFor = (batch: Target[]) =>
    estimateCallUsd({ inputChars: system.length + userText(batch).length + SCHEMA_CHARS, maxTokens: maxTokensFor(batch.length) }, price);

  const batches = toBatches(targets);
  const estimate = batches.reduce((sum, b) => sum + estimateFor(b), 0);
  console.log(`parcels to categorize: ${targets.length} | calls: ${batches.length} | estimated at most: $${estimate.toFixed(4)} (${MODEL})`);
  if (!args.apply || targets.length === 0) {
    if (!args.apply) console.log("dry run: nothing was sent or written. Add --apply --max-usd <usd> to run.");
    return;
  }

  const maxUsd = args.maxUsd!;
  const Answer = z.object({
    answers: z.array(z.object({ id: z.string(), category: z.enum(CATEGORIES).nullable() })),
  });
  // No automatic retries: a repeated request can be billed twice.
  const client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY"), maxRetries: 0 });
  const budget = createBudget(maxUsd);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const recordDir = path.join(root, "fixtures", "raw", "categorize");
  const recordFile = path.join(recordDir, `${stamp}.json`);
  await mkdir(recordDir, { recursive: true });
  const written: { id: string; category: string }[] = [];
  let calls = 0;
  let stopped: string | null = null;

  const record = () => writeFile(recordFile, JSON.stringify({ model: MODEL, user_id: userId, written }, null, 2) + "\n");

  outer: for (const batch of batches) {
    let queue = batch;
    while (queue.length > 0) {
      // A batch that does not fit is sent in a smaller part; one that cannot fit a single parcel stops the run.
      const n = affordableCount(queue, estimateFor, maxUsd - budget.spent());
      if (n === 0) {
        stopped = `the next call would pass --max-usd ${maxUsd}`;
        break outer;
      }
      const part = queue.slice(0, n);
      queue = queue.slice(n);
      const reserved = estimateFor(part);
      if (!budget.reserve(reserved)) {
        stopped = `the next call would pass --max-usd ${maxUsd}`;
        break outer;
      }

      let answers: unknown;
      try {
        calls++;
        const response = await client.messages.parse({
          model: MODEL,
          max_tokens: maxTokensFor(part.length),
          system,
          messages: [{ role: "user", content: userText(part) }],
          output_config: { format: zodOutputFormat(Answer) },
        });
        const u = response.usage;
        const actual =
          (u.input_tokens * price[0] + u.output_tokens * price[1] + (u.cache_read_input_tokens ?? 0) * price[2] + (u.cache_creation_input_tokens ?? 0) * price[3]) / 1_000_000;
        budget.settle(reserved, actual);
        answers = response.parsed_output?.answers ?? null;
      } catch (err) {
        // The reservation stays counted: the call may have been billed.
        console.error(`call ${calls} FAILED (may have been billed; not retried): ${err instanceof Error ? err.message : err}`);
        stopped = "a call failed";
        break outer;
      }

      const accepted = acceptAnswers(
        part.map((t) => t.id),
        answers,
      );
      for (const t of part) {
        const category = accepted.get(t.id);
        if (!category) continue;
        const fields = categoryForUpdate({ category: null, category_source: t.category_source }, category, false);
        if (!fields.category) continue;
        // Guarded in the database too: the person may have chosen a category since it was read.
        const { data, error } = await db
          .from("parcels")
          .update(fields)
          .eq("id", t.id)
          .eq("user_id", userId)
          .is("category", null)
          .or("category_source.is.null,category_source.neq.user")
          .select("id");
        if (error) {
          await record();
          throw new Error(`parcels update failed: ${error.message}`);
        }
        if (data.length === 1) written.push({ id: t.id, category: fields.category });
      }
      await record();
      process.stderr.write(`\rcalls ${calls} | written ${written.length}/${targets.length} | spent $${budget.spent().toFixed(4)}`);
    }
  }
  process.stderr.write("\n");
  console.log(`calls: ${calls} | written: ${written.length}/${targets.length} | spent at most: $${budget.spent().toFixed(4)}${stopped ? ` | STOPPED: ${stopped}` : ""}`);
  console.log(`written ids: ${path.relative(root, recordFile)}`);
}

/** The person's user id from their email, through the Auth admin API. */
async function findUserId(db: import("../src/lib/supabase/admin").AdminClient, email: string): Promise<string> {
  const want = email.trim().toLowerCase();
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    // listUsers fails as a whole when a row has NULL in a token column; say so rather than guess.
    if (error) throw new Error(`could not list users (a NULL token column in auth.users makes this fail): ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === want);
    if (hit) return hit.id;
    if (data.users.length < perPage) throw new Error("no user with that email");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
