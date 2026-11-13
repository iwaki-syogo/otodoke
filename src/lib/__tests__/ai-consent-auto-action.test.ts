import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsErrorMessage } from "@/lib/settings-errors";
import type { ReadWaitingResult } from "@/lib/mail-run";
import { FakeDb, consentWaitingRetentionMs } from "./fake-db";

const USER = "00000000-0000-4000-8000-00000000000a";
// Preserve the database's microseconds: rounding this could turn the claim into another attempt.
const AT = "2026-11-12T01:00:00.123456Z";
const mocks = vi.hoisted(() => ({ db: null as unknown, user: { id: "00000000-0000-4000-8000-00000000000a" } as { id: string } | null, getUser: vi.fn(), readAfter: vi.fn(), process: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.db, getUser: mocks.getUser }));
vi.mock("@/lib/auth-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-session")>()),
  // The user this file's mocked getUser gives, read as a verified cookie session.
  readCookieSession: async () => {
    const user = await (await import("@/lib/supabase/server")).getUser();
    return user ? { state: "signed_in", session: { userId: user.id, email: (user as { email?: string }).email ?? null, amr: [] } } : { state: "signed_out" };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/ai-consent-run", () => ({ runReadAfterConsent: mocks.readAfter }));
vi.mock("@/lib/pipeline", () => ({ processInboundEmail: mocks.process, MailBeingReadError: class MailBeingReadError extends Error {} }));
// The elapsed-setup integration test uses the real runner with the bounded-client contract.
vi.mock("@/lib/unread", async (importActual) => ({
  ...await importActual<typeof import("@/lib/unread")>(),
  TRIAGE_TIMEOUT_MS: 15_000, EXTRACT_TIMEOUT_MS: 90_000, MAIL_READ_BUDGET_MS: 120_000, MAIL_REQUEST_BUDGET_MS: 270_000,
}));
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));

let db: FakeDb;
const events: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  mocks.user = { id: USER };
  mocks.getUser.mockReset().mockImplementation(async () => mocks.user);
  mocks.process.mockReset();
  db = new FakeDb();
  mocks.db = db;
  const realRpc = db.rpc.bind(db);
  vi.spyOn(db, "rpc").mockImplementation(async (name, args) => {
    if (name !== "set_ai_reading") return realRpc(name, args);
    const decision = (args as { p_decision?: unknown } | undefined)?.p_decision;
    events.push(`saved:${decision}`);
    db.rows("ai_reading_consents").push({ user_id: USER, decision, decided_at: AT, text_version: "v1" });
    return { data: [{ decision, decided_at: AT }], error: null };
  });
  mocks.readAfter.mockImplementation(async () => {
    events.push("read");
    return { ok: true, read: 1, overLimit: false, unavailable: false };
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected external request"); }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const form = (decision: string, after = "list") => {
  const data = new FormData();
  data.set("expectedUserId", USER);
  data.set("decision", decision);
  data.set("after", after);
  return data;
};

async function act(decision = "granted", after = "list") {
  const { setAiReadingDecision } = await import("@/app/app/reading/actions");
  return setAiReadingDecision(form(decision, after));
}

describe("a saved reading permission starts the waiting real mail", () => {
  it.each([150_000, 150_001])("counts authentication and consent saving in the request budget (%d ms)", async (setupMs) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-11-12T01:00:01Z");
    vi.setSystemTime(start);
    mocks.getUser.mockImplementationOnce(async () => { vi.setSystemTime(start + 100_000); return mocks.user; });
    const save = vi.mocked(db.rpc).getMockImplementation()!;
    vi.mocked(db.rpc).mockImplementation(async (name, args) => {
      const answer = await save(name, args);
      if (name === "set_ai_reading") vi.setSystemTime(start + setupMs);
      return answer;
    });
    const { runReadAfterConsent } = await vi.importActual<typeof import("@/lib/ai-consent-run")>("@/lib/ai-consent-run");
    mocks.readAfter.mockImplementationOnce((admin, userId, decidedAt, requestStartedAt) => runReadAfterConsent(admin, userId, decidedAt, requestStartedAt));
    await expect(act()).rejects.toThrow(setupMs > 150_000 ? "REDIRECT:/app/settings/trouble?error=read_failed" : "REDIRECT:/app");
    expect(mocks.readAfter).toHaveBeenCalledExactlyOnceWith(db, USER, AT, start);
    expect(db.rows("ai_reading_consents")[0]).toMatchObject({ decision: "granted", decided_at: AT });
    const claims = db.rpcCalls.filter((call) => call.name === "claim_ai_reading_backlog");
    expect(claims).toHaveLength(setupMs > 150_000 ? 0 : 1);
    expect(db.rows("emails")).toHaveLength(0);
  });

  it.each([["list", "/app"], ["welcome", "/app/welcome"], ["settings", "/app/settings/mail-handling"]])("saves before reading once, then keeps the %s destination", async (after, destination) => {
    await expect(act("granted", after)).rejects.toThrow(`REDIRECT:${destination}`);
    expect(db.rpc).toHaveBeenCalledWith("set_ai_reading", { p_decision: "granted", p_text_version: "v1" });
    expect(events).toEqual(["saved:granted", "read"]);
    expect(mocks.readAfter).toHaveBeenCalledExactlyOnceWith(db, USER, AT, expect.any(Number));
    expect(mocks.revalidate).toHaveBeenCalledWith("/app", "layout");
  });

  it("a decline saves without reading or removing any earlier result", async () => {
    db.rows("parcels").push({ id: "parcel-kept", user_id: USER, title: "見本の荷物" });
    db.rows("extractions").push({ id: "result-kept", user_id: USER, parcel_id: "parcel-kept" });
    await expect(act("declined", "settings")).rejects.toThrow("REDIRECT:/app/settings/mail-handling");
    expect(events).toEqual(["saved:declined"]);
    expect(mocks.readAfter).not.toHaveBeenCalled();
    expect(db.rows("parcels").map((row) => row.id)).toEqual(["parcel-kept"]);
    expect(db.rows("extractions").map((row) => row.id)).toEqual(["result-kept"]);
    expect(db.calls.filter((q) => q.op === "delete")).toEqual([]);
  });

  it.each([
    { data: null, error: { message: "unavailable" } },
    { data: [], error: null },
    { data: [{ decision: "declined", decided_at: AT }], error: null },
    { data: [{ decision: "granted", decided_at: "not a timestamp" }], error: null },
  ])("does not start reading after an unconfirmed save: %j", async (answer) => {
    vi.mocked(db.rpc).mockResolvedValue(answer);
    await expect(act()).rejects.toThrow("REDIRECT:/app/reading?error=save");
    expect(mocks.readAfter).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("invalid or unsigned requests never start reading", async () => {
    await expect(act("other")).rejects.toThrow("REDIRECT:/app/reading?error=save");
    mocks.user = null;
    await expect(act()).rejects.toThrow("REDIRECT:/login");
    expect(mocks.readAfter).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("a thrown save stays a save failure and never starts the backlog", async () => {
    vi.mocked(db.rpc).mockRejectedValue(new Error("unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(act()).rejects.toThrow("REDIRECT:/app/reading?error=save");
    expect(mocks.readAfter).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    log.mockRestore();
  });

  const failure = (over: Partial<ReadWaitingResult> = {}): ReadWaitingResult => ({ ok: false, stage: "read", message: "fixed failure", read: 0, overLimit: false, unavailable: false, onlyBusy: false, ...over } as ReadWaitingResult);
  it.each([
    [failure(), "read_failed"],
    [failure({ stage: "lookup" }), "read_failed"],
    [{ ok: true, read: 0, overLimit: true, unavailable: false }, "read_over_limit"],
    [{ ok: true, read: 0, overLimit: false, unavailable: true }, "read_unavailable"],
  ] as const)("preserves a successful grant when the read returns %j", async (answer, code) => {
    mocks.readAfter.mockResolvedValue(answer);
    await expect(act()).rejects.toThrow(`REDIRECT:/app/settings/trouble?error=${code}`);
    expect(db.rows("ai_reading_consents")).toEqual([{ user_id: USER, decision: "granted", decided_at: AT, text_version: "v1" }]);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledWith("/app", "layout");
    expect(settingsErrorMessage(code)).toBeTruthy();
    expect(settingsErrorMessage(code)).not.toContain("許可を保存できません");
  });

  it("a thrown read is a read failure, keeping the saved grant and existing retry route", async () => {
    mocks.readAfter.mockRejectedValue(new Error("unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(act()).rejects.toThrow("REDIRECT:/app/settings/trouble?error=read_failed");
    expect(db.rows("ai_reading_consents")[0]).toMatchObject({ decision: "granted", decided_at: AT });
    expect(mocks.revalidate).toHaveBeenCalledWith("/app", "layout");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("another reader holding the mail is not shown as a failed choice or failed read", async () => {
    mocks.readAfter.mockResolvedValue(failure({ onlyBusy: true }));
    await expect(act()).rejects.toThrow("REDIRECT:/app");
    expect(db.rows("ai_reading_consents")[0]).toMatchObject({ decision: "granted" });
  });
});

describe("the Web entry reaches the real automatic and manual readers", () => {
  // These are caller tests. The pipeline's retained outcomes are synthetic; the separate real
  // pipeline regression proves paid-call behaviour, while this suite proves request routing.
  const seedWaiting = (count: number, error = "relevance_unverified") => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(AT) + 1000);
    const arrived = "2026-11-01T00:00:00Z";
    const ids = Array.from({ length: count }, (_, index) => `web-waiting-${index + 1}`);
    db.rows("emails").push(...ids.map((id, index) => ({
      id, user_id: USER, processing_status: "failed", error, body_state: "plain",
      provider_email_id: `provider-${id}`, message_id: `<${id}@example.test>`,
      from_address: "shop@example.test", from_name: null, subject: "Synthetic waiting mail",
      text_body: "Synthetic retained body", html_body: null,
      sent_at: new Date(Date.parse(arrived) + index * 1000).toISOString(), created_at: arrived, received_at: arrived,
      consent_waiting_until: new Date(Date.parse(arrived) + consentWaitingRetentionMs()).toISOString(),
    })));
    return ids;
  };
  const realAutomaticReader = async () => {
    const { runReadAfterConsent } = await vi.importActual<typeof import("@/lib/ai-consent-run")>("@/lib/ai-consent-run");
    mocks.readAfter.mockImplementation((...args: Parameters<typeof runReadAfterConsent>) => runReadAfterConsent(...args));
  };
  const calledIds = () => mocks.process.mock.calls.map((call) => (call[2] as { replacesEmailId: string }).replacesEmailId);

  it.each(["noted", "discarded"] as const)("a saved grant processes 21 retained %s mails once and keeps the normal destination", async (kind) => {
    const ids = seedWaiting(21, kind === "noted" ? "relevance_unverified" : "model_refused");
    await realAutomaticReader();
    mocks.process.mockImplementation(async (_admin, _mail, options: { replacesEmailId: string }) =>
      // Bound the old repeating loop so a regression fails assertions rather than timing out.
      mocks.process.mock.calls.length > ids.length
        ? { kind: "over_limit", emailId: options.replacesEmailId, limit: "user" }
        : { kind, emailId: options.replacesEmailId });

    await expect(act("granted", "welcome")).rejects.toThrow("REDIRECT:/app/welcome");
    expect(calledIds()).toEqual(ids);
    expect(new Set(calledIds()).size).toBe(ids.length);
    expect(db.rows("emails").map((row) => row.id)).toEqual(ids);
    expect(db.rows("ai_reading_consents")).toEqual([{ user_id: USER, decision: "granted", decided_at: AT, text_version: "v1" }]);
    expect(db.rpcCalls.filter((call) => call.name === "claim_ai_reading_backlog")).toEqual([{ name: "claim_ai_reading_backlog", args: { p_user_id: USER, p_decided_at: AT } }]);
    expect(mocks.revalidate).toHaveBeenCalledWith("/app", "layout");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("new manual requests retry the retained IDs, each taking only one 20-mail snapshot", async () => {
    const ids = seedWaiting(21);
    db.rows("ai_reading_consents").push({ user_id: USER, decision: "granted", decided_at: AT, text_version: "v1" });
    const { readWaitingMail } = await import("@/app/app/settings/actions");
    mocks.process.mockImplementation(async (_admin, _mail, options: { replacesEmailId: string }) => ({ kind: "noted", emailId: options.replacesEmailId }));
    for (let request = 0; request < 2; request++) {
      mocks.process.mockClear();
      await expect(readWaitingMail(form("granted"))).rejects.toThrow("REDIRECT:/app/settings/trouble");
      expect(calledIds()).toEqual(ids.slice(0, 20));
    }
    expect(db.rows("emails").map((row) => row.id)).toEqual(ids);
    expect(db.rpcCalls.filter((call) => call.name === "claim_ai_reading_backlog")).toEqual([]);
    expect(mocks.readAfter).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["automatic", "manual"] as const)("%s rejects a changed displayed account before database work", async (kind) => {
    mocks.user = { id: "00000000-0000-4000-8000-00000000000b" };
    const { readWaitingMail } = await import("@/app/app/settings/actions");
    const destination = kind === "automatic" ? "/app/reading" : "/app/settings/trouble";
    await expect(kind === "automatic" ? act() : readWaitingMail(form("granted"))).rejects.toThrow(`REDIRECT:/account-changed?next=${encodeURIComponent(destination)}`);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
    expect(mocks.readAfter).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });
});

describe("the action's runtime and retained-result words", () => {
  const root = path.resolve(__dirname, "../../..");
  it.each(["src/app/app/page.tsx", "src/app/app/reading/page.tsx", "src/app/app/settings/mail-handling/page.tsx"])("%s gives the permission action 300 seconds", (file) => {
    const source = readFileSync(path.join(root, file), "utf8");
    expect(source).toMatch(/export const maxDuration = 300;/);
  });

  it("the consent action itself exports only the async action and does not load sample fixtures", () => {
    const source = readFileSync(path.join(root, "src/app/app/reading/actions.ts"), "utf8");
    expect(source.match(/^export .+$/gm)).toEqual([expect.stringMatching(/^export async function setAiReadingDecision/)]);
    expect(source).not.toContain("@/lib/demo");
    expect(source).not.toContain("@/lib/mail-run");
  });

  it("settings and the policy say earlier results remain and point to the existing deletion", async () => {
    const React = await import("react");
    const { MailHandling } = await import("@/app/app/settings/mail-handling");
    const PrivacyPage = (await import("@/app/privacy/page")).default;
    for (const node of [React.createElement(MailHandling), React.createElement(PrivacyPage)]) {
      const html = renderToStaticMarkup(node);
      expect(html).toContain("すでに読み取った荷物と結果は残ります。");
      expect(html).toContain("設定の「サンプルで試す」にある「すべての荷物を消す」で消せます。");
    }
  });
});
