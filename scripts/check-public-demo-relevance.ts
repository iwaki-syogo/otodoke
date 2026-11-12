/**
 * Replay only the two tracked public sample sets through the real pipeline, offline.
 * Prints aggregate counts only; never writes a report or reads private fixture directories.
 * Usage: npx tsx scripts/check-public-demo-relevance.ts
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withDefaults, type Extraction } from "../src/lib/extract/schema";
import { evidenceIsPresent, hasUnverifiedUnrelatedVerdict, verifyEvidence } from "../src/lib/extract/verify-evidence";
import { buildParcelInsert, startsParcel } from "../src/lib/match";
import { processInboundEmail, type InboundEmail } from "../src/lib/pipeline";
import { beginSampleLoad } from "../src/lib/sample-generation-db";
import { FakeDb } from "../src/lib/__tests__/fake-db";
import { asAdmin, precomputed, reading, USER } from "../src/lib/__tests__/pipeline-fixtures";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicSets = ["demo", "demo-history"] as const;
type Entry = { mail: InboundEmail; extraction: Extraction };

async function entries(set: typeof publicSets[number]): Promise<Entry[]> {
  const directory = path.join(root, "fixtures", set);
  const inventory = JSON.parse(await readFile(path.join(directory, "set.json"), "utf8")) as { groups: { files: string[] }[] };
  const cache = JSON.parse(await readFile(path.join(directory, "extractions.json"), "utf8")) as Record<string, Extraction>;
  const files = inventory.groups.flatMap((group) => group.files);
  assert.equal(new Set(files).size, files.length, "public set contains duplicate entries");
  assert.equal((await readdir(path.join(directory, "mails"))).filter((file) => file.endsWith(".json")).length, files.length);
  assert.equal(Object.keys(cache).length, files.length, "each public mail must have one saved extraction");
  return Promise.all(files.map(async (file) => {
    assert.match(file, /^[a-z]+\/[\w-]+$/);
    const saved = JSON.parse(await readFile(path.join(directory, "mails", file.replace("/", "__") + ".json"), "utf8"));
    assert.equal(typeof saved.file, "string");
    assert.ok(cache[saved.file], "public mail is missing its saved extraction");
    return {
      mail: {
        userId: USER, providerEmailId: `demo:${saved.file}`, messageId: `demo:${saved.file}`,
        from: saved.from, fromName: saved.from_name, subject: saved.subject,
        sentAt: saved.date, text: saved.text, html: saved.html,
      },
      extraction: withDefaults(cache[saved.file]),
    };
  }));
}

async function replay(input: Entry[]) {
  const db = new FakeDb();
  const scoped = await beginSampleLoad(asAdmin(db), USER);
  const counts = {
    mails: input.length, precomputedReadings: input.length, unrelated: 0, unrelatedQuoteMismatch: 0,
    legacyParcelCandidates: 0, legacyEmptyParcelCandidates: 0, retainedUnverifiedMails: 0,
    discarded: 0, processed: 0, noted: 0,
  };
  const sorted = [...input].sort((a, b) => (a.mail.sentAt ?? "") < (b.mail.sentAt ?? "") ? -1 : (a.mail.sentAt ?? "") > (b.mail.sentAt ?? "") ? 1 : 0);
  for (const entry of sorted) {
    const verified = verifyEvidence(entry.extraction, entry.mail);
    if (entry.extraction.relevance === "unrelated") {
      counts.unrelated++;
      if (!evidenceIsPresent(entry.extraction.relevance_evidence, entry.mail)) {
        counts.unrelatedQuoteMismatch++;
        // Reproduce the removed rewrite, without changing the current verifier or pipeline.
        const legacy = { ...verified, relevance: "order" as const };
        if (startsParcel(legacy)) {
          counts.legacyParcelCandidates++;
          const parcel = buildParcelInsert(USER, legacy, entry.mail.sentAt);
          if (parcel.status === "unknown" && parcel.title === null && parcel.order_number === null
              && parcel.tracking_number === null && parcel.total_amount === null && parcel.expected_date === null) {
            counts.legacyEmptyParcelCandidates++;
          }
        }
      }
    }
    const outcome = await processInboundEmail(scoped, entry.mail, { publicSample: true, precomputed: precomputed(entry.extraction) });
    assert.ok(["processed", "noted", "discarded"].includes(outcome.kind), "offline public replay must complete each mail");
    if (outcome.kind === "processed") counts.processed++;
    if (outcome.kind === "noted") counts.noted++;
    if (outcome.kind === "discarded") counts.discarded++;
    if (hasUnverifiedUnrelatedVerdict(verified)) {
      const kept = db.rows("emails").find((mail) => mail.message_id === entry.mail.messageId);
      assert.ok(kept && kept.processing_status === "failed" && kept.body_state === "plain");
      assert.equal(kept.text_body, entry.mail.text);
      assert.equal(kept.html_body, entry.mail.html);
      assert.equal(db.rows("extractions").filter((reading) => reading.email_id === kept.id).length, 0);
      counts.retainedUnverifiedMails++;
    }
  }
  const paidClaims = db.rpcCalls.filter((call) => /claude_call/.test(call.name)
    || call.name === "mail_run_write" && (call.args as { p_operation?: string }).p_operation === "claim").length;
  assert.equal(paidClaims, 0, "public replay must not acquire a paid allowance");
  return {
    ...counts, parcels: db.rows("parcels").length, extractionRows: db.rows("extractions").length,
    retainedEmails: db.rows("emails").length,
    failedUnreadEmails: db.rows("emails").filter((mail) => mail.processing_status === "failed" && mail.body_state === "plain").length,
    unrelatedMismatchRate: counts.unrelated === 0 ? null : counts.unrelatedQuoteMismatch / counts.unrelated,
    paidClaims,
  };
}

async function main() {
  let networkAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkAttempts++; throw new Error("public replay forbids network access"); };
  try {
    const sets = await Promise.all(publicSets.map((set) => entries(set)));
    const results = Object.fromEntries(await Promise.all(sets.map(async (set, index) => [publicSets[index], await replay(set)])));
    const combined = await replay(sets.flat());
    // These controls exercise the otherwise empty unrelated denominator in the public caches.
    // Their rate describes only the constructed cases, never the frequency in real mail.
    const syntheticControls = await replay([null, "今月のおすすめをご紹介します。", "今週のおすすめをご紹介します。"].map((evidence, index) => ({
      mail: {
        userId: USER, providerEmailId: `demo:synthetic-control-${index}`, messageId: `demo:synthetic-control-${index}`,
        from: "synthetic@example.test", fromName: null, subject: "今週のセール案内", sentAt: "2026-11-12T00:00:00Z",
        text: "今週のおすすめをご紹介します。配信停止はこちら。", html: null,
      },
      extraction: reading({ relevance: "unrelated", relevance_evidence: evidence }),
    })));
    assert.equal(syntheticControls.unrelated, 3);
    assert.equal(syntheticControls.unrelatedQuoteMismatch, 2);
    assert.equal(syntheticControls.legacyEmptyParcelCandidates, 2);
    assert.equal(syntheticControls.retainedUnverifiedMails, 2);
    assert.equal(syntheticControls.failedUnreadEmails, 2);
    assert.equal(syntheticControls.discarded, 1);
    assert.equal(syntheticControls.parcels, 0);
    assert.equal(syntheticControls.extractionRows, 0);
    assert.equal(networkAttempts, 0);
    console.log(JSON.stringify({ sets: results, combined, syntheticControls, networkAttempts }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error: unknown) => {
  const site = error instanceof Error ? error.stack?.split("\n").find((line) => line.trimStart().startsWith("at ")) : undefined;
  console.error(JSON.stringify({ failed: true, error: error instanceof Error ? error.name : "unknown", site }));
  process.exitCode = 1;
});
