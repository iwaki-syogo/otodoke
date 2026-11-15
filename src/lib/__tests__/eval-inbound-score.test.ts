import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INBOUND_MIN_CONFIDENCE, missTable, scoreInbound, type InboundLabels, type InboundReading } from "../../../scripts/eval-inbound";

/**
 * The scoring of the sender-side `inbound` reading, fixed without the API: saved-reading look-alikes go in,
 * hits and misses come out. The labels are the real file in fixtures/eval-sent (made-up mails).
 */

const labels = JSON.parse(readFileSync(path.join(process.cwd(), "fixtures/eval-sent/inbound-labels.json"), "utf8")) as InboundLabels;
const SENT = Object.keys(labels.false);
const COMING = Object.keys(labels.not_false);

const read = (inbound: InboundReading["inbound"], tracking: string | null = null): InboundReading => ({ inbound, tracking_number: { value: tracking } });
const falseWith = (confidence: number, tracking: string | null = null) => read({ value: false, confidence }, tracking);

/** Every mail read as it should be, then one entry replaced. */
function everyHit(override: Record<string, InboundReading | null> = {}) {
  return [...SENT, ...COMING].map((file) => ({
    file,
    data: file in override ? override[file] : SENT.includes(file) ? falseWith(0.95) : read({ value: true, confidence: 0.9 }),
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
});

describe("the labels", () => {
  it("are 5 sent-side mails and 8 mails that must not be read as false", () => {
    expect([SENT.length, COMING.length]).toEqual([5, 8]);
  });
});

describe("scoreInbound", () => {
  it("hits all 13 when every mail is read as it should be", () => {
    const score = scoreInbound(labels, everyHit());
    expect([score.hit, score.total]).toEqual([13, 13]);
    expect(missTable(score)).toBe("inbound: no misses");
  });

  it("a sent-side mail read as null or true misses", () => {
    for (const reading of [read({ value: null, confidence: 0 }), read({ value: true, confidence: 0.95 })]) {
      const score = scoreInbound(labels, everyHit({ [SENT[0]]: reading }));
      expect(score.rows.filter((r) => !r.ok).map((r) => r.file)).toEqual([SENT[0]]);
    }
  });

  it("a false at confidence 0.59 misses and at 0.6 hits (the matching code acts only from 0.6)", () => {
    expect(INBOUND_MIN_CONFIDENCE).toBe(0.6);
    const low = scoreInbound(labels, everyHit({ [SENT[1]]: falseWith(0.59) }));
    expect(low.rows.find((r) => r.file === SENT[1])).toMatchObject({ ok: false, kind: "false" });
    expect(low.rows.find((r) => r.file === SENT[1])!.miss).toContain("0.59");
    const edge = scoreInbound(labels, everyHit({ [SENT[1]]: falseWith(0.6) }));
    expect(edge.rows.find((r) => r.file === SENT[1])!.ok).toBe(true);
  });

  it("a false that still keeps a tracking number misses, and an empty string counts as none", () => {
    const kept = scoreInbound(labels, everyHit({ [SENT[2]]: falseWith(0.95, "0006-3308-1720") }));
    expect(kept.rows.find((r) => r.file === SENT[2])!.miss).toContain("tracking_number kept");
    const blank = scoreInbound(labels, everyHit({ [SENT[2]]: falseWith(0.95, "") }));
    expect(blank.rows.find((r) => r.file === SENT[2])!.ok).toBe(true);
  });

  it("a mail that must not be false hits with true or null, and misses with false", () => {
    for (const reading of [read({ value: null, confidence: 0 }), read({ value: true, confidence: 0.9 }), read(null)]) {
      expect(scoreInbound(labels, everyHit({ [COMING[0]]: reading })).hit).toBe(13);
    }
    const bad = scoreInbound(labels, everyHit({ [COMING[0]]: falseWith(0.95) }));
    expect(bad.hit).toBe(12);
    expect(bad.rows.find((r) => r.file === COMING[0])).toMatchObject({ ok: false, kind: "not_false" });
  });

  it("a not-false mail with a low-confidence false still misses (the score does not hide a stated false)", () => {
    expect(scoreInbound(labels, everyHit({ [COMING[1]]: falseWith(0.3) })).hit).toBe(12);
  });

  it("a mail not read, or whose reading failed, misses with a reason", () => {
    const results = everyHit({ [SENT[3]]: null }).filter((r) => r.file !== COMING[2]);
    const score = scoreInbound(labels, results);
    expect(score.rows.find((r) => r.file === SENT[3])!.miss).toContain("reading failed");
    expect(score.rows.find((r) => r.file === COMING[2])!.miss).toBe("not read");
    expect(score.hit).toBe(11);
  });

  it("lists each miss on its own line with the file, the kind and what missed", () => {
    const table = missTable(scoreInbound(labels, everyHit({ [SENT[0]]: falseWith(0.5), [COMING[0]]: falseWith(0.9) })));
    const lines = table.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`${SENT[0]} | false |`);
    expect(lines[2]).toContain(`${COMING[0]} | not_false |`);
  });
});
