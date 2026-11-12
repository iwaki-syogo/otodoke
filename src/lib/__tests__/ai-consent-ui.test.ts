import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_CONSENT_TEXT, AI_CONSENT_TEXT_VERSION } from "@/lib/ai-consent-text";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

const USER = "00000000-0000-4000-8000-00000000000a";
const ADDRESS = "abcdefghjk@in.example.test";
const mocks = vi.hoisted(() => ({ db: null as unknown, user: { id: "00000000-0000-4000-8000-00000000000a" } as { id: string } | null, ensure: vi.fn(), revalidate: vi.fn(), readAfter: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate, revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => { throw new Error(`REDIRECT:${href}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.db, getUser: async () => mocks.user }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/ai-consent-run", () => ({ runReadAfterConsent: mocks.readAfter }));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: mocks.ensure, inboxEmail: () => ADDRESS }));
vi.mock("@/lib/seal-later", () => ({ scheduleSealRemaining: vi.fn() }));
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));

let db: FakeDb;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: USER };
  db = new FakeDb({ parcels: [], emails: [], screen_events: [] });
  mocks.db = db;
  mocks.ensure.mockResolvedValue("abcdefghjk");
  mocks.readAfter.mockResolvedValue({ ok: true, read: 0, overLimit: false, unavailable: false });
});

function choose(decision: "granted" | "declined") {
  db.rows("ai_reading_consents").push({ user_id: USER, decision, decided_at: "2026-11-12T00:00:00Z", text_version: AI_CONSENT_TEXT_VERSION });
}

function activeKey() {
  db.rows("user_keys").push({ user_id: USER, key_id: "a".repeat(32), public_key: "x", wrapped_private_key: "x", wrap_iv: "x", kdf_salt: "x", kdf_iterations: 600000, challenge_hash: "0".repeat(64), created_at: "2026-11-06T00:00:00Z", activated_at: "2026-11-06T00:00:00Z", retired_at: null });
}

function failConsentRead() {
  db.hooks.push((q) => q.table === "ai_reading_consents" ? { data: null, error: { message: "temporarily unavailable" } } : undefined);
}

async function renderList(sample = false) {
  const Page = (await import("@/app/app/page")).default;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(sample ? { sample: "1" } : {}) })));
}

describe("the first reading-permission screen", () => {
  it.each(["list", "welcome", "settings"] as const)("the %s consent screen shows the approved purpose immediately after the existing body", async (after) => {
    const { ReadingConsent } = await import("@/app/app/reading/reading-consent");
    const root = parseHtml(renderToStaticMarkup(ReadingConsent({ after })));
    const paragraphs = findAll(root, (n) => n.tag === "p");
    expect(paragraphs.slice(0, 2).map(textOf)).toEqual([
      "届いたメールは、Anthropic の Claude で読み取ります。",
      "メールの本文を送り、荷物の情報だけを取り出します。",
    ]);
    expect(paragraphs[1]?.parent).toBe(paragraphs[0].parent);
    const siblings = paragraphs[0].parent!.children.filter((node) => typeof node !== "string");
    expect(siblings[siblings.indexOf(paragraphs[0]) + 1]).toBe(paragraphs[1]);
    expect(paragraphs.filter((n) => textOf(n) === "メールの本文を送り、荷物の情報だけを取り出します。")).toHaveLength(1);
    expect(AI_CONSENT_TEXT_VERSION).toBe("v1");
  });

  it("an unanswered person sees the one wording source, both choices and the sample exit", async () => {
    const html = await renderList();
    expect(findAll(html, (n) => n.tag === "h1").map(textOf)).toEqual([AI_CONSENT_TEXT.title]);
    expect(textOf(html)).toContain(AI_CONSENT_TEXT.body);
    expect(findAll(html, (n) => n.tag === "button").map((n) => [n.attrs.name, n.attrs.value, textOf(n)])).toEqual([
      ["decision", "granted", AI_CONSENT_TEXT.allow],
      ["decision", "declined", AI_CONSENT_TEXT.decline],
    ]);
    expect(findAll(html, (n) => n.tag === "a").map((n) => [n.attrs.href, textOf(n)])).toEqual([
      ["/privacy", AI_CONSENT_TEXT.privacy],
      ["/app/settings/demo", AI_CONSENT_TEXT.sample],
      ["/app/parcels/new", AI_CONSENT_TEXT.manual],
    ]);
    expect(db.callsOn("parcels")).toHaveLength(0);
  });

  it("a decline opens the manual list without repeating the question or forwarding setup", async () => {
    choose("declined");
    const html = await renderList();
    expect(textOf(html)).not.toContain(AI_CONSENT_TEXT.body);
    expect(findAll(html, (n) => n.tag === "a" && n.attrs.href === "/app/parcels/new").map(textOf)).toEqual(["＋ 登録", AI_CONSENT_TEXT.manual]);
    expect(textOf(html)).not.toContain("自動転送を設定");
    expect(findAll(html, (n) => n.tag === "a" && n.attrs.href.includes("forwarding"))).toHaveLength(0);
  });

  it("an explicit sample view shows its results before a choice without creating a consent row", async () => {
    db.rows("parcels").push({ id: "sample-parcel", user_id: USER, shop: "見本の店", title: "見本の荷物", status: "ordered" });
    const html = await renderList(true);
    expect(textOf(html)).toContain("見本の荷物");
    expect(textOf(html)).not.toContain(AI_CONSENT_TEXT.body);
    expect(db.rows("ai_reading_consents")).toEqual([]);
    expect(findAll(html, (n) => n.tag === "a" && n.attrs.href === "/app/reading")).toHaveLength(1);
  });

  it("a failed consent read keeps manual access and says it failed instead of showing an unanswered choice", async () => {
    failConsentRead();
    const html = await renderList();
    expect(textOf(html)).toContain(AI_CONSENT_TEXT.readFailed);
    expect(findAll(html, (n) => n.tag === "button" && n.attrs.name === "decision")).toHaveLength(0);
    expect(findAll(html, (n) => n.tag === "a" && n.attrs.href === "/app/parcels/new").length).toBeGreaterThan(0);
    expect(findAll(html, (n) => n.attrs.role === "alert")).toHaveLength(1);
  });
});

describe("forwarding addresses require a positive consent read", () => {
  it.each(["undecided", "declined", "unknown"] as const)("settings hides the address and never creates one for %s", async (state) => {
    activeKey();
    if (state === "declined") choose("declined");
    if (state === "unknown") failConsentRead();
    const Page = (await import("@/app/app/settings/forwarding/page")).default;
    const html = renderToStaticMarkup(await Page());
    expect(html).not.toContain(ADDRESS);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(db.callsOn("user_keys")).toHaveLength(0);
    expect(html.includes(AI_CONSENT_TEXT.readFailed)).toBe(state === "unknown");
  });

  it.each(["undecided", "declined", "unknown"] as const)("welcome never creates an address for %s", async (state) => {
    activeKey();
    if (state === "declined") choose("declined");
    if (state === "unknown") failConsentRead();
    const Page = (await import("@/app/app/welcome/page")).default;
    if (state === "unknown") {
      const html = renderToStaticMarkup(await Page());
      expect(html).toContain(AI_CONSENT_TEXT.readFailed);
      expect(html).not.toContain(ADDRESS);
    } else {
      await expect(Page()).rejects.toThrow(state === "undecided" ? "REDIRECT:/app/reading?after=welcome" : "REDIRECT:/app");
    }
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("the granted control still displays the address in both pages", async () => {
    choose("granted");
    activeKey();
    for (const Page of [(await import("@/app/app/welcome/page")).default, (await import("@/app/app/settings/forwarding/page")).default]) {
      expect(renderToStaticMarkup(await Page())).toContain(ADDRESS);
    }
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
  });
});

describe("changing the reading permission", () => {
  const form = (decision: string, after = "list") => {
    const data = new FormData();
    data.set("decision", decision);
    data.set("after", after);
    return data;
  };

  it.each(["granted", "declined"] as const)("stores %s through the authenticated RPC with v1 and revalidates", async (decision) => {
    const rpc = vi.spyOn(db, "rpc").mockResolvedValue({ data: [{ decision, decided_at: "2026-11-12T01:00:00Z" }], error: null });
    const { setAiReadingDecision } = await import("@/app/app/reading/actions");
    await expect(setAiReadingDecision(form(decision))).rejects.toThrow("REDIRECT:/app");
    expect(rpc).toHaveBeenCalledWith("set_ai_reading", { p_decision: decision, p_text_version: "v1" });
    expect(mocks.revalidate).toHaveBeenCalledWith("/app", "layout");
    expect(db.callsOn("ai_reading_consents", "insert")).toHaveLength(0);
  });

  it("returns a newly granted person to welcome and a revoked person to settings", async () => {
    const rpc = vi.spyOn(db, "rpc");
    rpc.mockResolvedValueOnce({ data: [{ decision: "granted", decided_at: "2026-11-12T01:00:00Z" }], error: null });
    const { setAiReadingDecision } = await import("@/app/app/reading/actions");
    await expect(setAiReadingDecision(form("granted", "welcome"))).rejects.toThrow("REDIRECT:/app/welcome");
    rpc.mockResolvedValueOnce({ data: [{ decision: "declined", decided_at: "2026-11-12T02:00:00Z" }], error: null });
    await expect(setAiReadingDecision(form("declined", "settings"))).rejects.toThrow("REDIRECT:/app/settings/mail-handling");
  });

  it.each([
    { data: null, error: { message: "not saved" } },
    { data: [], error: null },
    { data: [{ decision: "declined", decided_at: "2026-11-12T01:00:00Z" }], error: null },
    { data: [{ decision: "granted", decided_at: "unreadable" }], error: null },
  ])("does not call a failed or malformed save a success: %j", async (answer) => {
    vi.spyOn(db, "rpc").mockResolvedValue(answer);
    const { setAiReadingDecision } = await import("@/app/app/reading/actions");
    await expect(setAiReadingDecision(form("granted", "welcome"))).rejects.toThrow("REDIRECT:/app/reading?error=save&after=welcome");
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("does not write an invalid choice or an unauthenticated choice", async () => {
    const rpc = vi.spyOn(db, "rpc");
    const { setAiReadingDecision } = await import("@/app/app/reading/actions");
    await expect(setAiReadingDecision(form("other"))).rejects.toThrow("REDIRECT:/app/reading?error=save");
    mocks.user = null;
    await expect(setAiReadingDecision(form("granted"))).rejects.toThrow("REDIRECT:/login");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["granted", "declined", "undecided", "unknown"] as const)("settings exposes the right action for %s", async (state) => {
    if (state === "granted" || state === "declined") choose(state);
    if (state === "unknown") failConsentRead();
    const Page = (await import("@/app/app/settings/mail-handling/page")).default;
    const html = parseHtml(renderToStaticMarkup(await Page()));
    const stop = findAll(html, (n) => n.tag === "button" && textOf(n) === AI_CONSENT_TEXT.stop);
    const start = findAll(html, (n) => n.tag === "a" && textOf(n) === AI_CONSENT_TEXT.start);
    expect(stop).toHaveLength(state === "granted" ? 1 : 0);
    expect(start).toHaveLength(state === "declined" || state === "undecided" ? 1 : 0);
    expect(textOf(html).includes(AI_CONSENT_TEXT.readFailed)).toBe(state === "unknown");
  });
});

describe("wording and a local preview of the real component", () => {
  it("the request uses the centralized words and its rendered markup can be reviewed offline", async () => {
    const { ReadingConsent } = await import("@/app/app/reading/reading-consent");
    const React = await import("react");
    const markup = renderToStaticMarkup(React.createElement(ReadingConsent));
    const source = readFileSync(path.resolve(__dirname, "../../app/app/reading/reading-consent.tsx"), "utf8");
    expect(source).toContain("AI_CONSENT_TEXT");
    for (const word of [AI_CONSENT_TEXT.title, AI_CONSENT_TEXT.body, AI_CONSENT_TEXT.allow, AI_CONSENT_TEXT.decline]) {
      expect(markup).toContain(word);
      expect(source).not.toContain(word);
    }
    if (process.env.AI_CONSENT_PREVIEW === "1") {
      const dir = path.resolve(__dirname, "../../../.vitest/ai-consent-preview");
      mkdirSync(dir, { recursive: true });
      // The markup is the production component. Only the surrounding offline page is a preview.
      for (const [name, props] of [["consent", {}], ["unknown", { unknown: true }], ["save-failed", { error: "save" as const }]] as const) {
        writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${AI_CONSENT_TEXT.title}</title><link rel="stylesheet" href="preview.css"><body><main class="mx-auto min-h-dvh w-full max-w-md px-4 pb-28 pt-6">${renderToStaticMarkup(React.createElement(ReadingConsent, props))}</main></body></html>`);
      }
      const { MailHandling } = await import("@/app/app/settings/mail-handling");
      writeFileSync(path.join(dir, "mail-handling.html"), `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>あなたのメールの扱い</title><link rel="stylesheet" href="preview.css"><body><main class="mx-auto min-h-dvh w-full max-w-md px-4 pb-28 pt-6">${renderToStaticMarkup(React.createElement(MailHandling))}</main></body></html>`);
    }
  });
});
