import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminClient } from "@/lib/supabase/admin";
import { FakeDb, type Result } from "./fake-db";
import { USER, asAdmin, asConsentingAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

const api = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: api.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: api.triage }));
const { processInboundEmail, MailBeingReadError } = await import("@/lib/pipeline");
const { runReadWaitingMail } = await import("@/lib/mail-run");
const { runReadAfterConsent } = await import("@/lib/ai-consent-run");
const { runClearAllParcels } = await import("@/lib/demo-run");
const AT = "2026-11-01T00:00:00Z";
const CHOICE = "2026-11-12T00:00:00Z";
const order = reading({ relevance: "order", order_number: sure("ORDER-SYNTHETIC"), items: [item("Synthetic item", 1000)] });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Gate an actual RPC before or after its database transaction, retaining its request headers. */
function gateRpc(db: FakeDb, when: (name: string, args: Record<string, unknown>) => boolean, after = false) {
  const stopped = deferred();
  const resume = deferred();
  let once = false;
  const client = new Proxy(db, {
    get(target, key) {
      if (key === "rpc") return (name: string, args: Record<string, unknown>) => {
        const query = target.rpc(name, args) as Promise<Result> & { setHeader: (key: string, value: string) => unknown };
        const builder = {
          setHeader(key: string, value: string) { query.setHeader(key, value); return builder; },
          then: async (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => {
            const delay = !once && when(name, args);
            if (delay) once = true;
            if (delay && !after) { stopped.resolve(); await resume.promise; }
            const result = await query;
            if (delay && after) { stopped.resolve(); await resume.promise; }
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return builder;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { client: client as unknown as AdminClient, stopped: stopped.promise, resume: resume.resolve };
}

function mail(n: number, withMessageId = true) {
  return { ...mailOf(`2026-11-01T00:00:0${n}Z`), providerEmailId: `synthetic-provider-${n}`, messageId: withMessageId ? `<synthetic-${n}@example.test>` : null,
    subject: "ご注文ありがとうございます", text: "ご注文を承りました。\n根拠の行\nSynthetic item", html: null };
}
function waiting(withMessageId: boolean) {
  return new FakeDb({ emails: [1, 2, 3].map((n) => {
    const m = mail(n, withMessageId);
    return { id: `waiting-${n}`, user_id: USER, provider_email_id: m.providerEmailId, message_id: m.messageId,
      from_address: m.from, subject: m.subject, text_body: m.text, html_body: null, sent_at: m.sentAt,
      processing_status: "failed", error: "ai_consent_required", created_at: AT };
  }) });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
  api.extract.mockReset().mockResolvedValue(precomputed(order));
  api.triage.mockReset().mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("A2: clearing invalidates cached real-mail work", () => {
  for (const automatic of [false, true]) for (const withMessageId of [false, true]) {
    it(`${automatic ? "automatic" : "manual"}, Message-ID ${withMessageId}: does not recreate or pay for the remaining cached mails after clear`, async () => {
      const db = waiting(withMessageId);
      asConsentingAdmin(db);
      const gate = gateRpc(db, (name, args) => name === "mail_run_write" && args.p_table === "emails"
        && args.p_operation === "update" && (args.p_values as { processing_status?: string }).processing_status === "processed", true);
      const reading = runReadWaitingMail(gate.client, USER, automatic ? { consentDecidedAt: CHOICE } : {});
      await gate.stopped;
      expect(api.extract).toHaveBeenCalledTimes(1);
      expect(await runClearAllParcels(asAdmin(db), USER)).toBeNull();
      expect(db.rows("emails")).toEqual([]);
      expect(db.rows("parcels")).toEqual([]);
      gate.resume();
      const outcome = await reading;
      expect(db.rows("emails")).toEqual([]);
      expect(db.rows("parcels")).toEqual([]);
      expect(api.extract).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ ok: false, read: 1 });
    });
  }

  it("fences a fresh inbound request whose reservation was delayed until after clear", async () => {
    const db = new FakeDb();
    asConsentingAdmin(db);
    const gate = gateRpc(db, (name) => name === "store_mail_run");
    const processing = processInboundEmail(gate.client, mail(1));
    const finished = processing.catch((error: unknown) => error);
    await gate.stopped;
    expect(await runClearAllParcels(asAdmin(db), USER)).toBeNull();
    gate.resume();
    expect(await finished).toBeInstanceOf(Error);
    expect(db.rows("emails")).toEqual([]);
    expect(db.rows("parcels")).toEqual([]);
    expect(api.extract).not.toHaveBeenCalled();
  });

  it("does not redirect an explicit reread onto a new row with the same Message-ID", async () => {
    const db = new FakeDb({ emails: [{ id: "new-arrival", user_id: USER, message_id: mail(1).messageId, processing_status: "failed", created_at: AT, text_body: "New arrival" }] });
    const before = structuredClone(db.rows("emails"));
    await expect(processInboundEmail(asConsentingAdmin(db), mail(1), { replacesEmailId: "deleted-row", replacesCreatedAt: AT })).rejects.toBeInstanceOf(MailBeingReadError);
    expect(db.rows("emails")).toEqual(before);
    expect(api.extract).not.toHaveBeenCalled();
  });

  it("pins the listed created_at instead of adopting a later lookup version", async () => {
    const db = waiting(true);
    db.find("emails", "waiting-1")!.created_at = "2026-11-02T00:00:00Z";
    await expect(processInboundEmail(asConsentingAdmin(db), mail(1), { replacesEmailId: "waiting-1", replacesCreatedAt: AT })).rejects.toBeInstanceOf(MailBeingReadError);
    expect(api.extract).not.toHaveBeenCalled();
    expect(db.rpcCalls.find((call) => call.name === "store_mail_run")?.args).toMatchObject({ p_email_id: "waiting-1", p_expected_created_at: AT });
  });

  it("accepts a new arrival and a new waiting-mail request begun after clear", async () => {
    const db = new FakeDb();
    asConsentingAdmin(db);
    expect(await runClearAllParcels(asAdmin(db), USER)).toBeNull();
    expect((await processInboundEmail(asAdmin(db), mail(1))).kind).toBe("processed");
    db.rows("emails").push({ id: "fresh-waiting", user_id: USER, provider_email_id: mail(2).providerEmailId, message_id: mail(2).messageId,
      from_address: mail(2).from, subject: mail(2).subject, text_body: mail(2).text, body_state: "plain", processing_status: "failed", created_at: AT });
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 1 });
    expect(api.extract).toHaveBeenCalledTimes(2);
    expect(db.rows("emails")).toHaveLength(2);
  });
  it("keeps one generation across automatic batches and permits a newly started request after clear", async () => {
    const db = waiting(true);
    db.tables.emails = Array.from({ length: 21 }, (_, n) => ({ ...db.rows("emails")[0], id: `batch-${n + 1}`, message_id: `<batch-${n + 1}@example.test>`,
      provider_email_id: `batch-provider-${n + 1}`, sent_at: new Date(Date.parse(AT) + n * 1000).toISOString() }));
    asConsentingAdmin(db);
    const gate = gateRpc(db, (name, args) => name === "mail_run_write" && args.p_email_id === "batch-20" && args.p_table === "emails"
      && (args.p_values as { processing_status?: string }).processing_status === "processed", true);
    const processing = runReadAfterConsent(gate.client, USER, CHOICE);
    await gate.stopped;
    expect(api.extract).toHaveBeenCalledTimes(20);
    await runClearAllParcels(asAdmin(db), USER);
    gate.resume();
    expect(await processing).toMatchObject({ ok: true, read: 20 });
    const lists = db.callsOn("emails", "select").filter((query) => query.columns?.startsWith("id, created_at, provider_email_id"));
    expect(lists).toHaveLength(2);
    expect(lists[1].requestHeaders).toEqual(lists[0].requestHeaders);
    expect(db.rpcCalls.filter((call) => call.name === "begin_sample_load")).toHaveLength(1);
    expect(db.rows("emails")).toEqual([]); expect(db.rows("parcels")).toEqual([]);
    const fresh = waiting(true).rows("emails")[0]; db.rows("emails").push({ ...fresh, id: "after-batches" });
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 1 });
    expect(api.extract).toHaveBeenCalledTimes(21);
  });
});
