/**
 * Replay a saved `npm run eval -- --set all` result through the real merge rules, offline.
 * Makes no API calls. Input and report stay in git-ignored fixtures/raw/eval/.
 *
 *   npx tsx scripts/replay.ts [path to the saved result]
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParcelInsert, buildParcelUpdate, chooseParcel, isOverdue, isParcelRelevant, parcelTotal, splitOrders, startsParcel, type ParcelCandidate } from "../src/lib/match";
import { normalizeTracking } from "../src/lib/carriers";
import { withDefaults, type Extraction } from "../src/lib/extract/schema";

const root = process.cwd();
const evalDir = path.join(root, "fixtures/raw/eval");

interface Saved {
  file: string;
  stage: string;
  data: Extraction | null;
}
interface Mail {
  file: string;
  date: string | null;
  from: string;
  subject: string;
}
interface MailLog {
  file: string;
  relevance: string;
  shopKey: string | null;
  subject: string;
  tracking: string | null;
  order: string | null;
  amount: number | null;
  expected: string | null;
  date: string | null;
}
interface Sim {
  row: ParcelCandidate;
  mails: MailLog[];
  read: Extraction[];
}

async function main() {
  const given = process.argv[2];
  const latest = (await readdir(evalDir)).filter((f) => f.includes("-all-")).sort().at(-1);
  const source = given ?? path.join(evalDir, latest ?? "");
  const saved = JSON.parse(await readFile(source, "utf8")) as Saved[];
  const rows = await Promise.all(
    saved.map(async (s) => ({
      s,
      mail: JSON.parse(await readFile(path.join(root, "fixtures/anonymized", `${s.file.replace(/\.eml$/, "")}.json`), "utf8")) as Mail,
    })),
  );
  rows.sort((a, b) => (a.mail.date ?? "").localeCompare(b.mail.date ?? ""));

  const sims: Sim[] = [];
  let discarded = 0;
  let noted = 0;
  const readings = rows.flatMap(({ s, mail }) => (s.data ? splitOrders(withDefaults(s.data)).map((x) => ({ s, mail, x })) : []));
  for (const { s, mail, x } of readings) {
    if (!isParcelRelevant(x.relevance)) {
      discarded++;
      continue;
    }
    const now = mail.date ?? new Date().toISOString();
    const chosen = chooseParcel(sims.map((p) => p.row), x, new Date(now));
    const hit = sims.find((p) => p.row === chosen);
    if (!hit && !startsParcel(x)) {
      noted++;
      continue;
    }
    const log: MailLog = {
      file: s.file,
      relevance: x.relevance,
      shopKey: x.shop_key ?? null,
      subject: mail.subject,
      tracking: x.tracking_number.value,
      order: x.order_number.value,
      amount: x.total_amount.value,
      expected: x.expected_date.value,
      date: mail.date,
    };
    if (hit) {
      Object.assign(hit.row, buildParcelUpdate(hit.row, x, mail.date));
      if (hit.row.itemNames.length === 0) hit.row.itemNames = x.items.map((i) => i.name);
      hit.mails.push(log);
      hit.read.push(x);
      hit.row.total_amount = parcelTotal(hit.read);
    } else {
      sims.push({
        row: { ...buildParcelInsert("replay", x, mail.date), id: String(sims.length), created_at: now, itemNames: x.items.map((i) => i.name), total_amount: parcelTotal([x]) } as unknown as ParcelCandidate,
        mails: [log],
        read: [x],
      });
    }
  }

  const count = <T,>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const newest = rows.at(-1)?.mail.date ?? new Date().toISOString();
  const checks = {
    mails: rows.length,
    discarded,
    noted,
    parcels: sims.length,
    byShop: count(sims, (p) => p.row.shop_key ?? "?"),
    byStatus: count(sims, (p) => p.row.status),
    noTitle: sims.filter((p) => !p.row.title).length,
    unknownShop: sims.filter((p) => p.row.shop === "不明な店").length,
    carrierNamedAsShop: sims.filter((p) => /運輸|急便|郵便|配送/.test(p.row.shop)).length,
    noAmount: sims.filter((p) => p.row.total_amount === null).length,
    needsReview: sims.filter((p) => p.row.needs_review).length,
    presence: sims.filter((p) => p.row.requires_presence === true).length,
    overdue: sims.filter((p) => isOverdue(p.row, newest.slice(0, 10))).length,
    spendable: sims.filter((p) => p.row.total_amount !== null && p.row.ordered_at && p.row.status !== "cancelled").reduce((sum, p) => sum + (p.row.total_amount ?? 0), 0),
    pricedNoDate: sims.filter((p) => p.row.total_amount !== null && !p.row.ordered_at).length,
    mixedShops: sims.filter((p) => new Set(p.mails.map((m) => m.shopKey)).size > 1).length,
    manyTracking: sims.filter((p) => new Set(p.mails.map((m) => m.tracking && normalizeTracking(m.tracking)).filter(Boolean)).size > 1).length,
    manyAmounts: sims.filter((p) => new Set(p.mails.map((m) => m.amount).filter((a) => a !== null)).size > 1).length,
    singleMailDelivered: sims.filter((p) => p.mails.length === 1 && p.row.status === "delivered").length,
    largest: Math.max(...sims.map((p) => p.mails.length)),
  };
  console.log(JSON.stringify(checks));
  await writeFile(path.join(evalDir, "replay.json"), JSON.stringify(sims.map((p) => ({ ...p.row, items: p.row.itemNames, mails: p.mails })), null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
