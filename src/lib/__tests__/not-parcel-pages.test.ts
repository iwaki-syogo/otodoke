import { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { todayJst } from "@/lib/format";
import {
  EXCLUDED_BY_RULE, EXCLUDED_BY_USER, EXCLUDED_EMPTY, EXCLUDED_PAGE_LABEL, EXCLUDED_TOAST, EXCLUDE_BUTTON_LABEL, EXCLUDE_FAILED,
  RESTORED_TOAST, RESTORE_BUTTON_LABEL, RESTORE_FAILED,
} from "@/lib/not-parcel-text";
import { FakeDb } from "./fake-db";
import { findAll, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * The pages of 「これは荷物ではありません」 (rendered; the controls are in not-parcel-toast.test.ts):
 * - the parcel page: the button is there for a mail parcel and not for one typed in by hand;
 * - the list: 外した荷物 › under キャンセルした荷物, with no count; ?excluded=<id> becomes the notice only for a
 *   well-formed id, on every branch of the list (also the empty one: taking out the last parcel);
 * - 外した荷物: newest first as the database function gives them, who took it out, no link to a parcel page.
 * - the four sentences name who did what, and the two failures differ.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const ID = "10000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({ state: { client: null as unknown } }));

vi.mock("@/lib/ai-consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-consent")>()),
  readAiReadingConsent: async () => "granted",
}));
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
  createClient: async () => mocks.state.client,
  getUser: async () => ({ id: USER }),
}));

const withAuth = (db: FakeDb) => Object.assign(db, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } });
/** The list asks the database for the person's own mark behind ?excluded=<id>: this one has it. */
const withOwnMark = (db: FakeDb) => {
  const rpc = db.rpc.bind(db);
  return Object.assign(db, {
    rpc: (name: string, args?: unknown) => (name === "excluded_parcels" ? Promise.resolve({ data: [{ parcel_id: ID, kind: "user" }], error: null }) : name === "auto_exclusion_would_start" ? Promise.resolve({ data: false, error: null }) : rpc(name, args)),
  });
};
let seq = 0;
const parcel = (over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  user_id: USER,
  shop: "テスト店",
  title: `品名${seq}`,
  status: "shipped",
  source: "mail",
  expected_date: todayJst(),
  ...over,
});

const { default: ListPage } = await import("@/app/app/page");
const { default: DetailPage } = await import("@/app/app/parcels/[id]/page");
const { default: ExcludedPage } = await import("@/app/app/excluded/page");
const { ExcludedToast } = await import("@/app/app/delivered-controls");

/** Every element of a React element tree (before rendering) of the given component. */
function elementsOf(node: unknown, type: unknown, out: ReactElement<{ id?: string }>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => elementsOf(n, type, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: unknown; id?: string }>;
    if (el.type === type) out.push(el);
    elementsOf(el.props.children, type, out);
  }
  return out;
}

const listTree = async (excluded?: string | string[]) => ListPage({ searchParams: Promise.resolve(excluded === undefined ? {} : { excluded }) });
const buttonsNamed = (root: HtmlNode, label: string) => findAll(root, (n) => n.tag === "button" && textOf(n).trim() === label);

describe("the parcel page", () => {
  const detail = async (over: Record<string, unknown>) => {
    const p = parcel(over);
    mocks.state.client = withAuth(new FakeDb({ parcels: [p], parcel_items: [], extractions: [], emails: [] }));
    return parseHtml(renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id: String(p.id) }) })));
  };

  it.each(["ordered", "shipped", "delivered", "cancelled"])("offers 「これは荷物ではありません」 once on a mail parcel (%s)", async (status) => {
    expect(buttonsNamed(await detail({ status }), EXCLUDE_BUTTON_LABEL)).toHaveLength(1);
  });

  it("offers it on a sample parcel too (its mail is a sample, the parcel is not typed in)", async () => {
    expect(buttonsNamed(await detail({ source: "sample" }), EXCLUDE_BUTTON_LABEL)).toHaveLength(1);
  });

  it("does not offer it on a parcel typed in by hand (negative control)", async () => {
    expect(buttonsNamed(await detail({ source: "manual" }), EXCLUDE_BUTTON_LABEL)).toHaveLength(0);
  });
});

describe("the list", () => {
  const seed = (parcels: Record<string, unknown>[]) => { mocks.state.client = withOwnMark(withAuth(new FakeDb({ parcels, emails: [] }))); };
  beforeEach(() => seed([parcel()]));

  it("ends with 外した荷物 › under キャンセルした荷物, and the link carries no number", async () => {
    const root = parseHtml(renderToStaticMarkup(await listTree()));
    const links = linksTo(root, "/app/excluded");
    expect(links).toHaveLength(1);
    expect(textOf(links[0])).toContain(EXCLUDED_PAGE_LABEL);
    expect(textOf(links[0])).toContain("›");
    expect(textOf(links[0])).not.toMatch(/\d|件/);
    const order = findAll(root, (n) => n.tag === "a" && ["/app/delivered", "/app/cancelled", "/app/excluded"].includes(n.attrs.href ?? "")).map((n) => n.attrs.href);
    expect(order).toEqual(["/app/delivered", "/app/cancelled", "/app/excluded"]);
  });

  it("the link is also on the empty list, and on a list that could not be read", async () => {
    seed([]);
    expect(linksTo(parseHtml(renderToStaticMarkup(await listTree())), "/app/excluded")).toHaveLength(1);
    const failing = new FakeDb({ parcels: [parcel()], emails: [] });
    failing.hooks.push((q) => (q.table === "parcels" ? { data: null, error: { message: "boom" }, count: null } : undefined));
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.state.client = withAuth(failing);
    expect(linksTo(parseHtml(renderToStaticMarkup(await listTree())), "/app/excluded")).toHaveLength(1);
  });

  it("turns ?excluded=<id> into the notice control, once, on the list, the empty list and the unreadable list", async () => {
    const branches: Array<[string, () => void]> = [
      ["list", () => seed([parcel()])],
      ["empty", () => seed([])],
      ["unreadable", () => {
        const failing = new FakeDb({ parcels: [], emails: [] });
        failing.hooks.push((q) => (q.table === "parcels" ? { data: null, error: { message: "boom" }, count: null } : undefined));
        mocks.state.client = withOwnMark(withAuth(failing));
      }],
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [name, arrange] of branches) {
      arrange();
      const found = elementsOf(await listTree(ID), ExcludedToast);
      expect(found.map((el) => el.props.id), name).toEqual([ID]);
    }
  });

  it.each([["not-a-uuid"], [""], ["10000000-0000-4000-8000-00000000000g"], [[ID, ID]], ["<script>"]])("no notice for %j (negative control)", async (value) => {
    expect(elementsOf(await listTree(value as string | string[]), ExcludedToast)).toHaveLength(0);
  });

  it("no notice, and no id drawn, without the query", async () => {
    expect(elementsOf(await listTree(), ExcludedToast)).toHaveLength(0);
    expect(renderToStaticMarkup(await listTree(ID))).not.toContain(ID);
  });
});

describe("外した荷物", () => {
  const row = (over: Record<string, unknown>) => ({
    parcel_id: `20000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    kind: "user", excluded_at: "2026-11-17T01:00:00Z", shop: "店", title: "題", status: "shipped", ordered_at: "2026-11-10",
    expected_date: null, total_amount: 1200, carrier: null, item_names: [], ...over,
  });
  const client = (result: { data: unknown; error: unknown }) => {
    const rpc = vi.fn(async () => result);
    mocks.state.client = { rpc };
    return rpc;
  };
  const render = async () => parseHtml(renderToStaticMarkup(await ExcludedPage()));

  it("asks the database function with the person's session and lists the rows in the order it gave (newest first)", async () => {
    const newer = row({ shop: "新しい店", item_names: ["りんご", "みかん"], excluded_at: "2026-11-17T02:00:00Z" });
    const older = row({ shop: "古い店", item_names: [], title: "題だけ", kind: "rule", status: "delivered" });
    const rpc = client({ data: [newer, older], error: null });
    const root = await render();
    expect(rpc).toHaveBeenCalledWith("excluded_parcels");
    const items = findAll(root, (n) => n.tag === "li");
    expect(items.map((n) => textOf(n))).toEqual([expect.stringContaining("新しい店"), expect.stringContaining("古い店")]);
    expect(textOf(items[0])).toContain("りんご、みかん");
    expect(textOf(items[1])).toContain("題だけ");
    expect(textOf(items[0])).toContain("¥1,200");
  });

  it("says who took each one out, by kind, and each row has 一覧に戻す", async () => {
    client({ data: [row({ kind: "user" }), row({ kind: "rule", status: "delivered" })], error: null });
    const items = findAll(await render(), (n) => n.tag === "li");
    expect(textOf(items[0])).toContain(EXCLUDED_BY_USER);
    expect(textOf(items[0])).not.toContain(EXCLUDED_BY_RULE);
    expect(textOf(items[1])).toContain(EXCLUDED_BY_RULE);
    expect(textOf(items[1])).not.toContain(EXCLUDED_BY_USER);
    for (const li of items) expect(buttonsNamed(li, RESTORE_BUTTON_LABEL)).toHaveLength(1);
  });

  it("a row is not a link to a parcel page", async () => {
    const r = row({});
    client({ data: [r], error: null });
    const root = await render();
    expect(findAll(root, (n) => n.tag === "a" && /\/app\/parcels\//.test(n.attrs.href ?? ""))).toHaveLength(0);
    expect(linksTo(root, "/app")).toHaveLength(1);
  });

  it("an empty answer says 外した荷物はありません; a failed one says it could not be read (not the empty sentence)", async () => {
    client({ data: [], error: null });
    expect(textOf(await render())).toContain(EXCLUDED_EMPTY);
    vi.spyOn(console, "error").mockImplementation(() => {});
    client({ data: null, error: { message: "boom" } });
    const failed = textOf(await render());
    expect(failed).toContain("読み込めませんでした");
    expect(failed).not.toContain(EXCLUDED_EMPTY);
  });
});

describe("the sentences", () => {
  it("each names who did what", () => {
    expect(EXCLUDED_TOAST).toBe("おとどけは、この荷物を一覧と支出から外しました");
    expect(RESTORED_TOAST).toBe("おとどけは、この荷物を一覧と支出に戻しました");
    expect(EXCLUDE_FAILED).toBe("おとどけは、この荷物を外せませんでした。もう一度お試しください");
    expect(RESTORE_FAILED).toBe("おとどけは、この荷物を一覧に戻せませんでした");
    expect(EXCLUDED_BY_USER).toBe("あなたが外しました");
    expect(EXCLUDED_BY_RULE).toBe("おとどけが自動で外しました");
    expect(EXCLUDE_BUTTON_LABEL).toBe("これは荷物ではありません");
  });

  it("taking out and putting back fail with different sentences", () => {
    expect(EXCLUDE_FAILED).not.toBe(RESTORE_FAILED);
    expect(EXCLUDE_FAILED).not.toContain(RESTORE_FAILED);
    expect(RESTORE_FAILED).not.toContain("外せません");
  });
});
