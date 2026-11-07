import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ExtractionSchema, withDefaults, type Extraction } from "@/lib/extract/schema";
import { addDays, splitDate, todayJst } from "@/lib/format";
import { SAMPLE_ID_PREFIX } from "@/lib/mail-keys";
import type { InboundEmail, PipelineOptions } from "@/lib/pipeline";

/**
 * Demo data = anonymized real emails in `fixtures/demo/` (see README「持ち込んだデータ」), and a
 * made-up year of delivered orders in `fixtures/demo-history/` (written by
 * scripts/make-demo-history.ts) so the spend page has months to show.
 * Their dates are moved so that the story lands around today; the Claude results are
 * precomputed (`npm run eval -- --set demo --write-demo-cache` for the real mails, the script for
 * the history), so pressing the demo button costs nothing and never calls the API.
 * Only `fixtures/demo` is the accuracy set: readDemoMails, which scripts/eval.ts reads, has no history.
 */
const Mail = z.object({
  file: z.string(),
  source: z.string(),
  stage: z.string(),
  message_id: z.string().nullable(),
  date: z.string().nullable(),
  from: z.string(),
  from_name: z.string().nullable(),
  subject: z.string(),
  text: z.string().nullable(),
  html: z.string().nullable(),
});
export type DemoMail = z.infer<typeof Mail>;

const DemoSet = z.object({
  groups: z.array(
    z.object({
      name: z.string(),
      /** This calendar date in the mails becomes today + target. */
      anchor: z.string(),
      target: z.number().int(),
      files: z.array(z.string()),
    }),
  ),
});

const DEMO_DIR = path.join(process.cwd(), "fixtures", "demo");
const HISTORY_DIR = path.join(process.cwd(), "fixtures", "demo-history");
/** What the sample loads: the anonymized real mails, then the made-up order history. Each has its own set.json and extractions.json. */
const SAMPLE_DIRS = [DEMO_DIR, HISTORY_DIR];

function mailPath(dir: string, file: string): string {
  if (!/^[a-z]+\/[\w-]+$/.test(file)) throw new Error(`demo set: unexpected path ${file}`);
  return path.join(dir, "mails", `${file.replace("/", "__")}.json`);
}

const WEEKDAYS = "日月火水木金土";

function shiftParts(y: number, m: number, d: number, days: number) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: WEEKDAYS[t.getUTCDay()] };
}

const DATE_RE = /(?<![\d\-/年月])(?:(\d{4})([/\-年]))?(\d{1,2})([/\-月])(\d{1,2})(日?)(\s*[(（][日月火水木金土][)）])?(?!\d)/g;

/**
 * Move every calendar date written in a mail by `days`, keeping its format.
 * Handles 2026/05/26（火）, 2026-11-02, 2026年9月5日(土), 10月16日(金) and 木曜.
 * Order and tracking numbers do not match because a date must not follow a digit or hyphen.
 */
export function shiftDatesInText(text: string, days: number, contextYear: number): string {
  if (days === 0) return text;
  const out = text.replace(DATE_RE, (match, y: string | undefined, sep1: string | undefined, mo: string, sep2: string, da: string, nichi: string, wd: string | undefined) => {
    if (!y && sep2 !== "月") return match; // "10/17" alone is too ambiguous to rewrite
    if (sep2 === "月" && !nichi) return match;
    const month = Number(mo);
    const day = Number(da);
    if (month < 1 || month > 12 || day < 1 || day > 31) return match;
    const s = shiftParts(y ? Number(y) : contextYear, month, day, days);
    const pad = (n: number, like: string) => (like.startsWith("0") || (sep2 !== "月" && like.length === 2) ? String(n).padStart(2, "0") : String(n));
    const weekday = wd ? wd.replace(/[日月火水木金土]/, s.wd) : "";
    return `${y ? `${s.y}${sep1}` : ""}${pad(s.m, mo)}${sep2}${pad(s.d, da)}${nichi}${weekday}`;
  });
  return out.replace(/([日月火水木金土])曜/g, (_m, w: string) => {
    const moved = (WEEKDAYS.indexOf(w) + (days % 7) + 7) % 7;
    return `${WEEKDAYS[moved]}曜`;
  });
}

/** Apply `shiftDatesInText` to every string in a JSON-like value. */
export function shiftDatesDeep<T>(value: T, days: number, contextYear: number): T {
  if (typeof value === "string") return shiftDatesInText(value, days, contextYear) as T;
  if (Array.isArray(value)) return value.map((v) => shiftDatesDeep(v, days, contextYear)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftDatesDeep(v, days, contextYear)])) as T;
  }
  return value;
}

function daysBetween(from: string, to: string): number {
  const a = splitDate(from);
  const b = splitDate(to);
  if (!a || !b) throw new Error(`bad date: ${from} ${to}`);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** A mail sent later today has not arrived yet in the morning: pull it back, keeping the order of the story. */
function keepMailsInThePast(entries: DemoEntry[], now: Date): DemoEntry[] {
  let latest = now.getTime();
  return entries
    .slice()
    .reverse()
    .map((entry) => {
      if (!entry.mail.date) return entry;
      const sent = Math.min(new Date(entry.mail.date).getTime(), latest);
      latest = sent - 60_000;
      return { ...entry, mail: { ...entry.mail, date: new Date(sent).toISOString() } };
    })
    .reverse();
}

/** The anonymized real mails only (the accuracy set scripts/eval.ts scores), never the made-up history. */
export async function readDemoMails(): Promise<DemoMail[]> {
  const set = DemoSet.parse(JSON.parse(await readFile(path.join(DEMO_DIR, "set.json"), "utf8")));
  const mails: DemoMail[] = [];
  for (const g of set.groups) {
    for (const f of g.files) mails.push(Mail.parse(JSON.parse(await readFile(mailPath(DEMO_DIR, f), "utf8"))));
  }
  return mails;
}

export interface DemoEntry {
  mail: DemoMail;
  extraction: Extraction;
}

/**
 * Every sample mail (the real ones and the made-up history) with dates moved around `today`,
 * oldest first, each with its precomputed Claude result.
 */
export async function loadDemoEntries(today = todayJst(), now = new Date()): Promise<DemoEntry[]> {
  const entries: DemoEntry[] = [];
  const seen = new Set<string>();
  for (const dir of SAMPLE_DIRS) {
    const set = DemoSet.parse(JSON.parse(await readFile(path.join(dir, "set.json"), "utf8")));
    const cache = z
      // The cache was written before some fields existed; those are filled with "not stated".
      .record(z.string(), ExtractionSchema.partial({ package_description: true, expected_date_end: true, other_orders: true, category: true }).transform((x) => withDefaults(x as Extraction)))
      .parse(JSON.parse(await readFile(path.join(dir, "extractions.json"), "utf8")));
    for (const g of set.groups) {
      const days = daysBetween(g.anchor, addDays(today, g.target));
      const year = Number(g.anchor.slice(0, 4));
      for (const f of g.files) {
        const mail = Mail.parse(JSON.parse(await readFile(mailPath(dir, f), "utf8")));
        const extraction = cache[mail.file];
        if (!extraction) throw new Error(`demo set: ${mail.file} has no precomputed extraction`);
        // The file name is the mail's id in the database (demoInput): two of one name would be one mail.
        if (seen.has(mail.file)) throw new Error(`demo set: ${mail.file} appears twice`);
        seen.add(mail.file);
        entries.push({
          mail: {
            ...mail,
            subject: shiftDatesInText(mail.subject, days, year),
            text: mail.text === null ? null : shiftDatesInText(mail.text, days, year),
            html: mail.html === null ? null : shiftDatesInText(mail.html, days, year),
            date: mail.date ? new Date(new Date(mail.date).getTime() + days * 86_400_000).toISOString() : null,
          },
          extraction: shiftDatesDeep(extraction, days, year),
        });
      }
    }
  }
  entries.sort((a, b) => (a.mail.date ?? "").localeCompare(b.mail.date ?? ""));
  return keepMailsInThePast(entries, now);
}

/**
 * How a sample mail goes into the pipeline: its precomputed Claude result and publicSample, so the
 * API is never called and the mail stays readable. The one place both the demo loader and the
 * re-read of waiting mail (設定 › うまく届かないとき) get this shape from.
 */
export function demoInput(entry: DemoEntry, userId: string): { mail: InboundEmail; options: PipelineOptions } {
  const { mail, extraction } = entry;
  return {
    mail: {
      userId,
      providerEmailId: `${SAMPLE_ID_PREFIX}${mail.file}`,
      messageId: `${SAMPLE_ID_PREFIX}${mail.file}`,
      from: mail.from,
      fromName: mail.from_name,
      subject: mail.subject,
      sentAt: mail.date,
      text: mail.text,
      html: mail.html,
    },
    options: {
      publicSample: true,
      precomputed: {
        data: extraction,
        model: "precomputed",
        truncated: false,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  };
}
