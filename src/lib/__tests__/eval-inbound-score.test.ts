import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Extraction } from "@/lib/extract/schema";
import { INBOUND_MIN_CONFIDENCE, missTable, scoreInbound, type InboundLabels, type InboundMail } from "../../../scripts/eval-inbound";
import { none, reading, sure } from "./pipeline-fixtures";

/**
 * The scoring of the sender-side `inbound` reading, fixed without the API: saved-reading look-alikes go in,
 * hits and misses come out. The labels are the real file in fixtures/eval-sent (made-up mails).
 * Readings are checked against the mail first, as the pipeline does, so quotations here come from MAIL.
 */

const labels = JSON.parse(readFileSync(path.join(process.cwd(), "fixtures/eval-sent/inbound-labels.json"), "utf8")) as InboundLabels;
const SENT = Object.keys(labels.false);
const COMING = Object.keys(labels.not_false);
const EITHER = Object.keys(labels.either ?? {});

/** `sure()` quotes "根拠の行"; this mail contains it. */
const MAIL: InboundMail = { subject: "テストのお知らせ", text: "テスト本文\n根拠の行", html: null };
type Field = Extraction["inbound"];

const read = (inbound: Field, tracking: string | null = null): Extraction => reading({ inbound, tracking_number: tracking === null ? none : sure(tracking) });
const falseWith = (confidence: number, tracking: string | null = null, evidence = "根拠の行") => read({ value: false, evidence, confidence }, tracking);
const stated = (value: boolean | null, confidence = 0.9) => read({ value, evidence: "根拠の行", confidence });

/** Every mail read as it should be, then entries replaced (null = the reading failed). */
function everyHit(override: Record<string, Extraction | null> = {}) {
  return [...SENT, ...COMING, ...EITHER].map((file) => ({
    file,
    mail: MAIL,
    data: file in override ? override[file] : SENT.includes(file) ? falseWith(0.95) : stated(true),
  }));
}

describe("scripts/eval.ts keeps its old paths", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/eval.ts"), "utf8");
  it("refuses --dir together with --write-demo-cache, so nothing outside the demo set is written to the demo cache", () => {
    expect(source).toMatch(/if \(dir && flag\("write-demo-cache"\)\) throw/);
  });
  it("still reads the demo set and its expected.json when no --dir is given", () => {
    expect(source).toContain('setName === "demo" ? await readDemoMails()');
    expect(source).toContain('"fixtures/demo/expected.json"');
  });
  it("hands the scoring the mail each reading came from, so quotations are checked against it", () => {
    expect(source).toContain("mail: { subject: r.mail.subject, text: r.mail.text, html: r.mail.html }");
  });
});

describe("the labels", () => {
  it("are 5 sent-side mails, 7 mails that must not be read as false and 1 that is not counted", () => {
    expect([SENT.length, COMING.length, EITHER.length]).toEqual([5, 7, 1]);
  });
});

describe("scoreInbound", () => {
  it("hits all 12 counted mails when every mail is read as it should be", () => {
    const score = scoreInbound(labels, everyHit());
    expect([score.hit, score.total]).toEqual([12, 12]);
  });

  it("a sent-side mail read as null or true misses", () => {
    for (const data of [stated(null, 0), stated(true, 0.95)]) {
      const score = scoreInbound(labels, everyHit({ [SENT[0]]: data }));
      expect(score.rows.filter((r) => r.counted && !r.ok).map((r) => r.file)).toEqual([SENT[0]]);
    }
  });

  it("a false at confidence 0.59 misses and at 0.6 hits (the matching code acts only from 0.6)", () => {
    expect(INBOUND_MIN_CONFIDENCE).toBe(0.6);
    const low = scoreInbound(labels, everyHit({ [SENT[1]]: falseWith(0.59) }));
    expect(low.rows.find((r) => r.file === SENT[1])).toMatchObject({ ok: false, kind: "false" });
    // The pipeline's own check turns a false under 0.6 into null before anything acts on it.
    expect(low.rows.find((r) => r.file === SENT[1])!.miss).toContain("inbound=null");
    const edge = scoreInbound(labels, everyHit({ [SENT[1]]: falseWith(0.6) }));
    expect(edge.rows.find((r) => r.file === SENT[1])!.ok).toBe(true);
  });

  it("a false that still keeps a tracking number misses", () => {
    const kept = scoreInbound(labels, everyHit({ [SENT[2]]: falseWith(0.95, "0006-3308-1720") }));
    expect(kept.rows.find((r) => r.file === SENT[2])!.miss).toContain("tracking_number kept");
  });

  it("a false quoting a line the mail does not contain misses: the pipeline would turn it into null and open a parcel", () => {
    const score = scoreInbound(labels, everyHit({ [SENT[0]]: falseWith(0.95, null, "メールに無い行") }));
    const row = score.rows.find((r) => r.file === SENT[0])!;
    expect(row.ok).toBe(false);
    expect(row.miss).toContain("inbound=null");
    expect(row.miss).toContain("quotation is not in the mail");
  });

  it("a tracking number whose quotation is not in the mail does not count as kept (the pipeline drops it too)", () => {
    const data = reading({ inbound: { value: false, evidence: "根拠の行", confidence: 0.95 }, tracking_number: { value: "0006-3308-1720", evidence: "メールに無い行", confidence: 0.95 } });
    expect(scoreInbound(labels, everyHit({ [SENT[2]]: data })).rows.find((r) => r.file === SENT[2])!.ok).toBe(true);
  });

  it("a mail that must not be false hits with true or null, and misses with a stated false", () => {
    for (const data of [stated(null, 0), stated(true), read(none)]) {
      expect(scoreInbound(labels, everyHit({ [COMING[0]]: data })).hit).toBe(12);
    }
    const bad = scoreInbound(labels, everyHit({ [COMING[0]]: falseWith(0.95) }));
    expect(bad.hit).toBe(11);
    expect(bad.rows.find((r) => r.file === COMING[0])).toMatchObject({ ok: false, kind: "not_false" });
  });

  it("a not-false mail with a false under 0.6 hits: the pipeline reads it as null and opens the parcel", () => {
    expect(scoreInbound(labels, everyHit({ [COMING[1]]: falseWith(0.3) })).hit).toBe(12);
  });

  it("a mail not read, or whose reading failed, misses with a reason", () => {
    const results = everyHit({ [SENT[3]]: null }).filter((r) => r.file !== COMING[2]);
    const score = scoreInbound(labels, results);
    expect(score.rows.find((r) => r.file === SENT[3])!.miss).toContain("reading failed");
    expect(score.rows.find((r) => r.file === COMING[2])!.miss).toBe("not read");
    expect(score.hit).toBe(10);
  });

  it("an either-mail is never counted, whatever it was read as, but is shown with what it was read as", () => {
    for (const data of [falseWith(0.95), stated(true), stated(null, 0)]) {
      const score = scoreInbound(labels, everyHit({ [EITHER[0]]: data }));
      expect([score.hit, score.total]).toEqual([12, 12]);
      expect(score.rows.find((r) => r.file === EITHER[0])).toMatchObject({ counted: false, ok: true });
    }
    const table = missTable(scoreInbound(labels, everyHit({ [EITHER[0]]: falseWith(0.95) })));
    expect(table).toContain("inbound: no misses");
    expect(table).toContain("not counted");
    expect(table).toContain(`${EITHER[0]} | inbound=false`);
  });

  it("lists each counted miss on its own line with the file, the kind and what missed", () => {
    const table = missTable(scoreInbound(labels, everyHit({ [SENT[0]]: falseWith(0.5), [COMING[0]]: falseWith(0.9) })));
    const lines = table.split("\n");
    expect(lines[0]).toContain("inbound misses");
    expect(lines[1]).toContain(`${SENT[0]} | false |`);
    expect(lines[2]).toContain(`${COMING[0]} | not_false |`);
  });
});
