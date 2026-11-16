/**
 * Measure how well the extractor reads real mails. CALLS THE PAID CLAUDE API.
 *
 *   npm run eval -- --set demo [--write-demo-cache]   hand-labelled demo mails (fixtures/demo)
 *   npm run eval -- --set all  --max-usd 15           every local anonymized mail, relevance only
 *   npm run eval -- --dir fixtures/eval-sent --max-usd 0.30   a directory of made-up mails (mails/, expected.json,
 *                                                     optional inbound-labels.json for the sender-side score,
 *                                                     optional refund-labels.json for the refund score)
 *
 * Stops before starting another mail once `--max-usd` (default 1) has been spent.
 * Full results go to fixtures/raw/eval/ (git-ignored); a one-line summary goes to docs/eval-log.md.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { missTable, scoreInbound, type InboundLabels, type InboundResult } from "./eval-inbound";
import { refundMisreadLines, refundMissTable, scoreRefund, type RefundLabels, type RefundResult } from "./eval-refund";
import { PRICES } from "./prices";

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
/** A directory of made-up mails to read instead of a named set. The demo cache is never written from it. */
const dir = args.includes("--dir") ? path.resolve(root, opt("dir", "")) : null;
if (args.includes("--dir") && !opt("dir", "")) throw new Error("--dir needs a directory");
if (dir && flag("write-demo-cache")) throw new Error("--write-demo-cache is only for --set demo; it cannot be combined with --dir");
const setLabel = dir ? `dir:${path.basename(dir)}` : setName;

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

/** A made-up set kept in its own directory: `mails/*.json` and `expected.json` (and optionally `inbound-labels.json`). */
async function loadDir(base: string): Promise<Mail[]> {
  const names = (await readdir(path.join(base, "mails"))).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(names.map(async (f) => JSON.parse(await readFile(path.join(base, "mails", f), "utf8")) as Mail));
}

async function main() {
  // Imported after the env file is loaded: env() reads process.env once.
  const { extractEmail } = await import("../src/lib/extract/extract");
  const { emailBodyText } = await import("../src/lib/text/html-to-text");
  const { normalizeTracking } = await import("../src/lib/carriers");
  const { asTime, normalizeOrderNumber } = await import("../src/lib/match");
  const { readDemoMails } = await import("../src/lib/demo");
  const { env } = await import("../src/lib/env");

  const model = env().OTODOKE_MODEL;
  const price = PRICES[model];
  if (!price) throw new Error(`no price known for ${model}; add it to PRICES after checking the pricing page`);

  let mails: Mail[] = dir ? await loadDir(dir) : setName === "demo" ? await readDemoMails() : await loadAll();
  if (limit > 0) mails = mails.slice(0, limit);
  const expected: Expected = dir
    ? JSON.parse(await readFile(path.join(dir, "expected.json"), "utf8"))
    : setName === "demo" ? JSON.parse(await readFile(path.join(root, "fixtures/demo/expected.json"), "utf8")) : {};
  // The sender-side labels, when the directory carries them.
  const labels: InboundLabels | null = dir && existsSync(path.join(dir, "inbound-labels.json"))
    ? JSON.parse(await readFile(path.join(dir, "inbound-labels.json"), "utf8"))
    : null;
  // The refund and cancellation labels, when the directory carries them.
  const refundLabels: RefundLabels | null = dir && existsSync(path.join(dir, "refund-labels.json"))
    ? JSON.parse(await readFile(path.join(dir, "refund-labels.json"), "utf8"))
    : null;

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
    if (k === "expected_window_start" || k === "expected_window_end") return v === null ? null : asTime(String(v));
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
  console.log(`model=${model} set=${setLabel} mails=${results.length}/${mails.length} failed=${failed} spent=$${spent.toFixed(3)}${stopped ? " STOPPED AT BUDGET" : ""}`);
  console.log(`relevance ${relevanceOk}/${relevanceTotal}`);
  for (const [k, f] of Object.entries(fields)) console.log(`  ${k}: ${f.ok}/${f.total}`);
  if (misses.length) console.log("misses:\n  " + misses.join("\n  "));
  if (labels) {
    const score = scoreInbound(labels, results.map((r) => ({
      file: r.mail.file,
      // Checked against the mail as the pipeline does, so a quotation that is not in it counts for nothing.
      mail: { subject: r.mail.subject, text: r.mail.text, html: r.mail.html },
      data: r.data as InboundResult["data"],
      error: r.error,
    })));
    console.log(`inbound ${score.hit}/${score.total}`);
    console.log(missTable(score));
  }
  if (refundLabels) {
    const score = scoreRefund(refundLabels, results.map((r) => ({
      file: r.mail.file,
      // Checked against the mail as the pipeline does, so a quotation that is not in it counts for nothing.
      mail: { subject: r.mail.subject, text: r.mail.text, html: r.mail.html },
      data: r.data as RefundResult["data"],
      error: r.error,
    })));
    console.log(`refund ${score.hit}/${score.total}`);
    console.log(refundMissTable(score));
    console.log(refundMisreadLines(score));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(path.join(root, "fixtures/raw/eval"), { recursive: true });
  await writeFile(path.join(root, `fixtures/raw/eval/${stamp}-${setLabel}-${model}.json`), JSON.stringify(results.map((r) => ({ file: r.mail.file, stage: r.mail.stage, data: r.data, error: r.error })), null, 2));
  await appendFile(
    path.join(root, "docs/eval-log.md"),
    `| ${stamp.slice(0, 16)} | ${setLabel} | ${model} | ${results.length} | ${failed} | ${relevanceOk}/${relevanceTotal} | ${scored.ok}/${scored.total} | $${spent.toFixed(2)} |\n`,
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
