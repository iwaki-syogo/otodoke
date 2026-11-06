import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";
import { appSourceFiles, read, withoutComments } from "./source-scan";

/**
 * The parcel page shows a sealed mail as a neutral line (date, sender domain) and opens it only in
 * the browser; a dropped mail says so honestly; a mail from before encryption shows as before.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const PARCEL = "11111111-1111-4111-8111-111111111111";
const ENVELOPE = { v: 1, alg: "P256-HKDF-SHA256-A256GCM", kid: "0".repeat(32), epk: "QkVHSU4tQ0lQSEVSVEVYVA==", iv: "AAAAAAAAAAAAAAAA", ct: "Q0lQSEVSVEVYVC1NQVJLRVI=" };

const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({
    parcels: [{ id: PARCEL, user_id: USER, shop: "テスト店", title: "テスト用の品名", status: "shipped", source: "mail" }],
  });
  mocks.state.db = db;
});

function addMail(id: string, row: Record<string, unknown>, notes: string | null = null) {
  db.rows("emails").push({ id, user_id: USER, sent_at: "2026-11-01T00:00:00Z", classification: "shipping", subject: null, from_name: null, from_address: null, text_body: null, html_body: null, ...row });
  db.rows("extractions").push({ id: `x-${id}`, user_id: USER, parcel_id: PARCEL, email_id: id, confidence: 0.9, result: { notes }, created_at: "2026-11-01T00:00:00Z" });
}

async function render() {
  const Page = (await import("@/app/app/parcels/[id]/page")).default;
  const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: PARCEL }) }));
  return { html, root: parseHtml(html) };
}

const historyItems = (root: ReturnType<typeof parseHtml>) => findAll(root, (n) => n.tag === "li" && textOf(n).includes("元メールを見る"));

describe("parcel page: mail history with sealed mail", () => {
  it("a sealed mail shows a placeholder with the sender domain and asks for the passphrase; no ciphertext in the page", async () => {
    addMail("e-sealed", { body_state: "sealed", body_envelope: ENVELOPE, from_domain: "shop.example.test" }, "発送日は11/1");
    const { html, root } = await render();
    const [item] = historyItems(root);
    expect(textOf(item)).toContain("暗号化されたメール");
    expect(textOf(item)).toContain("shop.example.test");
    expect(textOf(item)).toContain("読み取りメモ: 発送日は11/1");
    expect(findAll(item, (n) => n.tag === "input" && n.attrs.type === "password")).toHaveLength(1);
    // The envelope is fetched by the browser on demand, never put in the server-rendered page.
    expect(html).not.toContain("Q0lQSEVSVEVYVC1NQVJLRVI=");
    expect(html).not.toContain("body_envelope");
    // The page asked for the state, not the envelope.
    const read = db.callsOn("extractions", "select")[0];
    expect(read.columns).toContain("body_state");
    expect(read.columns).not.toContain("body_envelope");
  });

  it("a dropped mail says the content was not kept", async () => {
    addMail("e-dropped", { body_state: "dropped", from_domain: "shop.example.test" });
    const { root } = await render();
    const [item] = historyItems(root);
    // Decided when the mail is read, not when it arrives (src/lib/mail-seal.ts closedBody), as
    // 「あなたのメールの扱い」 and /privacy say it.
    expect(textOf(item)).toContain("合言葉を決める前に読み取ったメールです。件名・差出人・本文は残していません。");
    expect(textOf(item)).not.toContain("届いたメール");
    expect(findAll(item, (n) => n.tag === "pre")).toHaveLength(0);
  });

  it("a mail from before encryption shows as before, as text", async () => {
    addMail("e-plain", { body_state: "plain", subject: "発送のお知らせ", from_address: "shop@example.test", html_body: "<p>ご注文<b>ありがとう</b></p><script>alert(1)</script>" });
    const { html, root } = await render();
    const [item] = historyItems(root);
    expect(textOf(item)).toContain("発送のお知らせ");
    expect(textOf(findAll(item, (n) => n.tag === "pre")[0])).toBe("ご注文ありがとう");
    expect(html).not.toContain("<script>alert");
  });
});

describe("mail is shown as text only", () => {
  it("no file in src/ renders raw HTML", () => {
    const offenders = appSourceFiles().filter((f) => /dangerouslySetInnerHTML|innerHTML\s*=/.test(withoutComments(read(f))));
    expect(offenders).toEqual([]);
  });
});
