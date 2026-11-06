import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * [Review 2026-11-06 D2-3 / E-14] The empty list says what to do next as a question, and that
 * setting up is once: never that each order mail is sent to Otodoke (「〜に送ると、ここに並びます」).
 * The button goes to the settings as before, named for going there (「設定する」): it does not
 * promise the address at once (「転送先を見る」), since with encryption the settings ask for the
 * passphrase first. 「サンプルで試す」 still goes to the sample.
 */

const USER = "00000000-0000-4000-8000-00000000000a";

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
  getUser: async () => ({ id: USER }),
}));

beforeEach(() => {
  mocks.state.db = new FakeDb({ parcels: [], emails: [] });
});

async function renderEmpty() {
  const Page = (await import("@/app/app/page")).default;
  return parseHtml(renderToStaticMarkup(await Page()));
}

/** The block under 「まだ荷物がありません」. */
function emptyState(root: HtmlNode): HtmlNode {
  const heading = findAll(root, (n) => n.tag === "h2" && textOf(n) === "まだ荷物がありません");
  expect(heading).toHaveLength(1);
  return heading[0].parent!;
}

describe("the empty parcel list", () => {
  it("asks about setting up forwarding and says it is once", async () => {
    const block = emptyState(await renderEmpty());
    const guide = findAll(block, (n) => n.tag === "p" && textOf(n).includes("設定"));
    expect(guide.map((p) => textOf(p).trim())).toEqual(["メールの自動転送を設定しますか？設定は最初の 1 回だけです。"]);
  });

  it("never reads as sending each mail, nor promises the address at once", async () => {
    const text = textOf(emptyState(await renderEmpty()));
    for (const old of ["送ると", "転送用アドレス", "ここに並びます", "転送先を見る", "転送先を確認", "転送するだけ"]) expect(text).not.toContain(old);
  });

  it("goes to the settings with 「設定する」 and to the sample with 「サンプルで試す」, as before", async () => {
    const block = emptyState(await renderEmpty());
    expect(findAll(block, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a).trim()])).toEqual([
      ["/app/settings/forwarding", "設定する"],
      ["/app/settings/demo", "サンプルで試す"],
    ]);
    // Nothing else on the empty page leads to the settings.
    expect(linksTo(await renderEmpty(), "/app/settings/forwarding")).toHaveLength(1);
    expect(linksTo(await renderEmpty(), "/app/settings")).toHaveLength(0);
  });
});

/**
 * [Review 2026-11-06 R2-5] Once mail of the person's own has come in (a stored mail other than the
 * public samples, or a mail the screen dropped), forwarding is set up: the empty list says mail is
 * arriving instead of asking them to set it up again (after 「すべての荷物を消す」, say, when the
 * mail since was all ads). The samples never count, so clearing them brings the question back.
 */
describe("[R2-5] the empty list once mail of one's own has come in", () => {
  const OTHER = "00000000-0000-4000-8000-00000000000b";
  const RECEIVED = "メールは届いています。荷物のメールが届くまで、お待ちください。";
  const QUESTION = "メールの自動転送を設定しますか？設定は最初の 1 回だけです。";
  /**
   * The unread-mail notice's count is answered here: fake-db does not read and() inside or(), and
   * only over-limit or failed mail is unread in these seeds.
   */
  const withMail = (seed: Record<string, Array<Record<string, unknown>>>) => {
    const db = new FakeDb({ parcels: [], emails: [], screen_events: [], ...seed });
    db.hooks.push((q, d) =>
      q.table === "emails" && q.filters.some((f) => f.method === "or")
        ? { data: null, error: null, count: d.rows("emails").filter((e) => ["over_limit", "failed"].includes(String(e.processing_status))).length }
        : undefined,
    );
    mocks.state.db = db;
    return db;
  };
  const render = async (seed: Record<string, Array<Record<string, unknown>>>) => {
    withMail(seed);
    return emptyState(await renderEmpty());
  };
  const guide = (block: HtmlNode) => findAll(block, (n) => n.tag === "p" && textOf(n).includes("。")).map((p) => textOf(p).trim());
  const mail = (over: Record<string, unknown>) => ({ id: `e-${Math.random()}`, user_id: USER, provider_email_id: "re_123", message_id: "<a@shop.example>", processing_status: "processed", ...over });

  const confirmation = () => mail({ classification: "forwarding_confirmation", from_address: "forwarding-noreply@google.com", from_domain: "google.com" });

  it.each([
    ["a mail read into nothing", { emails: [mail({})] }],
    ["a mail still unread (over the limit)", { emails: [mail({ processing_status: "over_limit" })] }],
    ["a mail the screen dropped", { screen_events: [{ id: "s1", user_id: USER, decision: "dropped", from_domain: "ads.example" }] }],
    ["Gmail's confirmation and a forwarded mail", { emails: [confirmation(), mail({})] }],
    ["Gmail's confirmation and a dropped mail", { emails: [confirmation()], screen_events: [{ id: "s1", user_id: USER, decision: "dropped" }] }],
  ])("says mail is arriving after %s, not to set up forwarding again", async (_what, seed) => {
    const block = await render(seed);
    expect(guide(block)).toEqual([RECEIVED]);
    expect(textOf(block)).not.toContain("設定しますか");
    expect(findAll(block, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a).trim()])).toEqual([
      ["/app/settings/trouble", "設定を見る"],
      ["/app/settings/demo", "サンプルで試す"],
    ]);
  });

  /**
   * [Review R3-3] Gmail's forwarding confirmation is not forwarded mail: Gmail sends it when the
   * address is added and forwards nothing until it is approved, so 「お待ちください」 would wait
   * forever. With only that, the list asks about the approval (worded for both: not approved yet,
   * or approved and no mail since) and its button goes to the approval in 設定 (#gmail-approval;
   * approval-link-scroll.test.ts follows it there).
   */
  it("with only Gmail's forwarding confirmation, asks about the approval instead of saying mail arrives", async () => {
    for (const seed of [{ emails: [confirmation()] }, { emails: [confirmation(), confirmation()] }]) {
      const block = await render(seed);
      expect(guide(block)).toEqual(["Gmail の転送は承認しましたか？承認すると、荷物のメールが届きはじめます。"]);
      expect(textOf(block)).not.toContain("届いています");
      expect(textOf(block)).not.toContain("お待ちください");
      expect(findAll(block, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a).trim()])).toEqual([
        ["/app/settings/forwarding#gmail-approval", "設定で承認する"],
        ["/app/settings/demo", "サンプルで試す"],
      ]);
    }
  });

  describe("dated: the approval is offered while nothing arrived after the newest valid confirmation", () => {
    const at = (day: number) => `2026-11-0${day}T00:00:00Z`;
    const dated = (id: string, day: number, over: Record<string, unknown> = {}) => mail({ id, created_at: at(day), sent_at: at(day), ...over });
    const dConfirmation = (day: number) => dated(`c${day}`, day, { classification: "forwarding_confirmation", provider_email_id: `re_c${day}`, forwarding_confirm_url: "https://mail-settings.google.com/mail/vf-xyz" });
    const APPROVAL = "Gmail の転送は承認しましたか？承認すると、荷物のメールが届きはじめます。";

    it("an old ordinary mail and a newer confirmation -> approval (also with an old dropped mail)", async () => {
      expect(guide(await render({ emails: [dated("m1", 5), dConfirmation(6)] }))).toEqual([APPROVAL]);
      expect(guide(await render({ emails: [dConfirmation(6)], screen_events: [{ id: "s1", user_id: USER, decision: "dropped", created_at: at(5) }] }))).toEqual([APPROVAL]);
    });

    it("a confirmation and a newer mail or dropped mail -> received", async () => {
      expect(guide(await render({ emails: [dConfirmation(6), dated("m1", 7)] }))).toEqual([RECEIVED]);
      expect(guide(await render({ emails: [dConfirmation(6)], screen_events: [{ id: "s1", user_id: USER, decision: "dropped", created_at: at(7) }] }))).toEqual([RECEIVED]);
    });

    it("a failed after-check does not hide the approval", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const db = withMail({ emails: [dated("m1", 5), dConfirmation(6)] });
      db.hooks.unshift((q) => (q.table === "screen_events" ? { data: null, error: { message: "boom" }, count: null } : undefined));
      expect(guide(emptyState(await renderEmpty()))).toEqual([APPROVAL]);
      log.mockRestore();
    });
  });

  it("no public sample is a Gmail confirmation (the samples are left out of the count once, not twice)", () => {
    const dir = path.resolve(__dirname, "../../../fixtures/demo/mails");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/forwarding-noreply@google\.com/i);
  });

  it("never reads as sending each mail", async () => {
    for (const seed of [{ emails: [mail({})] }, { emails: [confirmation()] }]) {
      const text = textOf(await render(seed));
      for (const old of ["送ると", "転送用アドレス", "ここに並びます", "転送するだけ", "（", "("]) expect(text).not.toContain(old);
    }
  });

  it("asks the setup question when the only mail is the public samples, and when there is none (the sample cleared)", async () => {
    expect(guide(await render({ emails: [mail({ provider_email_id: "demo:01-amazon-order.json", message_id: "demo:01-amazon-order.json" })] }))).toEqual([QUESTION]);
    expect(guide(await render({}))).toEqual([QUESTION]);
  });

  it("does not count another person's mail", async () => {
    expect(guide(await render({ emails: [mail({ user_id: OTHER })], screen_events: [{ id: "s1", user_id: OTHER, decision: "dropped" }] }))).toEqual([QUESTION]);
  });

  it("asks the setup question, as before, when the mail cannot be counted", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withMail({ emails: [mail({})] }).hooks.push((q) => (q.table === "screen_events" ? { data: null, error: { message: "boom" }, count: null } : undefined));
      expect(guide(emptyState(await renderEmpty()))).toEqual([QUESTION]);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("counts the mail only for the empty list", async () => {
    const db = new FakeDb({ parcels: [{ id: "p1", user_id: USER, shop: "テスト店", title: "品名", status: "shipped" }], emails: [], screen_events: [] });
    mocks.state.db = db;
    await renderEmpty();
    expect(db.callsOn("screen_events")).toHaveLength(0);
  });
});

describe("the screens", () => {
  // 「転送するだけ」 reads as forwarding each mail by hand.
  const appDir = path.resolve(__dirname, "../../app");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) ? [full] : [];
    });

  it("never say 「転送するだけ」", () => {
    expect(files(appDir).length).toBeGreaterThan(0);
    for (const f of files(appDir)) expect(readFileSync(f, "utf8"), f).not.toContain("転送するだけ");
  });
});
