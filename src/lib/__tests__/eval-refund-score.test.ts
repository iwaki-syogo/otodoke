import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Extraction } from "@/lib/extract/schema";
import { MISREAD_NOTE, REFUND_MIN_CONFIDENCE, refundMisreadLines, refundMissTable, scoreRefund, type RefundLabels, type RefundMail } from "../../../scripts/eval-refund";
import { none, reading, sure } from "./pipeline-fixtures";

/**
 * The scoring of the refund and cancellation reading, fixed without the API: saved-reading look-alikes go in,
 * hits and misses come out. The labels are the real file in fixtures/eval-refund (made-up mails).
 * Readings are checked against the mail first, as the pipeline does, so quotations here come from MAIL.
 */

const dir = path.join(process.cwd(), "fixtures/eval-refund");
const labels = JSON.parse(readFileSync(path.join(dir, "refund-labels.json"), "utf8")) as RefundLabels;
const KEEP = Object.keys(labels.no_cancel);
const CANCEL = Object.keys(labels.cancel);

/** `sure()` quotes "根拠の行"; this mail contains it. */
const MAIL: RefundMail = { subject: "テストのお知らせ", text: "テスト本文\n根拠の行", html: null };
type Field = Extraction["cancel_partial"];

const read = (relevance: Extraction["relevance"], cancel_partial: Field = none): Extraction => reading({ relevance, cancel_partial });
const partial = (confidence = 0.95, evidence = "根拠の行"): Field => ({ value: true, evidence, confidence });

/** Every mail read as it should be, then entries replaced (null = the reading failed). */
function everyHit(override: Record<string, Extraction | null> = {}) {
  return [...KEEP, ...CANCEL].map((file) => ({
    file,
    mail: MAIL,
    data: file in override ? override[file] : KEEP.includes(file) ? read("other_purchase") : read("cancelled", { value: false, evidence: "根拠の行", confidence: 0.95 }),
  }));
}

describe("the refund set in fixtures/eval-refund", () => {
  it("has labels, expected values and mails that name the same files", () => {
    const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as Record<string, unknown>;
    const mails = readdirSync(path.join(dir, "mails"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => (JSON.parse(readFileSync(path.join(dir, "mails", f), "utf8")) as { file: string }).file);
    const labelled = [...KEEP, ...CANCEL].sort();
    expect(mails.sort()).toEqual(labelled);
    expect(Object.keys(expected).sort()).toEqual(labelled);
    expect(KEEP.length).toBe(7);
    expect(CANCEL.length).toBe(3);
  });
  it("is read by scripts/eval.ts through --dir with its own score line", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/eval.ts"), "utf8");
    expect(source).toContain('path.join(dir, "refund-labels.json")');
    expect(source).toContain("scoreRefund(refundLabels");
    expect(source).toContain("console.log(`refund ${score.hit}/${score.total}`)");
  });
});

describe("scoreRefund", () => {
  it("scores every mail read as it should be as a hit", () => {
    const s = scoreRefund(labels, everyHit());
    expect(s.hit).toBe(10);
    expect(s.total).toBe(10);
    expect(refundMissTable(s)).toBe("refund: no misses");
  });

  it("a mail that must not cancel: anything but cancelled is a hit, and so is a sure partial cancellation", () => {
    const file = KEEP[0];
    for (const data of [read("other_purchase"), read("order"), read("cancelled", partial())]) {
      expect(scoreRefund(labels, everyHit({ [file]: data })).rows.find((r) => r.file === file)!.ok).toBe(true);
    }
  });

  it("a mail that must not cancel: cancelled whole, or with an unknown extent, is a miss", () => {
    const file = KEEP[0];
    for (const data of [read("cancelled"), read("cancelled", { value: false, evidence: "根拠の行", confidence: 0.95 })]) {
      const s = scoreRefund(labels, everyHit({ [file]: data }));
      expect(s.rows.find((r) => r.file === file)!.ok).toBe(false);
      expect(s.hit).toBe(9);
    }
  });

  it("a partial that is not sure (quotation holds, confidence under the minimum) is dropped by the evidence check like an unquoted one, so it is a hit on the no-cancel side", () => {
    const file = KEEP[1];
    const unsure = scoreRefund(labels, everyHit({ [file]: read("cancelled", partial(REFUND_MIN_CONFIDENCE - 0.1)) }));
    expect(unsure.rows.find((r) => r.file === file)!.ok).toBe(true);
  });

  it("a cancellation read as whole or with no extent stated is still a miss on the no-cancel side (the pipeline cancels it)", () => {
    const file = KEEP[1];
    for (const data of [read("cancelled"), read("cancelled", { value: false, evidence: "根拠の行", confidence: 0.95 })]) {
      expect(scoreRefund(labels, everyHit({ [file]: data })).rows.find((r) => r.file === file)!.ok).toBe(false);
    }
  });

  it("no-cancel side: a partial whose quotation is not in the mail is a hit (the pipeline cancels nothing and only flags the parcel for review)", () => {
    const file = KEEP[1];
    const dropped = scoreRefund(labels, everyHit({ [file]: read("cancelled", partial(0.95, "メールに無い行")) }));
    expect(dropped.rows.find((r) => r.file === file)!.ok).toBe(true);
    expect(dropped.hit).toBe(10);
  });

  it("cancel side: the same reading is a miss, a cancellation left out, and the table says the true was dropped", () => {
    const file = CANCEL[0];
    const s = scoreRefund(labels, everyHit({ [file]: read("cancelled", partial(0.95, "メールに無い行")) }));
    const row = s.rows.find((r) => r.file === file)!;
    expect(row.ok).toBe(false);
    expect(row.miss).toContain("the true was dropped");
    expect(s.hit).toBe(9);
  });

  it("a no-cancel hit that the model read as cancelled (a dropped partial) carries the misread note and is counted apart, without changing the score", () => {
    const file = KEEP[1];
    const s = scoreRefund(labels, everyHit({ [file]: read("cancelled", partial(0.95, "メールに無い行")) }));
    const row = s.rows.find((r) => r.file === file)!;
    expect(row.ok).toBe(true);
    expect(row.misread).toBe(true);
    expect(row.miss).toContain(MISREAD_NOTE);
    expect(s.hit).toBe(10);
    const lines = refundMisreadLines(s);
    expect(lines).toContain("refund misreads (read as cancelled, but the pipeline cancels nothing): 1");
    expect(lines).toContain(file);
  });

  it("no note and a count of 0 for an ordinary reading, and a miss on the cancel side is not a misread", () => {
    const s = scoreRefund(labels, everyHit());
    expect(s.rows.some((r) => r.misread || r.miss !== "")).toBe(false);
    expect(refundMisreadLines(s)).toBe("refund misreads (read as cancelled, but the pipeline cancels nothing): 0");
    const missed = scoreRefund(labels, everyHit({ [CANCEL[0]]: read("cancelled", partial(0.95, "メールに無い行")) }));
    expect(missed.rows.filter((r) => r.misread)).toEqual([]);
  });

  it("a whole cancellation: cancelled with partial false or unknown is a hit", () => {
    const file = CANCEL[0];
    for (const data of [read("cancelled"), read("cancelled", { value: false, evidence: "根拠の行", confidence: 0.95 })]) {
      expect(scoreRefund(labels, everyHit({ [file]: data })).rows.find((r) => r.file === file)!.ok).toBe(true);
    }
  });

  it("a whole cancellation read as another purchase mail, or as a partial one, is a miss", () => {
    const file = CANCEL[0];
    for (const data of [read("other_purchase"), read("cancelled", partial())]) {
      const s = scoreRefund(labels, everyHit({ [file]: data }));
      expect(s.rows.find((r) => r.file === file)!.ok).toBe(false);
      expect(s.hit).toBe(9);
    }
  });

  it("a whole cancellation whose relevance quotation is not in the mail is a miss: the pipeline moves nothing for it", () => {
    const file = CANCEL[0];
    const unquoted = reading({ relevance: "cancelled", relevance_evidence: "メールに無い行" });
    const s = scoreRefund(labels, everyHit({ [file]: unquoted }));
    const row = s.rows.find((r) => r.file === file)!;
    expect(row.ok).toBe(false);
    expect(row.miss).toContain("根拠が本文に無い・本番では動かない");
    expect(s.hit).toBe(9);
  });

  it("a mail that was not read, or whose reading failed, is a miss on either side", () => {
    const s = scoreRefund(labels, everyHit({ [KEEP[0]]: null, [CANCEL[0]]: null }).filter((r) => r.file !== KEEP[1]));
    expect(s.hit).toBe(7);
    expect(s.rows.find((r) => r.file === KEEP[1])!.miss).toBe("not read");
    expect(s.rows.find((r) => r.file === KEEP[0])!.miss).toContain("reading failed");
  });

  it("shows the misses in a table (example with made-up readings)", () => {
    const table = refundMissTable(scoreRefund(labels, everyHit({ [KEEP[1]]: read("cancelled"), [CANCEL[1]]: read("other_purchase") })));
    expect(table).toContain("refund misses (file | kind | what):");
    expect(table).toContain(`${KEEP[1]} | no_cancel | relevance=cancelled cancel_partial=null`);
    expect(table).toContain(`${CANCEL[1]} | cancel | relevance=other_purchase cancel_partial=null`);
  });
});
