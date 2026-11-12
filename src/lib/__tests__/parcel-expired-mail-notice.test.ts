import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closedBody, currentSealKey } from "@/lib/mail-seal";
import { FakeDb, type Query, type Result, type Row } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

const USER = "00000000-0000-4000-8000-00000000000a";
const PARCEL = "11111111-1111-4111-8111-111111111111";
const EMAIL = "22222222-2222-4222-8222-222222222222";
const NOTES = "期限前に保存された読み取りメモ";
const EXPIRY_NOTICE = "保管の期限を過ぎたため、元のメールは残っていません。";
const NEUTRAL_NOTICE = "本文は保存していません";
const OLD_KEY_EXPLANATION = "メールの鍵ができる前に読み取ったメールです。";

// Read the actual writer's reason instead of inventing a third copy of the DB/UI contract.
const expirySql = readFileSync(new URL("../../../supabase/migrations/20261113120000_consent_waiting_storage.sql", import.meta.url), "utf8");
const expiryReason = expirySql.match(/body_state='dropped',processing_status='discarded',error='([^']+)'/)?.[1];
if (!expiryReason) throw new Error("the expiry writer must expose its persisted reason");

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app", useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.db, getUser: async () => ({ id: USER, email: "qa@example.test" }) }));

/**
 * FakeDb deliberately returns full rows. Only this page test projects its embedded SELECT,
 * so omitting error cannot accidentally pass because the fake over-fetched the seed's reason.
 */
class ProjectedHistoryDb extends FakeDb {
  embedArray = false;
  omitReason = false;

  override execute(query: Query): Result {
    const result = super.execute(query);
    if (query.op !== "select" || query.table !== "extractions" || !Array.isArray(result.data)) return result;
    const columns = query.columns?.match(/\bemails\(([^)]+)\)/)?.[1].split(",").map((value) => value.trim()) ?? [];
    const data = (result.data as Row[]).map((row) => {
      const embedded = row.emails as Row | null;
      if (!embedded) return row;
      const email = Object.fromEntries(columns.filter((column) => !(this.omitReason && column === "error"))
        .filter((column) => Object.hasOwn(embedded, column)).map((column) => [column, embedded[column]]));
      return { ...row, emails: this.embedArray ? [email] : email };
    });
    return { ...result, data };
  }
}

let db: ProjectedHistoryDb;
beforeEach(() => {
  db = new ProjectedHistoryDb({
    parcels: [{ id: PARCEL, user_id: USER, shop: "合成の店", title: "期限前に保存された荷物", status: "shipped", source: "mail" }],
    parcel_items: [{ id: "item", user_id: USER, parcel_id: PARCEL, name: "残っている商品", quantity: 1, unit_price: 100 }],
  });
  mocks.db = db;
});

function seedMail(overrides: Row = {}) {
  db.rows("emails").push({
    id: EMAIL, user_id: USER, body_state: "dropped", body_envelope: null, error: expiryReason,
    processing_status: "discarded", subject: null, from_name: null, from_address: null,
    text_body: null, html_body: null, from_domain: "shop.example.test", sent_at: "2026-11-01T00:00:00Z",
    classification: "shipping", ...overrides,
  });
  db.rows("extractions").push({ id: "reading", user_id: USER, email_id: EMAIL, parcel_id: PARCEL, confidence: 0.83, result: { notes: NOTES }, created_at: "2026-11-01T00:00:00Z" });
}

async function renderHistory() {
  const Page = (await import("@/app/app/parcels/[id]/page")).default;
  const root = parseHtml(renderToStaticMarkup(await Page({ params: Promise.resolve({ id: PARCEL }) })));
  const items = findAll(root, (node) => node.tag === "li" && textOf(node).includes("元メールを見る"));
  expect(items).toHaveLength(1);
  return { root, item: items[0], detail: findAll(items[0], (node) => node.tag === "details")[0] };
}

describe("N4: a retained reading reports why its original mail was removed", () => {
  it.each([false, true])("shows the persisted expiry reason with an embedded array=%s, preserving the parcel and saved reading", async (array) => {
    seedMail();
    db.embedArray = array;
    const saved = structuredClone(db.tables);
    const { root, item, detail } = await renderHistory();
    expect(textOf(detail)).toContain(EXPIRY_NOTICE);
    expect(textOf(item)).not.toContain(OLD_KEY_EXPLANATION);
    expect(textOf(item)).not.toContain("パスワードでログインする前");
    expect(textOf(root)).toContain("期限前に保存された荷物");
    expect(textOf(root)).toContain("残っている商品");
    expect(textOf(item)).toContain(`読み取りメモ: ${NOTES}`);
    expect(textOf(item)).toContain("確信度 83%");
    expect(textOf(item)).toContain("shop.example.test");
    expect(findAll(item, (node) => node.tag === "pre")).toHaveLength(0);
    expect(db.tables).toEqual(saved);
    const selected = db.callsOn("extractions", "select")[0].columns?.match(/\bemails\(([^)]+)\)/)?.[1].split(",").map((value) => value.trim());
    expect(selected).toEqual(expect.arrayContaining(["body_state", "error"]));
  });

  it("a missing projected reason is neutral even when the unselected seed has an expiry reason", async () => {
    seedMail();
    const probe = await db.from("extractions").select("id, emails(id, body_state)");
    expect((probe.data as Row[])[0].emails).not.toHaveProperty("error");
    expect(db.rows("emails")[0].error).toBe(expiryReason);
    db.omitReason = true;
    const { detail } = await renderHistory();
    expect(textOf(detail)).toContain(NEUTRAL_NOTICE);
    expect(textOf(detail)).not.toContain(EXPIRY_NOTICE);
    expect(textOf(detail)).not.toContain(OLD_KEY_EXPLANATION);
  });

  it.each([null, undefined, "", "future_drop_reason", "ai_consent_required"])("does not infer a past login from an absent or unknown reason: %s", async (reason) => {
    seedMail({ error: reason, processing_status: "processed" });
    const { detail, item } = await renderHistory();
    expect(textOf(detail)).toContain(NEUTRAL_NOTICE);
    expect(textOf(detail)).not.toContain(EXPIRY_NOTICE);
    expect(textOf(detail)).not.toContain(OLD_KEY_EXPLANATION);
    expect(textOf(detail)).not.toContain("パスワード");
    expect(textOf(item)).toContain(`読み取りメモ: ${NOTES}`);
    expect(textOf(item)).toContain("確信度 83%");
  });

  it("the known no-key writer does not persist a reason, so its stored row is also explained neutrally", async () => {
    const key = await currentSealKey(db as never, USER);
    expect(key).toBeNull();
    const closed = await closedBody(key, USER, EMAIL, { subject: "合成の件名", from_name: null, from_address: "orders@example.test", text: "合成の本文", html: null }, false);
    expect(closed.body_state).toBe("dropped");
    expect(closed).not.toHaveProperty("error");
    seedMail({ ...closed, error: null, processing_status: "processed" });
    const { detail } = await renderHistory();
    expect(textOf(detail)).toContain(NEUTRAL_NOTICE);
    expect(textOf(detail)).not.toContain(OLD_KEY_EXPLANATION);
    expect(textOf(detail)).not.toContain(EXPIRY_NOTICE);
  });

  it.each(["plain", null])("plain and legacy body_state=%s show the body without a dropped-mail explanation", async (body_state) => {
    seedMail({ body_state, subject: "保存された件名", from_address: "orders@example.test", text_body: "保存された本文" });
    const { item, detail } = await renderHistory();
    expect(textOf(item)).toContain("保存された件名");
    expect(textOf(findAll(detail, (node) => node.tag === "pre")[0])).toBe("保存された本文");
    expect(textOf(detail)).not.toContain(EXPIRY_NOTICE);
    expect(textOf(detail)).not.toContain(NEUTRAL_NOTICE);
  });

  it("a sealed mail keeps its password-opening UI without any removal reason", async () => {
    seedMail({ body_state: "sealed", body_envelope: { v: 1, alg: "P256-HKDF-SHA256-A256GCM", kid: "0".repeat(32), epk: "QkVHSU4tQ0lQSEVSVEVYVA==", iv: "AAAAAAAAAAAAAAAA", ct: "U1lOVEhFVElD" } });
    const { item } = await renderHistory();
    expect(textOf(item)).toContain("暗号化されたメール");
    expect(findAll(item, (node) => node.tag === "input" && node.attrs.type === "password")).toHaveLength(1);
    expect(textOf(item)).toContain(`読み取りメモ: ${NOTES}`);
    expect(textOf(item)).toContain("確信度 83%");
    expect(textOf(item)).not.toContain(EXPIRY_NOTICE);
    expect(textOf(item)).not.toContain(NEUTRAL_NOTICE);
  });
});
