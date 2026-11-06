import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * 設定 「読まなかったメール」 after the review of 2026-11-06 (B-3, F-1):
 *  - 「これは荷物」 on a mail from a shared domain (gmail.com, ...) remembers nothing and says why;
 *  - the remembered senders are listed, each with 「外す」;
 *  - what the page says after a press leads somewhere: the parcel can be registered by hand. The
 *    old 「今回のメールは、もう一度転送してください」 was a dead end (a forwarded copy is dropped again).
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-0000000000ff";
const SHOP_ROW = "11111111-1111-4111-8111-111111111111";
const GMAIL_ROW = "22222222-2222-4222-8222-222222222222";

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}

const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
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
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.state.db }));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "testbox", inboxEmail: () => null }));
vi.mock("@/app/app/settings/key-actions", () => ({ registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn(), sealStoredMail: vi.fn(), readMailKey: vi.fn(), readRetiredMailKeys: vi.fn(), readSealedMail: vi.fn() }));

const { markWronglyDropped, forgetSender } = await import("@/app/app/settings/actions");

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({
    screen_events: [
      { id: SHOP_ROW, user_id: USER, decision: "dropped", subject: "ご購入ありがとうございます", from_domain: "shop.example.test", created_at: "2026-11-05T00:00:00Z", flagged_at: null },
      { id: GMAIL_ROW, user_id: USER, decision: "dropped", subject: "Fwd: ご購入ありがとうございます", from_domain: "gmail.com", created_at: "2026-11-05T01:00:00Z", flagged_at: null },
    ],
    emails: [],
    parcels: [],
  });
  // The unread count's or(and(...)) filter is beyond the fake; nothing here is unread.
  db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "or") ? { data: null, error: null, count: 0 } : undefined));
  mocks.state.db = db;
});

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

async function redirectOf(run: Promise<void>): Promise<string> {
  try {
    await run;
  } catch (err) {
    if (err instanceof Redirect) return err.to;
    throw err;
  }
  throw new Error("no redirect");
}

const flags = () => db.rows("screen_events").map((e) => [e.from_domain, e.user_id === USER ? "me" : "other", e.flagged_at ? "flagged" : "-"]);

describe("markWronglyDropped", () => {
  it("remembers a shop's domain and answers ?flagged=remembered", async () => {
    expect(await redirectOf(markWronglyDropped(form({ id: SHOP_ROW })))).toBe("/app/settings?flagged=remembered");
    expect(db.find("screen_events", SHOP_ROW)!.flagged_at).not.toBeNull();
  });

  it("remembers nothing for a shared domain and answers ?flagged=shared", async () => {
    expect(await redirectOf(markWronglyDropped(form({ id: GMAIL_ROW })))).toBe("/app/settings?flagged=shared");
    expect(db.find("screen_events", GMAIL_ROW)!.flagged_at).toBeNull();
    expect(db.callsOn("screen_events", "update")).toHaveLength(0);
  });

  it("answers ?flagged=failed for an id that is not a uuid, another user's row, or a failed write", async () => {
    expect(await redirectOf(markWronglyDropped(form({ id: "not-a-uuid" })))).toBe("/app/settings?flagged=failed");
    db.find("screen_events", SHOP_ROW)!.user_id = OTHER;
    expect(await redirectOf(markWronglyDropped(form({ id: SHOP_ROW })))).toBe("/app/settings?flagged=failed");
    expect(db.find("screen_events", SHOP_ROW)!.flagged_at).toBeNull();

    db.find("screen_events", SHOP_ROW)!.user_id = USER;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "screen_events" && q.op === "update" ? { data: null, error: { message: "boom" } } : undefined));
    expect(await redirectOf(markWronglyDropped(form({ id: SHOP_ROW })))).toBe("/app/settings?flagged=failed");
    log.mockRestore();
  });
});

describe("forgetSender (「外す」)", () => {
  it("unmarks every row of that domain for this user only", async () => {
    db.rows("screen_events").push(
      { id: "33333333-3333-4333-8333-333333333333", user_id: USER, decision: "dropped", subject: "別の通知", from_domain: "shop.example.test", created_at: "2026-11-04T00:00:00Z", flagged_at: "2026-11-04T01:00:00Z" },
      { id: "44444444-4444-4444-8444-444444444444", user_id: OTHER, decision: "dropped", subject: "他人の", from_domain: "shop.example.test", created_at: "2026-11-04T00:00:00Z", flagged_at: "2026-11-04T01:00:00Z" },
    );
    db.find("screen_events", SHOP_ROW)!.flagged_at = "2026-11-05T02:00:00Z";
    expect(await redirectOf(forgetSender(form({ domain: "shop.example.test" })))).toBe("/app/settings?unflagged=done");
    expect(flags()).toEqual([
      ["shop.example.test", "me", "-"],
      ["gmail.com", "me", "-"],
      ["shop.example.test", "me", "-"],
      ["shop.example.test", "other", "flagged"],
    ]);
  });

  it("answers ?unflagged=failed for an empty domain or a failed write", async () => {
    expect(await redirectOf(forgetSender(form({ domain: "" })))).toBe("/app/settings?unflagged=failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "screen_events" && q.op === "update" ? { data: null, error: { message: "boom" } } : undefined));
    expect(await redirectOf(forgetSender(form({ domain: "shop.example.test" })))).toBe("/app/settings?unflagged=failed");
    log.mockRestore();
  });
});

async function render(searchParams: Record<string, string> = {}) {
  const Page = (await import("@/app/app/settings/page")).default;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(searchParams) })));
}

const droppedSection = (root: HtmlNode) => {
  const found = findAll(root, (n) => n.tag === "section" && findAll(n, (h) => h.tag === "h2" && textOf(h) === "読まなかったメール").length > 0);
  expect(found).toHaveLength(1);
  return found[0];
};

const rememberedList = (section: HtmlNode) => {
  const heading = findAll(section, (n) => n.tag === "h3" && textOf(n) === "覚えた差出人");
  if (heading.length === 0) return null;
  return findAll(section, (n) => n.tag === "li" && findAll(n, (b) => b.tag === "button" && textOf(b).includes("外す")).length > 0).map((li) => ({
    domain: textOf(findAll(li, (p) => p.tag === "p")[0]),
    field: findAll(li, (i) => i.tag === "input" && i.attrs.name === "domain")[0]?.attrs.value,
  }));
};

describe("/app/settings: 覚えた差出人", () => {
  it("lists each remembered domain once, with 「外す」 carrying that domain", async () => {
    db.find("screen_events", SHOP_ROW)!.flagged_at = "2026-11-05T02:00:00Z";
    db.rows("screen_events").push({ id: "55555555-5555-4555-8555-555555555555", user_id: USER, decision: "dropped", subject: "二通目", from_domain: "shop.example.test", created_at: "2026-11-05T03:00:00Z", flagged_at: "2026-11-05T04:00:00Z" });
    expect(rememberedList(droppedSection(await render()))).toEqual([{ domain: "shop.example.test", field: "shop.example.test" }]);
  });

  it("does not list a mark on a shared domain made before (the pipeline does not honour it)", async () => {
    db.find("screen_events", GMAIL_ROW)!.flagged_at = "2026-11-05T02:00:00Z";
    expect(rememberedList(droppedSection(await render()))).toBeNull();
  });

  it("has no list when nothing is remembered", async () => {
    expect(rememberedList(droppedSection(await render()))).toBeNull();
  });
});

describe("/app/settings: what a press of 「これは荷物」 / 「外す」 says", () => {
  const registerLinks = (section: HtmlNode) => findAll(section, (n) => n.tag === "a" && n.attrs.href === "/app/parcels/new");

  it("remembered: says Claude checks this sender from now on, and offers to register the parcel by hand", async () => {
    const section = droppedSection(await render({ flagged: "remembered" }));
    expect(textOf(section)).toContain("覚えました。この差出人のメールは、次から Claude が確認します。今回の荷物は手で登録できます。");
    expect(registerLinks(section).map(textOf)).toEqual(["荷物を登録する"]);
  });

  it("shared: says why nothing was remembered, and offers the same way out", async () => {
    const section = droppedSection(await render({ flagged: "shared" }));
    expect(textOf(section)).toContain("Gmail など多くの人が使うアドレスは、差出人として覚えられません。今回の荷物は手で登録できます。");
    expect(registerLinks(section)).toHaveLength(1);
  });

  it("failures and 「外す」 say so next to the list", async () => {
    expect(textOf(droppedSection(await render({ flagged: "failed" })))).toContain("記録できませんでした。もう一度お試しください。");
    expect(textOf(droppedSection(await render({ unflagged: "done" })))).toContain("外しました。");
    expect(textOf(droppedSection(await render({ unflagged: "failed" })))).toContain("外せませんでした。もう一度お試しください。");
  });

  it("never asks to forward the mail again, and shows nothing for a code it does not know", async () => {
    for (const flagged of ["remembered", "shared", "1"]) expect(textOf(await render({ flagged }))).not.toContain("もう一度転送してください");
    const crafted = droppedSection(await render({ flagged: "【重要】example.invalid で再設定", unflagged: "__proto__" }));
    expect(textOf(crafted)).not.toContain("example.invalid");
    expect(registerLinks(crafted)).toHaveLength(0);
  });
});
