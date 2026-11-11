import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_SAMPLE_NOR_CONFIRMATION, readUnreadReasons } from "@/app/app/settings/settings-reads";
import { UNREAD_FILTER } from "@/lib/unread";
import { FakeDb, type Row } from "./fake-db";

/**
 * The rule that counts why unread mail waits exists twice: readUnreadReasons here and UnreadReasonsRule in the iOS app.
 * Both run the same table of cases (ios/OtodokeTests/Fixtures/unread-reasons.json); UnreadReasonsTests.swift is the other
 * half. A case that changes its answer needs both rules changed. Made-up rows only.
 */
const FIXTURE = path.resolve(__dirname, "../../../ios/OtodokeTests/Fixtures/unread-reasons.json");
type Case = { name: string; emails: Row[]; expected: { stopped: number; overLimit: number; failed: number } };
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { now: string; cases: Case[] };
const cases: Case[] = fixture.cases;
const USER = "00000000-0000-4000-8000-00000000000a";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The 3-minute rule for a pending mail (UNREAD_FILTER) reads the clock: both sides use the fixture's `now`.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(fixture.now));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("unread reasons: the table both the Web and iOS run", () => {
  it("is not empty, and covers a stop, a sample, a confirmation, a refusal and a sub-millisecond difference", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    const names = cases.map((c) => c.name).join("\n");
    for (const word of ["stopped", "sample", "confirmation", "refused", "millisecond", "pending"]) expect(names, word).toContain(word);
  });

  for (const c of cases) {
    it(c.name, async () => {
      const db = new FakeDb({ emails: c.emails.map((e) => ({ ...e, user_id: USER })) });
      expect(await readUnreadReasons(db as never, "table")).toEqual(c.expected);
    });
  }

  it("negative control: a changed answer is caught (the stop that a later real mail cancels)", async () => {
    const c = cases.find((x) => x.name.startsWith("a mail read after the stop"))!;
    const db = new FakeDb({ emails: c.emails.map((e) => ({ ...e, user_id: USER })) });
    expect(await readUnreadReasons(db as never, "table")).not.toEqual({ stopped: 1, overLimit: 0, failed: 0 });
  });

  it("the or() the iOS app sends for 'not a sample, not a confirmation' is the Web's, character for character", () => {
    const swift = readFileSync(path.resolve(__dirname, "../../../ios/Otodoke/Data/SettingsReader.swift"), "utf8");
    const ios = swift.match(/static let notSampleNorConfirmation = "([^"\\]*)"/)?.[1];
    expect(ios).toBeTruthy();
    expect(ios).toBe(NOT_SAMPLE_NOR_CONFIRMATION);
    // Negative control: one character changed on either side is caught.
    expect(ios!.replace("demo:%", "demo:_")).not.toBe(NOT_SAMPLE_NOR_CONFIRMATION);
    expect(ios!.replace("classification.neq", "classification.eq")).not.toBe(NOT_SAMPLE_NOR_CONFIRMATION);
  });

  it("the Web's 3-minute filter is the shape the iOS fake and StatusRules speak (over_limit, failed, pending since before)", () => {
    expect(UNREAD_FILTER(new Date(fixture.now))).toBe("processing_status.in.(over_limit,failed),and(processing_status.eq.pending,created_at.lt.2026-11-04T02:57:00.000Z)");
  });
});
