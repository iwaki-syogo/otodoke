import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundEmail } from "@/lib/pipeline";
import { EXTRACT_TIMEOUT_MS, TRIAGE_TIMEOUT_MS } from "@/lib/unread";
import { FakeDb } from "./fake-db";
import { USER, asAdmin, item, mailOf, reading, sure } from "./pipeline-fixtures";

/** Exercise the installed SDK and the real pipeline. The replacement fetch never uses a network. */
const EXTRACT_MODEL = "test-extraction-model";
const TRIAGE_MODEL = "claude-haiku-5-5";
type Failure = "500" | "timeout" | "connection failure";

const orderMail = (): InboundEmail => ({
  ...mailOf("2026-11-03T01:00:00Z"),
  messageId: "<single-order@example.test>",
  subject: "ご注文ありがとうございます",
  text: "ご注文番号 ORD-1 を承りました",
});

/** The user marked this sender; the free screen sends its ad to the paid second look. */
const adMail = (): InboundEmail => ({
  ...mailOf("2026-11-03T01:00:00Z"),
  messageId: "<single-ad@example.test>",
  from: "news@mall.example.test",
  subject: "今週のおすすめ",
  text: "新着アイテムのご案内。配信停止はこちら",
});

function database(triage = false): FakeDb {
  return new FakeDb(triage ? {
    screen_events: [{
      id: "marked-sender", user_id: USER, decision: "dropped", from_domain: "mall.example.test",
      flagged_at: "2026-11-02T00:00:00Z", created_at: "2026-11-02T00:00:00Z",
    }],
  } : {});
}

const used = (db: FakeDb) => db.rows("claude_usage_daily").reduce((sum, row) => sum + Number(row.calls), 0);
const claimed = (db: FakeDb) => db.rpcCalls.filter((call) => call.name === "claim_claude_call_v2");
const released = (db: FakeDb) => db.rpcCalls.filter((call) => call.name === "release_claude_call");

function stoppedResponse(status = 402): Response {
  return Response.json({ type: "error", error: { type: status === 402 ? "billing_error" : "api_error", message: "synthetic failure" } }, {
    status,
    headers: { "request-id": "synthetic-request" },
  });
}

function successResponse(model: string, output: unknown): Response {
  return Response.json({
    id: "synthetic-message", type: "message", role: "assistant", model,
    content: [{ type: "text", text: JSON.stringify(output) }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

function installFetch(answer: (model: string, init: RequestInit) => Response | Promise<Response>) {
  const models: string[] = [];
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as { model: string };
    models.push(body.model);
    return answer(body.model, init!);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, models };
}

beforeEach(() => {
  // Clear the cached extraction client and lazy environment between cases.
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-key");
  vi.stubEnv("OTODOKE_MODEL", EXTRACT_MODEL);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("paid Claude POSTs are never retried by the SDK", () => {
  for (const triage of [false, true]) {
    const label = triage ? "triage and the subsequent extraction" : "extraction";
    it.each<Failure>(["500", "timeout", "connection failure"])(`${label}: %s sends one POST per claim and keeps uncertain allowances`, async (failure) => {
      const network = installFetch(() => {
        if (failure === "500") return stoppedResponse(500);
        if (failure === "timeout") throw new DOMException("synthetic timeout", "AbortError");
        throw new TypeError("synthetic connection failure");
      });
      const db = database(triage);
      const { processInboundEmail } = await import("@/lib/pipeline");
      await expect(processInboundEmail(asAdmin(db), triage ? adMail() : orderMail())).rejects.toThrow();

      const expectedModels = triage ? [TRIAGE_MODEL, EXTRACT_MODEL] : [EXTRACT_MODEL];
      expect(network.models).toEqual(expectedModels);
      expect(network.fetch).toHaveBeenCalledTimes(expectedModels.length);
      expect(claimed(db)).toHaveLength(expectedModels.length);
      expect(db.rows("claude_call_claims")).toHaveLength(expectedModels.length);
      expect(used(db)).toBe(expectedModels.length);
      expect(released(db)).toHaveLength(0);
      expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", error: "claude_error" });
    });
  }

  it("successful extraction sends one POST, spends one claim and files the reading", async () => {
    const output = reading({ relevance: "order", order_number: sure("ORD-1"), items: [item("テスト商品", 900)], total_amount: sure(900) });
    const network = installFetch((model) => successResponse(model, output));
    const db = database();
    const { processInboundEmail } = await import("@/lib/pipeline");
    expect((await processInboundEmail(asAdmin(db), orderMail())).kind).toBe("processed");
    expect(network.models).toEqual([EXTRACT_MODEL]);
    expect(claimed(db)).toHaveLength(1);
    expect(used(db)).toBe(1);
    expect(released(db)).toHaveLength(0);
  });

  it("successful triage sends one POST, spends one claim and drops an unrelated ad", async () => {
    const network = installFetch((model) => successResponse(model, { about_this_persons_purchase: false }));
    const db = database(true);
    const { processInboundEmail } = await import("@/lib/pipeline");
    expect((await processInboundEmail(asAdmin(db), adMail())).kind).toBe("screened_out");
    expect(network.models).toEqual([TRIAGE_MODEL]);
    expect(claimed(db)).toHaveLength(1);
    expect(used(db)).toBe(1);
    expect(released(db)).toHaveLength(0);
  });

  it.each([false, true])("unavailable response gives back each single claim (triage=%s)", async (triage) => {
    const network = installFetch(() => stoppedResponse());
    const db = database(triage);
    const { processInboundEmail } = await import("@/lib/pipeline");
    await expect(processInboundEmail(asAdmin(db), triage ? adMail() : orderMail())).rejects.toMatchObject({ name: "ClaudeUnavailableError" });
    const expectedModels = triage ? [TRIAGE_MODEL, EXTRACT_MODEL] : [EXTRACT_MODEL];
    expect(network.models).toEqual(expectedModels);
    expect(claimed(db)).toHaveLength(expectedModels.length);
    expect(released(db)).toHaveLength(expectedModels.length);
    expect(used(db)).toBe(0);
  });

  it.each([false, true])("the SDK aborts a pending POST at its deadline without retrying or refunding it (triage=%s)", async (triage) => {
    vi.useFakeTimers();
    const target = triage ? TRIAGE_MODEL : EXTRACT_MODEL;
    const timeout = triage ? TRIAGE_TIMEOUT_MS : EXTRACT_TIMEOUT_MS;
    const output = reading({ relevance: "order", order_number: sure("ORD-1"), items: [item("テスト商品", 900)] });
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    let aborted = false;
    const network = installFetch((model, init) => {
      if (model !== target) return successResponse(model, output);
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("synthetic fetch aborted by the SDK", "AbortError"));
        }, { once: true });
        announceStarted();
      });
    });
    const db = database(triage);
    const { processInboundEmail } = await import("@/lib/pipeline");
    // Attach the rejection handler before advancing the clock so the timeout is never unhandled.
    const run = processInboundEmail(asAdmin(db), triage ? adMail() : orderMail()).catch((error: unknown) => error);
    await Promise.race([started, run.then(() => { throw new Error("pipeline finished before the pending POST"); })]);
    expect(network.models).toEqual([target]);
    expect(claimed(db)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;
    expect(aborted).toBe(true);
    expect(network.models).toEqual(triage ? [TRIAGE_MODEL, EXTRACT_MODEL] : [EXTRACT_MODEL]);
    expect(claimed(db)).toHaveLength(triage ? 2 : 1);
    expect(used(db)).toBe(triage ? 2 : 1);
    expect(released(db)).toHaveLength(0);
    if (triage) expect(result).toMatchObject({ kind: "processed" });
    else {
      const { APIConnectionTimeoutError } = await import("@anthropic-ai/sdk");
      expect(result).toBeInstanceOf(APIConnectionTimeoutError);
    }
  });
});
