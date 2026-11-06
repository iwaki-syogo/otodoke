import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLAINTEXT_DROP_NOTICE, RESET_LOSES_MAIL } from "@/lib/mail-notices";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * /app/settings: the forwarding address appears only once the mail key is made (with the login
 * password); mail stored in plaintext gets a banner with its count; mail sealed to an earlier key
 * is told honestly; and 「あなたのメールの扱い」 states what is and is not encrypted.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const ADDRESS = "abcdefghjk@in.example.test";

const mocks = vi.hoisted(() => ({ state: { db: null as unknown }, noDomain: false }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/settings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "abcdefghjk", inboxEmail: () => (mocks.noDomain ? null : ADDRESS) }));
vi.mock("@/app/app/settings/actions", () => ({ loadDemo: vi.fn(), readWaitingMail: vi.fn(), markWronglyDropped: vi.fn(), forgetSender: vi.fn(), clearAllParcels: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn(), sealStoredMail: vi.fn(), readMailKey: vi.fn(), readSealedMail: vi.fn() }));
vi.mock("@/app/app/settings/password-actions", () => ({ changeLoginSecret: vi.fn() }));

let db: FakeDb;
beforeEach(() => {
  mocks.noDomain = false;
  db = new FakeDb();
  // The unread count's or(and(...)) filter is beyond the fake; nothing here is unread.
  db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "or") ? { data: null, error: null, count: 0 } : undefined));
  mocks.state.db = db;
});

const activeKey = () =>
  db.rows("user_keys").push({ user_id: USER, key_id: "a".repeat(32), public_key: "x", wrapped_private_key: "x", wrap_iv: "x", kdf_salt: "x", kdf_iterations: 600000, challenge_hash: "0".repeat(64), created_at: "2026-11-06T00:00:00Z", activated_at: "2026-11-06T00:00:00Z", retired_at: null });

const plainRead = (n: number) => {
  for (let i = 0; i < n; i++) db.rows("emails").push({ id: `e${i}`, user_id: USER, processing_status: "processed", body_state: "plain", subject: `件名${i}` });
};

async function render() {
  const Page = (await import("@/app/app/settings/page")).default;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })));
}

const sectionTitled = (root: ReturnType<typeof parseHtml>, title: string) => findAll(root, (n) => n.tag === "section" && findAll(n, (h) => h.tag === "h2" && textOf(h) === title).length > 0);

describe("/app/settings: the mail key first", () => {
  it("without a key: asks for the login password once, says where one is set, and hides the forwarding address", async () => {
    plainRead(3);
    const root = await render();
    const [keySection] = sectionTitled(root, "メールの鍵を作る");
    expect(findAll(keySection, (n) => n.tag === "input" && n.attrs.type === "password")).toHaveLength(1);
    expect(findAll(keySection, (n) => n.tag === "input" && n.attrs.type === "checkbox")).toHaveLength(0);
    expect(findAll(keySection, (n) => n.tag === "button" && textOf(n) === "鍵を作る")).toHaveLength(1);
    expect(textOf(keySection)).toContain("保存済みのメール 3 通も");
    // Those who never set a password (a session from the time of the mail's link) set it there.
    expect(findAll(keySection, (n) => n.tag === "a" && n.attrs.href === "/login/forgot" && textOf(n) === "パスワードを忘れた")).toHaveLength(1);
    const [addressSection] = sectionTitled(root, "転送先アドレス");
    expect(textOf(addressSection)).not.toContain(ADDRESS);
    expect(textOf(addressSection)).toContain("メールの鍵を作ると");
    // The sample still works without a key.
    expect(textOf(sectionTitled(root, "サンプルで試す")[0])).toContain("サンプルのメールを読み込む");
    expect(textOf(root)).not.toContain("合言葉");
  });

  it("with a key: shows the address, the field that opens it, and a 「暗号化する」 banner while plaintext remains", async () => {
    activeKey();
    plainRead(2);
    const root = await render();
    expect(textOf(sectionTitled(root, "転送先アドレス")[0])).toContain(ADDRESS);
    const [keySection] = sectionTitled(root, "パスワード");
    expect(textOf(keySection)).toContain("暗号化されていないメールが 2 通あります");
    expect(findAll(keySection, (n) => n.tag === "button" && textOf(n) === "暗号化する")).toHaveLength(1);
    expect(findAll(keySection, (n) => n.tag === "input" && n.attrs["aria-label"] === "パスワード")).toHaveLength(1);
    expect(findAll(keySection, (n) => n.tag === "summary").map(textOf)).toEqual(["パスワードを変える", "パスワードを忘れたとき"]);
    // A reset loses the mail sealed before, in mail-notices' words, next to the way to it.
    expect(textOf(keySection)).toContain(RESET_LOSES_MAIL);
    expect(findAll(keySection, (n) => n.tag === "a" && n.attrs.href === "/login/forgot" && textOf(n) === "再設定のメールを送る")).toHaveLength(1);
    expect(textOf(root)).not.toContain("合言葉");
  });

  it("with a key and nothing in plaintext: no banner", async () => {
    activeKey();
    const root = await render();
    expect(textOf(sectionTitled(root, "パスワード")[0])).not.toContain("暗号化されていないメール");
  });

  it("tells how many mails are sealed to an earlier key, which the password does not open", async () => {
    activeKey();
    db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.args[0] === "body_envelope->>kid") ? { data: null, error: null, count: 4 } : undefined));
    const root = await render();
    // A reset, or a key from before password-v1: no form opens such mail (the parcel page says so too).
    expect(textOf(sectionTitled(root, "パスワード")[0])).toContain("前の鍵で暗号化したメールが 4 通あります。開けませんが、荷物は残っています。");
  });

  it("a failed key read hides the address too (never shown as 'no key')", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "user_keys" ? { data: null, error: { message: "boom" } } : undefined));
    const root = await render();
    expect(textOf(sectionTitled(root, "パスワード")[0])).toContain("読み込めませんでした");
    expect(sectionTitled(root, "メールの鍵を作る")).toEqual([]);
    expect(textOf(sectionTitled(root, "転送先アドレス")[0])).not.toContain(ADDRESS);
    log.mockRestore();
  });

  it("the forwarding approval link comes from its plaintext column", async () => {
    activeKey();
    db.rows("emails").push({ id: "g", user_id: USER, classification: "forwarding_confirmation", processing_status: "processed", body_state: "sealed", body_envelope: {}, forwarding_confirm_url: "https://mail-settings.google.com/mail/vf-xyz", sent_at: "2026-11-06T00:00:00Z" });
    const root = await render();
    expect(findAll(root, (n) => n.tag === "a" && n.attrs.href === "https://mail-settings.google.com/mail/vf-xyz")).toHaveLength(1);
  });

  it("the approval section is the page's one #gmail-approval, kept off the top edge like #demo", async () => {
    db.rows("emails").push({ id: "g", user_id: USER, classification: "forwarding_confirmation", processing_status: "processed", body_state: "plain", forwarding_confirm_url: "https://mail-settings.google.com/mail/vf-xyz", sent_at: "2026-11-06T00:00:00Z" });
    const root = await render();
    const anchored = findAll(root, (n) => n.attrs.id === "gmail-approval");
    expect(anchored).toHaveLength(1);
    expect(anchored[0].tag).toBe("section");
    expect((anchored[0].attrs.class ?? "").split(/\s+/)).toContain("scroll-mt-4");
    expect(findAll(anchored[0], (h) => h.tag === "h2" && textOf(h) === "Gmail の転送を承認してください")).toHaveLength(1);
    expect(findAll(anchored[0], (n) => n.tag === "a" && n.attrs.href === "https://mail-settings.google.com/mail/vf-xyz")).toHaveLength(1);
  });
});

/** Said the same in 「あなたのメールの扱い」 and in README's section of that name. */
const SAID_IN_BOTH = [
  // Mail read before encryption began stays plaintext until 「暗号化する」.
  "暗号化を始める前に読み取ったメールは、暗号化していません",
  // Whether a mail keeps its subject, sender and body is decided when it is read (src/lib/mail-seal.ts
  // closedBody), not when it arrives: the same sentence as /privacy.
  "Otodoke が暗号化を始めた後、パスワードでログインする前に読み取ったメールは、件名・差出人・本文を残しません",
  // Decision 7 in the words of src/lib/mail-notices.ts, right after the mail read before
  // encryption. No final 「。」 (see below).
  `「暗号化する」を押すまで、運営者が読める形で残ります。${PLAINTEXT_DROP_NOTICE.replace(/。$/, "")}`,
  // A reset loses the mail sealed before; a change keeps it (decision 3).
  `パスワードを忘れたときは、メールで再設定できます。${RESET_LOSES_MAIL}パスワードを変えるだけなら、前のメールもそのまま開けます`,
  "Message-ID",
  "承認リンク",
  "広告など読まなかったメールは、件名と差出人のドメインだけを 14 日間残します",
  // A marked mail is kept while its sender is remembered, and goes 14 days after 「外す」, as /privacy
  // says. No final 「。」: README's list items end without one.
  "「これは荷物」と押したメールは、その差出人を覚えている間は残します。「外す」で外すと、ほかと同じく 14 日で消します",
];

describe("/app/settings: あなたのメールの扱い", () => {
  it("states what is and is not encrypted", async () => {
    const text = textOf(sectionTitled(await render(), "あなたのメールの扱い")[0]);
    for (const fact of [
      "サーバーと Claude API",
      "既定では学習に使いません",
      "件名・差出人・本文",
      "あなたのパスワードでしか開けない形で保存します",
      "パスワードそのものはサーバーに送らないので、運営者もデータベースからは読めません",
      "差出人のドメインは暗号化しません",
      "Resend",
      "最大 7 日間",
      "コードはすべて",
      ...SAID_IN_BOTH,
    ]) {
      expect(text).toContain(fact);
    }
    // No brackets on a screen (the owner rule).
    expect(text).not.toMatch(/[（）()]/);
    expect(text).not.toContain("次から読むために消さずに残します");
    expect(text).not.toContain("合言葉を決める前に届いたメール");
    expect(text).not.toContain("合言葉");
  });

  it("says what is not encrypted, what waits unread, and what the backups keep, in short sentences", async () => {
    const text = textOf(sectionTitled(await render(), "あなたのメールの扱い")[0]);
    for (const sentence of [
      "荷物の情報と読み取り結果、差出人のドメインは暗号化しません。荷物の情報は店・品名・金額・日付・注文番号・伝票番号、読み取り結果は根拠の行と読み取りメモです。根拠の行は本文の抜粋です。",
      "1 日の上限を超えた分など、読み取る前のメールは、読み取るまで暗号化せずに置いておきます。",
      "暗号化していない状態のメールは、データベースのバックアップにも最大 7 日間残ります。読み取る前のものと、暗号化する前のものです。",
    ]) {
      expect(text).toContain(sentence);
    }
    expect(text).not.toContain("読み取り結果の根拠の行・読み取りメモ、差出人");
    expect(text).not.toContain("読み取る前のものも暗号化する前のものも");
  });

  it("with no inbound domain set, it says so and builds no address that looks real", async () => {
    activeKey();
    mocks.noDomain = true;
    const root = await render();
    const [section] = sectionTitled(root, "転送先アドレス");
    const text = textOf(section);
    expect(text).toContain("受信ドメインがまだ設定されていません。");
    expect(text).not.toContain("@");
    expect(text).not.toContain("abcdefghjk");
    expect(findAll(section, (n) => n.tag === "button" && textOf(n).includes("コピー"))).toHaveLength(0);
  });

  it("a dropped mail with no subject says so with a full stop and in paler type than a real subject", async () => {
    activeKey();
    db.rows("screen_events").push(
      { id: "s1", user_id: USER, decision: "dropped", subject: "", from_domain: "a.example.test", created_at: "2026-11-05T00:00:00Z", flagged_at: null },
      { id: "s2", user_id: USER, decision: "dropped", subject: "本物の件名", from_domain: "b.example.test", created_at: "2026-11-05T01:00:00Z", flagged_at: null },
    );
    const root = await render();
    const none = findAll(root, (n) => n.tag === "p" && textOf(n) === "件名はありません。");
    const real = findAll(root, (n) => n.tag === "p" && textOf(n) === "本物の件名");
    expect(none).toHaveLength(1);
    expect(real).toHaveLength(1);
    expect(none[0].attrs.class).toContain("text-neutral-500");
    expect(real[0].attrs.class).not.toContain("text-neutral");
  });

  it("README says the same about mail read before encryption or with no key, decision 7, a reset, Message-ID, the approval link, screened ads and 「これは荷物」", () => {
    const readme = readFileSync(path.resolve(__dirname, "../../../README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## あなたのメールの扱い"), readme.indexOf("## 技術"));
    for (const fact of SAID_IN_BOTH) {
      expect(section).toContain(fact);
    }
    expect(section).not.toContain("合言葉を決める前に届いたメール");
    expect(section).not.toContain("次から読むために消さずに残します");
    expect(section).not.toContain("合言葉");
  });

  it("the list of screened mail says the sender's domain is kept with the subject", async () => {
    const section = findAll(await render(), (n) => n.tag === "section" && findAll(n, (h) => h.tag === "h2" && textOf(h) === "読まなかったメール").length > 0);
    expect(section).toHaveLength(1);
    expect(textOf(section[0])).toContain("本文は保存せず、件名と差出人のドメインだけ 14 日間残します。");
  });

  it("the plaintext banner says the operator can read those mails until they are sealed", async () => {
    activeKey();
    plainRead(2);
    expect(textOf(sectionTitled(await render(), "パスワード")[0])).toContain("押すまでは、運営者が読める形で残ります");
    db = new FakeDb();
    db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "or") ? { data: null, error: null, count: 0 } : undefined));
    mocks.state.db = db;
    plainRead(3);
    expect(textOf(sectionTitled(await render(), "メールの鍵を作る")[0])).toContain("それまでは運営者が読める形です");
  });
});
