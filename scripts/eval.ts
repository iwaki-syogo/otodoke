/**
 * Measure how well the extractor reads real mails. CALLS THE PAID CLAUDE API.
 *
 *   npm run eval -- --set demo [--write-demo-cache]   hand-labelled demo mails (fixtures/demo)
 *   npm run eval -- --set all  --max-usd 15           every local anonymized mail, relevance only
 *
 * Stops before starting another mail once `--max-usd` (default 1) has been spent.
 * Full results go to fixtures/raw/eval/ (git-ignored); a one-line summary goes to docs/eval-log.md.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
process.loadEnvFile(path.join(root, [".env", "local"].join(".")));

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const setName = opt("set", "demo");
const maxUsd = Number(opt("max-usd", "1"));
const concurrency = Number(opt("concurrency", "4"));
const limit = Number(opt("limit", "0"));
if (args.includes("--model")) process.env.OTODOKE_MODEL = opt("model", "");

/** USD per million tokens: input, output, cache read, cache write. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.4, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
};

interface Mail {
  file: string;
  stage: string;
  date: string | null;
  from: string;
  from_name: string | null;
  subject: string;
  text: string | null;
  html: string | null;
}

type Expected = Record<string, Record<string, unknown>>;

/** What each pre-labelled stage may legitimately be read as. "other" is not scored. */
const STAGE_TO_RELEVANCE: Record<string, string[]> = {
  ordered: ["order"],
  payment: ["payment"],
  prescription: ["payment"],
  arranging: ["payment", "shipped"],
  shipped: ["shipped", "payment"],
  out_for_delivery: ["out_for_delivery"],
  delivered: ["delivered"],
  cancelled: ["cancelled"],
  subscription: ["other_purchase", "order", "cancelled", "unrelated"],
};

async function loadAll(): Promise<Mail[]> {
  const csv = await readFile(path.join(root, "fixtures/anonymized/index.csv"), "utf8");
  const files = csv
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(",")[0].replace(/\.eml$/, ""));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(root, "fixtures/anonymized", `${f}.json`), "utf8")) as Mail));
}

async function main() {
  // Imported after the env file is loaded: env() reads process.env once.
  const { extractEmail } = await import("../src/lib/extract/extract");
  const { emailBodyText } = await import("../src/lib/text/html-to-text");
  const { normalizeTracking } = await import("../src/lib/carriers");
  const { normalizeOrderNumber } = await import("../src/lib/match");
  const { readDemoMails } = await import("../src/lib/demo");
  const { env } = await import("../src/lib/env");

  const model = env().OTODOKE_MODEL;
  const price = PRICES[model];
  if (!price) throw new Error(`no price known for ${model}; add it to PRICES after checking the pricing page`);

  let mails: Mail[] = setName === "demo" ? await readDemoMails() : await loadAll();
  if (limit > 0) mails = mails.slice(0, limit);
  const expected: Expected =
    setName === "demo" ? JSON.parse(await readFile(path.join(root, "fixtures/demo/expected.json"), "utf8")) : {};

  let spent = 0;
  let next = 0;
  let stopped = false;
  const results: Array<{ mail: Mail; data: Awaited<ReturnType<typeof extractEmail>>["data"] | null; error?: string }> = [];

  async function worker() {
    while (next < mails.length) {
      if (spent >= maxUsd) {
        stopped = true;
        return;
      }
      const mail = mails[next++];
      try {
        const r = await extractEmail({
          from: mail.from_name ? `${mail.from_name} <${mail.from}>` : mail.from,
          subject: mail.subject,
          sentAt: mail.date,
          body: emailBodyText(mail.text, mail.html),
        });
        const u = r.usage;
        spent +=
          (u.input_tokens * price[0] + u.output_tokens * price[1] + u.cache_read_input_tokens * price[2] + u.cache_creation_input_tokens * price[3]) / 1_000_000;
        results.push({ mail, data: r.data });
      } catch (err) {
        // A failed call may still have been billed, so it is reported and never retried here.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`FAILED ${mail.file} (may have been billed): ${message}`);
        results.push({ mail, data: null, error: message });
      }
      process.stderr.write(`\r${results.length}/${mails.length}  $${spent.toFixed(3)}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write("\n");

  // Relevance against the stage labels.
  let relevanceOk = 0;
  let relevanceTotal = 0;
  const misses: string[] = [];
  for (const { mail, data } of results) {
    const allowed = STAGE_TO_RELEVANCE[mail.stage];
    if (!allowed || !data) continue;
    relevanceTotal++;
    if (allowed.includes(data.relevance)) relevanceOk++;
    else misses.push(`relevance ${mail.file}: stage=${mail.stage} got=${data.relevance}`);
  }

  // Field accuracy against hand labels. Absent means "not scored"; null means "must be null".
  const fields: Record<string, { ok: number; total: number }> = {};
  const canon = (k: string, v: unknown) => {
    if (v === null || v === undefined) return null;
    if (k === "tracking_number") return normalizeTracking(String(v));
    if (k === "order_number") return normalizeOrderNumber(String(v));
    return v;
  };
  for (const { mail, data } of results) {
    const want = expected[mail.file];
    if (!want || !data) continue;
    for (const [k, v] of Object.entries(want)) {
      const raw = data[k as keyof typeof data];
      const got = k === "relevance" ? raw : (raw as { value: unknown } | null)?.value;
      const accepted = k === "relevance" && Array.isArray(v) ? v : [v];
      const f = (fields[k] ??= { ok: 0, total: 0 });
      f.total++;
      if (accepted.some((a) => canon(k, a) === canon(k, got))) f.ok++;
      else misses.push(`${k} ${mail.file}: want=${JSON.stringify(v)} got=${JSON.stringify(got)}`);
    }
  }

  const failed = results.filter((r) => r.error).length;
  const scored = Object.values(fields).reduce((a, f) => ({ ok: a.ok + f.ok, total: a.total + f.total }), { ok: 0, total: 0 });
  console.log(`model=${model} set=${setName} mails=${results.length}/${mails.length} failed=${failed} spent=$${spent.toFixed(3)}${stopped ? " STOPPED AT BUDGET" : ""}`);
  console.log(`relevance ${relevanceOk}/${relevanceTotal}`);
  for (const [k, f] of Object.entries(fields)) console.log(`  ${k}: ${f.ok}/${f.total}`);
  if (misses.length) console.log("misses:\n  " + misses.join("\n  "));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(path.join(root, "fixtures/raw/eval"), { recursive: true });
  await writeFile(path.join(root, `fixtures/raw/eval/${stamp}-${setName}-${model}.json`), JSON.stringify(results.map((r) => ({ file: r.mail.file, stage: r.mail.stage, data: r.data, error: r.error })), null, 2));
  await appendFile(
    path.join(root, "docs/eval-log.md"),
    `| ${stamp.slice(0, 16)} | ${setName} | ${model} | ${results.length} | ${failed} | ${relevanceOk}/${relevanceTotal} | ${scored.ok}/${scored.total} | $${spent.toFixed(2)} |\n`,
  );

  if (flag("write-demo-cache")) {
    if (setName !== "demo" || failed > 0 || stopped) throw new Error("demo cache needs a complete run of --set demo");
    const cache = Object.fromEntries(results.map((r) => [r.mail.file, r.data]));
    await writeFile(path.join(root, "fixtures/demo/extractions.json"), JSON.stringify(cache, null, 2) + "\n");
    console.log("wrote fixtures/demo/extractions.json");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
