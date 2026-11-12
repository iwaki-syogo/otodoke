// The delete forms and their Server Actions, joined: the real form is rendered, the FormData is
// built the way a browser builds it (a hidden input always; a checkbox only when ticked, with the
// value "on" when it has none), and that goes to the real action. A test that hands the action a
// made-up { confirm: "yes" } does not see the checkbox's value; this one does.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, type HtmlNode } from "./html-tree";

const USER = { id: "00000000-0000-4000-8000-00000000000a", email: "qa@example.test" };
const MANUAL_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return { RedirectSignal, state: { db: null as unknown } };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.RedirectSignal(url);
  },
  notFound: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: USER }, error: null }) } }),
  getUser: async () => USER,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.state.db }));

const { ManualForm } = await import("@/app/app/parcels/manual-form");
const { deleteManualParcel } = await import("@/app/app/parcels/manual-actions");
const { DemoLoader } = await import("@/app/app/settings/demo-loader");
const { clearAllParcels } = await import("@/app/app/settings/actions");

/** What a browser sends for a form: every named input, a checkbox only when ticked (value "on" when it has none). */
function browserFormData(form: HtmlNode, tick: boolean): FormData {
  const fd = new FormData();
  for (const input of findAll(form, (n) => n.tag === "input" && !!n.attrs.name)) {
    const type = input.attrs.type ?? "text";
    if (type === "checkbox" || type === "radio") {
      if (tick || "checked" in input.attrs) fd.append(input.attrs.name, "value" in input.attrs ? input.attrs.value : "on");
    } else fd.append(input.attrs.name, input.attrs.value ?? "");
  }
  return fd;
}

const formWithConfirm = (root: HtmlNode) => {
  const forms = findAll(root, (n) => n.tag === "form" && findAll(n, (i) => i.tag === "input" && i.attrs.name === "confirm").length > 0);
  expect(forms).toHaveLength(1);
  return forms[0];
};

async function outcome(p: Promise<unknown>) {
  try {
    return { state: await p, redirectedTo: null as string | null };
  } catch (err) {
    if (err instanceof mocks.RedirectSignal) return { state: undefined, redirectedTo: err.url };
    throw err;
  }
}

const typedIn = { id: MANUAL_ID, user_id: USER.id, source: "manual", title: "品名", shop: "店", shop_key: "other", ordered_at: "2026-11-01", expected_date: null, total_amount: 2480, category: null, category_source: null, tracking_number: null, carrier: null, requires_presence: null, status: "ordered" };

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: [{ ...typedIn }], emails: [{ id: "e1", user_id: USER.id }] });
  mocks.state.db = db;
});

describe("the delete form of a typed-in parcel, as the browser sends it", () => {
  const manualForm = () => parseHtml(renderToStaticMarkup(createElement(ManualForm, { parcel: typedIn as never, today: "2026-11-07" })));

  it("ticked: the action deletes and goes to /app", async () => {
    const fd = browserFormData(formWithConfirm(manualForm()), true);
    expect([...fd.entries()]).toContainEqual(["confirm", "yes"]);
    const r = await outcome(deleteManualParcel({ error: null, values: {} }, fd));
    expect(r.redirectedTo).toBe("/app");
    expect(db.find("parcels", MANUAL_ID)).toBeUndefined();
  });

  it("not ticked: refused, no delete query runs, the parcel stays", async () => {
    const fd = browserFormData(formWithConfirm(manualForm()), false);
    const r = await outcome(deleteManualParcel({ error: null, values: {} }, fd));
    expect(r.redirectedTo).toBeNull();
    expect(db.callsOn("parcels", "delete")).toHaveLength(0);
    expect((r.state as { error: string }).error).toBe("「本当に消す」にチェックを入れてください");
    expect(db.find("parcels", MANUAL_ID)).toBeDefined();
  });
});

describe("the clear-all form, as the browser sends it", () => {
  const demoLoader = () => parseHtml(renderToStaticMarkup(createElement(DemoLoader, { userId: USER.id, loaded: null, error: null, cleared: false })));

  it("ticked: clears and goes back with cleared=1", async () => {
    const fd = browserFormData(formWithConfirm(demoLoader()), true);
    expect([...fd.entries()]).toContainEqual(["confirm", "yes"]);
    const r = await outcome(clearAllParcels(fd));
    expect(r.redirectedTo).toBe("/app/settings/demo?cleared=1");
    expect(db.find("parcels", MANUAL_ID)).toBeUndefined();
  });

  it("not ticked: refused with clear_confirm, no delete query runs", async () => {
    const fd = browserFormData(formWithConfirm(demoLoader()), false);
    const r = await outcome(clearAllParcels(fd));
    expect(r.redirectedTo).toBe("/app/settings/demo?error=clear_confirm");
    expect(db.callsOn("parcels", "delete")).toHaveLength(0);
    expect(db.callsOn("emails", "delete")).toHaveLength(0);
    expect(db.find("parcels", MANUAL_ID)).toBeDefined();
  });
});
