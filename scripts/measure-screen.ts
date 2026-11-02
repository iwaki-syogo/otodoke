/**
 * Regression gate for the free pre-check. No API calls, no cost.
 *   npm run check:screen           exits 1 if a mail that must be kept is dropped
 *
 * Uses three local, git-ignored sets when they exist:
 *   fixtures/anonymized/           mails that must be kept (the set the rules were first written from)
 *   fixtures/raw/screen/keep/*.json  real notices from shops the rules were not written from
 *   fixtures/raw/screen/drop/*.json  ads and unrelated mail, including ones that look like notices
 * The public fixtures/demo set is checked by `npm test`, so CI still has a gate without them.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { screenMail } from "../src/lib/screen";

const root = process.cwd();
type Mail = { subject: string; text: string | null; html: string | null };

function readDir(rel: string): Mail[] {
  const dir = path.join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Mail);
}

function readAnonymized(): Mail[] {
  const index = path.join(root, "fixtures/anonymized/index.csv");
  if (!existsSync(index)) return [];
  return readFileSync(index, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => JSON.parse(readFileSync(path.join(root, "fixtures/anonymized", `${l.split(",")[0].replace(/\.eml$/, "")}.json`), "utf8")) as Mail);
}

function report(name: string, mails: Mail[], wantPass: boolean): number {
  const wrong = mails.filter((m) => screenMail(m).pass !== wantPass);
  console.log(`${name}: ${mails.length - wrong.length}/${mails.length} ${wantPass ? "kept" : "dropped"}`);
  for (const m of wrong) console.log(`   ${wantPass ? "LOST" : "extra"} | ${m.subject.slice(0, 50)} | ${screenMail(m).reason}`);
  return wrong.length;
}

const lostKnown = report("known shops", readAnonymized(), true);
const lostNew = report("shops the rules were not written from", readDir("fixtures/raw/screen/keep"), true);
report("ads and unrelated mail", readDir("fixtures/raw/screen/drop"), false);

// Losing a parcel is the failure that matters. An extra pass only costs one Claude call.
if (lostKnown + lostNew > 0) {
  console.error(`FAILED: ${lostKnown + lostNew} parcel mail(s) would be dropped`);
  process.exit(1);
}
