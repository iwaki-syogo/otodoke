import { Children, createElement, isValidElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualFormState } from "@/lib/manual-parcel";
import { mount, type Mounted } from "./hook-harness";

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER_USER = "00000000-0000-4000-8000-00000000000b";
const INTENT = "11111111-1111-4111-8111-111111111111";
const NEXT_INTENT = "22222222-2222-4222-8222-222222222222";
const mocks = vi.hoisted(() => ({ create: vi.fn(), userId: "00000000-0000-4000-8000-00000000000a" }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  const hooks = harnessHooks(actual);
  return {
    ...hooks,
    // Keep the action's returned state across renders; the production action is tested separately.
    useActionState: (action: (state: ManualFormState, data: FormData) => Promise<ManualFormState>, initial: ManualFormState) => {
      const [state, setState] = hooks.useState(initial);
      return [state, async (data: FormData) => { setState(await action(state, data)); }, false];
    },
    useId: () => "manual-warning",
  };
});
vi.mock("@/app/app/parcels/manual-actions", () => ({
  createManualParcel: mocks.create, updateManualParcel: vi.fn(), deleteManualParcel: vi.fn(),
}));
vi.mock("@/components/pending-button", async () => {
  const { createElement: h } = await import("react");
  return { SubmitButton: ({ children }: { children: string }) => h("button", { type: "submit" }, children) };
});
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => ({ id: mocks.userId }) }));

const { ManualForm } = await import("@/app/app/parcels/manual-form");
const NewParcelPage = (await import("@/app/app/parcels/new/page")).default;
type Props = ComponentProps<typeof ManualForm>;

const intent = (view: Mounted) => view.host((h) => h.type === "input" && h.props.name === "intentId").props.value;

async function submit(view: Mounted, title: string) {
  const action = view.host((h) => h.type === "form").props.action;
  if (typeof action !== "function") throw new Error("manual form must carry its action");
  const data = new FormData();
  data.set("title", title);
  data.set("intentId", String(intent(view)));
  await action(data);
  await Promise.resolve();
}

async function pageForm(): Promise<ReactElement<Props>> {
  const page = await NewParcelPage();
  const forms: Array<ReactElement<Props>> = [];
  Children.forEach(page.props.children, (node) => {
    if (isValidElement<Props>(node) && node.type === ManualForm) forms.push(node);
  });
  if (forms.length !== 1) throw new Error("new page must render one manual form");
  return forms[0];
}

beforeEach(() => {
  mocks.userId = USER;
  mocks.create.mockReset().mockImplementation(async (_state: ManualFormState, data: FormData) => ({
    error: "保存できませんでした", values: { title: String(data.get("title")), intentId: String(data.get("intentId")) },
  }));
});

describe("manual creation intent lifetime", () => {
  it("includes the server intent in the initial server-rendered hidden field", () => {
    const html = renderToStaticMarkup(createElement(ManualForm, {
      parcel: null, today: "2026-11-12", userId: USER, intentId: INTENT,
    }));
    expect(html).toContain(`name="intentId" value="${INTENT}"`);
    expect(html).toContain(`name="expectedUserId" value="${USER}"`);
  });

  it("keeps the original hidden intent across failure state, field redraw, and fresh same-user page props", async () => {
    let props: Props = { parcel: null, today: "2026-11-12", userId: USER, intentId: INTENT };
    const mounted = mount(() => ManualForm(props));
    expect(intent(mounted)).toBe(INTENT);
    await submit(mounted, "応答を失った品名");
    expect(mounted.text()).toContain("保存できませんでした");
    expect(mounted.host((h) => h.type === "input" && h.props.name === "title").props.defaultValue).toBe("応答を失った品名");
    expect(intent(mounted)).toBe(INTENT);

    // revalidatePath may deliver a new page UUID; it must not replace this form's old one.
    props = { ...props, today: "2026-11-13", intentId: NEXT_INTENT };
    mounted.rerender();
    expect(intent(mounted)).toBe(INTENT);
    await submit(mounted, "入力を直しても同じフォーム");
    expect(intent(mounted)).toBe(INTENT);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    for (const call of mocks.create.mock.calls) {
      const data = call[1];
      if (!(data instanceof FormData)) throw new Error("form action must receive FormData");
      expect(data.get("intentId")).toBe(INTENT);
    }
    mounted.unmount();
  });

  it("keeps each separately mounted form's own server intent", () => {
    const first = mount(() => ManualForm({ parcel: null, today: "2026-11-12", userId: USER, intentId: INTENT }));
    const second = mount(() => ManualForm({ parcel: null, today: "2026-11-12", userId: USER, intentId: NEXT_INTENT }));
    expect(intent(first)).toBe(INTENT);
    expect(intent(second)).toBe(NEXT_INTENT);
    first.unmount(); second.unmount();
  });

  it("creates a fresh UUID per server page while keying the mounted form only by its owner", async () => {
    const first = await pageForm();
    const sameOwner = await pageForm();
    expect(first.props.intentId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
    expect(first.props.intentId).not.toBe(sameOwner.props.intentId);
    expect(first.key).toBe(USER);
    expect(sameOwner.key).toBe(USER);
    expect(first.props.userId).toBe(USER);

    mocks.userId = OTHER_USER;
    const otherOwner = await pageForm();
    expect(otherOwner.key).toBe(OTHER_USER);
    expect(otherOwner.key).not.toBe(first.key);
    expect(otherOwner.props.intentId).not.toBe(first.props.intentId);
  });
});
