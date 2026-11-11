import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as actualTiming from "@/lib/unread";
import { runReadAfterConsent } from "@/lib/ai-consent-run";
import { FakeDb } from "./fake-db";
import { USER, asAdmin } from "./pipeline-fixtures";

const read = (name: string) => readFileSync(path.resolve(__dirname, "..", name), "utf8");
const timingKeys = ["TRIAGE_TIMEOUT_MS", "EXTRACT_TIMEOUT_MS", "MAIL_READ_BUDGET_MS", "MAIL_REQUEST_BUDGET_MS"] as const;
const timing = actualTiming as unknown as Record<(typeof timingKeys)[number], unknown>;

/** A runtime timing export alone does not prove the real SDK is bounded. Inspect both clients too. */
function hasBoundedClient(source: string, timeoutName: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const constructors = [...code.matchAll(/new Anthropic\(\{([^}]+)\}\)/g)];
  const imported = new RegExp(`import\\s*\\{[^}]*\\b${timeoutName}\\b[^}]*\\}\\s*from\\s*["']@/lib/unread["']`).test(code);
  return imported && constructors.length > 0 && constructors.every((m) =>
    new RegExp(`\\btimeout\\s*:\\s*${timeoutName}\\b`).test(m[1]) && /\bmaxRetries\s*:\s*0\b/.test(m[1]),
  );
}

describe("automatic reading depends on bounded real Claude clients", () => {
  it("when the shared bounded-client exports are present, both real SDK clients use those timeouts with retries disabled", () => {
    const exportsPresent = timingKeys.every((key) => typeof timing[key] === "number");
    if (exportsPresent) {
      expect(hasBoundedClient(read("extract/extract.ts"), "EXTRACT_TIMEOUT_MS")).toBe(true);
      expect(hasBoundedClient(read("extract/triage.ts"), "TRIAGE_TIMEOUT_MS")).toBe(true);
    } else {
      // The standalone consent branch is supported, but cannot assume the older SDK's default is safe.
      expect(timingKeys.some((key) => timing[key] === undefined)).toBe(true);
    }
  });

  it("the actual older configuration cannot claim or start auto work before the bounded-client change is integrated", async () => {
    const ready = timingKeys.every((key) => typeof timing[key] === "number" && Number.isFinite(timing[key]) && Number(timing[key]) > 0)
      && Number(timing.MAIL_REQUEST_BUDGET_MS) < 300_000
      && Number(timing.MAIL_REQUEST_BUDGET_MS) >= Number(timing.MAIL_READ_BUDGET_MS)
      && Number(timing.MAIL_READ_BUDGET_MS) > Number(timing.TRIAGE_TIMEOUT_MS) + Number(timing.EXTRACT_TIMEOUT_MS);
    const db = new FakeDb();
    const result = await runReadAfterConsent(asAdmin(db), USER, "2026-11-12T00:00:00.123456Z");
    if (ready) {
      // No consent exists: the real claim is a no-op and there is no mail to send.
      expect(result).toEqual({ ok: true, read: 0, overLimit: false, unavailable: false });
      expect(db.rpcCalls).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ ok: false, read: 0, message: "ai_consent_backlog_timing_unavailable", overLimit: false });
      expect(db.rpcCalls).toEqual([]);
      expect(db.calls).toEqual([]);
    }
  });

  it("negative controls reject absent SDK timeouts, retries, comment-only clients and a missing shared import", () => {
    const bounded = 'import { EXTRACT_TIMEOUT_MS } from "@/lib/unread"; const client = new Anthropic({ timeout: EXTRACT_TIMEOUT_MS, maxRetries: 0 });';
    expect(hasBoundedClient(bounded, "EXTRACT_TIMEOUT_MS")).toBe(true);
    expect(hasBoundedClient(bounded.replace("timeout: EXTRACT_TIMEOUT_MS,", ""), "EXTRACT_TIMEOUT_MS")).toBe(false);
    expect(hasBoundedClient(bounded.replace("maxRetries: 0", "maxRetries: 2"), "EXTRACT_TIMEOUT_MS")).toBe(false);
    expect(hasBoundedClient(`/* ${bounded} */`, "EXTRACT_TIMEOUT_MS")).toBe(false);
    expect(hasBoundedClient(bounded.replace('import { EXTRACT_TIMEOUT_MS } from "@/lib/unread";', ""), "EXTRACT_TIMEOUT_MS")).toBe(false);
  });
});
