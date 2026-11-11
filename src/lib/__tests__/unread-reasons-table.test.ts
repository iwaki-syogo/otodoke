import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readUnreadReasons } from "@/app/app/settings/settings-reads";
import { FakeDb, type Row } from "./fake-db";

/**
 * The rule that counts why unread mail waits exists twice: readUnreadReasons here and UnreadReasonsRule in the iOS app.
 * Both run the same table of cases (ios/OtodokeTests/Fixtures/unread-reasons.json); UnreadReasonsTests.swift is the other
 * half. A case that changes its answer needs both rules changed. Made-up rows only.
 */
const FIXTURE = path.resolve(__dirname, "../../../ios/OtodokeTests/Fixtures/unread-reasons.json");
type Case = { name: string; emails: Row[]; expected: { stopped: number; overLimit: number; failed: number } };
const cases: Case[] = JSON.parse(readFileSync(FIXTURE, "utf8")).cases;
const USER = "00000000-0000-4000-8000-00000000000a";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("unread reasons: the table both the Web and iOS run", () => {
  it("is not empty, and covers a stop, a sample, a confirmation, a refusal and a sub-millisecond difference", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    const names = cases.map((c) => c.name).join("\n");
    for (const word of ["stopped", "sample", "confirmation", "refused", "millisecond"]) expect(names, word).toContain(word);
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
});
