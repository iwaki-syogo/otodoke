/**
 * How the free pre-check behaves on local mail. No API calls.
 *   npx tsx scripts/measure-screen.ts
 * Reads fixtures/anonymized (all purchase-related) and fixtures/raw/noise (ads, with labels).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { screenMail } from "../src/lib/screen";

const root = process.cwd();
const csv = readFileSync(path.join(root, "fixtures/anonymized/index.csv"), "utf8").trim().split("\n").slice(1);
const stages = new Map<string, { total: number; dropped: string[] }>();
for (const line of csv) {
  const file = line.split(",")[0].replace(/\.eml$/, "");
  const m = JSON.parse(readFileSync(path.join(root, "fixtures/anonymized", `${file}.json`), "utf8"));
  const r = screenMail(m);
  const s = stages.get(m.stage) ?? { total: 0, dropped: [] };
  s.total++;
  if (!r.pass) s.dropped.push(`${m.subject.slice(0, 40)} [${r.reason}]`);
  stages.set(m.stage, s);
}
let total = 0;
let dropped = 0;
for (const [stage, s] of stages) {
  total += s.total;
  dropped += s.dropped.length;
  console.log(`${stage}: kept ${s.total - s.dropped.length}/${s.total}`);
  for (const d of s.dropped) console.log(`   DROPPED ${d}`);
}
console.log(`purchase-related: kept ${total - dropped}/${total}`);

const noiseDir = path.join(root, "fixtures/raw/noise-json");
if (existsSync(noiseDir)) {
  console.log("--- labelled sample");
  for (const f of readdirSync(noiseDir).sort()) {
    const m = JSON.parse(readFileSync(path.join(noiseDir, f), "utf8"));
    const r = screenMail(m);
    console.log(`${r.pass ? "PASS" : "drop"} | ${m.subject.slice(0, 44)} | ${r.reason}`);
  }
}
