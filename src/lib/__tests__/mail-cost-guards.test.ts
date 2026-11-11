import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processInboundEmail, MailBeingReadError } from "@/lib/pipeline";
import { MAIL_LEASE_MS, PENDING_GRACE_MS, WAITING_MAIL_FILTER } from "@/lib/unread";
import { runReadWaitingMail } from "@/lib/mail-run";
import { withMailRun } from "@/lib/mail-run-db";
import { FakeDb } from "./fake-db";
import { USER, OTHER, asConsentingAdmin, mailOf, precomputed, reading } from "./pipeline-fixtures";

const mocks = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));

const NOW = Date.parse("2026-11-12T00:00:00Z");
const day = "2026-11-12";
const mail = (n: number, userId = USER) => ({ ...mailOf("2026-11-12T00:00:00Z"), userId, providerEmailId: `provider-${n}`, messageId: `<guard-${n}@example.test>`, from: "orders@new-shop.test", subject: "注文のお知らせ", fromName: null, text: "ご注文ありがとうございます。", html: null });
const stopped = () => new FakeDb({ claude_usage_daily: [USER, OTHER].map((user_id) => ({ user_id, day, calls: 1_000_000 })) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("OTODOKE_UNREAD_USER_MAIL_LIMIT", "2");
  vi.stubEnv("OTODOKE_UNREAD_GLOBAL_MAIL_LIMIT", "3");
  vi.stubEnv("OTODOKE_UNREAD_USER_BYTE_LIMIT", "100000");
  vi.stubEnv("OTODOKE_UNREAD_GLOBAL_BYTE_LIMIT", "1000000");
  mocks.extract.mockReset();
  mocks.triage.mockReset().mockResolvedValue(true);
  mocks.extract.mockResolvedValue(precomputed(reading({ relevance: "other_purchase" })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("bounded unread intake", () => {
  it("stops before saving a rejected body and keeps only one notice per user", async () => {
    const db = stopped();
    expect((await processInboundEmail(asConsentingAdmin(db), mail(1))).kind).toBe("over_limit");
    expect((await processInboundEmail(asConsentingAdmin(db), mail(2))).kind).toBe("over_limit");
    for (let n = 3; n < 12; n++) expect(await processInboundEmail(asConsentingAdmin(db), mail(n))).toEqual({ kind: "storage_limit", limit: "user_storage_limit" });
    expect(db.rows("emails")).toHaveLength(2);
    expect(db.rows("mail_intake_notices")).toHaveLength(1);
    expect(Object.keys(db.rows("mail_intake_notices")[0]).sort()).toEqual(["limited_at", "reason", "user_id"]);
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("shares the global ceiling across concurrent users and new rows", async () => {
    vi.stubEnv("OTODOKE_UNREAD_GLOBAL_MAIL_LIMIT", "1");
    const db = stopped();
    const results = await Promise.all([processInboundEmail(asConsentingAdmin(db), mail(1)), processInboundEmail(asConsentingAdmin(db), mail(2, OTHER))]);
    expect(results.filter((r) => r.kind === "over_limit")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "storage_limit")).toHaveLength(1);
    expect(db.rows("emails")).toHaveLength(1);
  });

  it("counts UTF-8 body and header bytes rather than JavaScript characters", async () => {
    const input = mail(1);
    const size = [input.subject, input.from, input.fromName, input.text, input.html].reduce<number>((n, s) => n + Buffer.byteLength(s ?? "", "utf8"), 0);
    vi.stubEnv("OTODOKE_UNREAD_USER_BYTE_LIMIT", String(size - 1));
    const db = stopped();
    expect((await processInboundEmail(asConsentingAdmin(db), input)).kind).toBe("storage_limit");
    expect(db.rows("emails")).toEqual([]);
    vi.stubEnv("OTODOKE_UNREAD_USER_BYTE_LIMIT", String(size));
    expect((await processInboundEmail(asConsentingAdmin(db), input)).kind).toBe("over_limit");
    expect(db.rows("emails")).toHaveLength(1);
  });

  it("reads an existing mail at a lowered ceiling, frees capacity, and accepts the resent original", async () => {
    const db = stopped();
    await processInboundEmail(asConsentingAdmin(db), mail(1));
    await processInboundEmail(asConsentingAdmin(db), mail(2));
    expect((await processInboundEmail(asConsentingAdmin(db), mail(3))).kind).toBe("storage_limit");
    vi.stubEnv("OTODOKE_UNREAD_USER_MAIL_LIMIT", "1");
    await processInboundEmail(asConsentingAdmin(db), mail(1), { precomputed: precomputed(reading({ relevance: "other_purchase" })) });
    await processInboundEmail(asConsentingAdmin(db), mail(2), { precomputed: precomputed(reading({ relevance: "other_purchase" })) });
    expect(db.rows("emails").filter((r) => r.processing_status !== "processed")).toHaveLength(0);
    expect((await processInboundEmail(asConsentingAdmin(db), mail(3))).kind).toBe("over_limit");
    expect(db.rows("emails").filter((r) => r.processing_status !== "processed")).toHaveLength(1);
  });

  it("a new JST day permits reading the backlog; a processed resend never consumes intake or changes parcels", async () => {
    const db = stopped();
    await processInboundEmail(asConsentingAdmin(db), mail(1));
    vi.setSystemTime(NOW + 24 * 3600_000);
    expect((await processInboundEmail(asConsentingAdmin(db), mail(1))).kind).toBe("noted");
    const before = structuredClone(db.tables);
    const calls = db.rpcCalls.length;
    expect((await processInboundEmail(asConsentingAdmin(db), mail(1))).kind).toBe("duplicate");
    expect(db.tables).toEqual(before);
    expect(db.rpcCalls).toHaveLength(calls);
  });

  it("deduplicates provider retries without Message-ID", async () => {
    const db = stopped();
    const input = { ...mail(1), messageId: null };
    await processInboundEmail(asConsentingAdmin(db), input);
    await processInboundEmail(asConsentingAdmin(db), input, { precomputed: precomputed(reading({ relevance: "other_purchase" })) });
    expect(db.rows("emails")).toHaveLength(1);
    expect((await processInboundEmail(asConsentingAdmin(db), input)).kind).toBe("duplicate");
  });

  it("does not store a simultaneous provider retry twice when Message-ID is missing", async () => {
    const db = stopped();
    const input = { ...mail(1), messageId: null };
    const result = await Promise.allSettled([processInboundEmail(asConsentingAdmin(db), input), processInboundEmail(asConsentingAdmin(db), input)]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(db.rows("emails")).toHaveLength(1);
  });

  it("still accepts forwarding confirmation with a full unread backlog", async () => {
    const db = stopped();
    await processInboundEmail(asConsentingAdmin(db), mail(1));
    await processInboundEmail(asConsentingAdmin(db), mail(2));
    const result = await processInboundEmail(asConsentingAdmin(db), { ...mail(3), from: "forwarding-noreply@google.com", text: "https://mail-settings.google.com/mail/vf-example" });
    expect(result.kind).toBe("forwarding_confirmation");
    expect(db.rows("emails").filter((r) => r.processing_status !== "processed")).toHaveLength(2);
  });
});

describe("owned mail execution", () => {
  it("keeps a live first read at 181 seconds and recovers only after expiry", async () => {
    let release!: (value: ReturnType<typeof precomputed>) => void;
    mocks.extract.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const db = new FakeDb();
    const first = processInboundEmail(asConsentingAdmin(db), mail(1));
    await vi.waitFor(() => expect(mocks.extract).toHaveBeenCalledTimes(1));
    const row = db.rows("emails")[0];
    const firstRun = String(row.processing_run_id);
    const started = Date.parse(String(row.created_at));
    expect(Date.parse(String(row.processing_lease_until)) - started).toBe(MAIL_LEASE_MS);
    expect(MAIL_LEASE_MS).toBeGreaterThan(300_000);
    expect(PENDING_GRACE_MS).toBe(180_000); // compatibility cannot shorten a new explicit lease
    vi.setSystemTime(started + 181_000);
    await expect(processInboundEmail(asConsentingAdmin(db), mail(1))).rejects.toBeInstanceOf(MailBeingReadError);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(db.callsOn("extractions", "delete")).toEqual([]);
    vi.setSystemTime(started + MAIL_LEASE_MS + 1);
    expect((await processInboundEmail(asConsentingAdmin(db), mail(1))).kind).toBe("noted");
    expect(db.rows("emails")[0].processing_run_id).not.toBe(firstRun);
    const saved = structuredClone(db.tables);
    release(precomputed(reading({ relevance: "order" })));
    await expect(first).rejects.toThrow("lease");
    expect(db.tables).toEqual(saved);
    expect(db.rows("extractions")).toHaveLength(1);
    expect(db.rows("parcels")).toHaveLength(0);
  });

  it("rejects a stale owner's claim and all mutations, even without a replacement run", async () => {
    const db = stopped();
    await processInboundEmail(asConsentingAdmin(db), mail(1));
    const row = db.rows("emails")[0];
    row.processing_status = "pending";
    const owned = withMailRun(asConsentingAdmin(db), String(row.id), String(row.processing_run_id));
    vi.setSystemTime(NOW + MAIL_LEASE_MS + 1);
    const saved = structuredClone(db.tables);
    const claim = await owned.rpc("claim_claude_call_v2", { p_user_id: USER, p_user_limit: 30, p_global_limit: 300 });
    expect(claim.error?.code).toBe("42501");
    const write = await owned.from("emails").update({ processing_status: "processed" }).eq("id", String(row.id));
    expect(write.error?.code).toBe("42501");
    expect(db.tables).toEqual(saved);
  });

  it("includes a slow lookup in the request budget and keeps unread mail for the next request", async () => {
    const db = stopped();
    await processInboundEmail(asConsentingAdmin(db), mail(1));
    db.hooks.push((q) => {
      if (q.table === "emails" && q.op === "select") vi.setSystemTime(NOW + 160_000);
    });
    expect(await runReadWaitingMail(asConsentingAdmin(db), USER)).toMatchObject({ ok: true, read: 0 });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(db.rows("emails")[0].processing_status).toBe("over_limit");
  });

  it("uses lease expiry for new rows and keeps the drained legacy-row fallback", () => {
    const db = new FakeDb({ emails: [
      { id: "live", processing_status: "pending", created_at: new Date(NOW - 181_000).toISOString(), processing_lease_until: new Date(NOW + 1000).toISOString() },
      { id: "old", processing_status: "pending", created_at: new Date(NOW - 181_000).toISOString() },
    ] });
    return expect(db.from("emails").select("id").or(WAITING_MAIL_FILTER(new Date(NOW)))).resolves.toMatchObject({ data: [{ id: "old" }] });
  });
});
