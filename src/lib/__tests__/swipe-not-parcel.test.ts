import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXCLUDE_BUTTON_LABEL, EXCLUDE_FAILED } from "@/lib/not-parcel-text";
import { fakeEvent, hostText, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * Swiping a list card to the right opens 「これは荷物ではありません」. Only its button takes the parcel out; moving
 * all the way does not. A manual parcel, a saving card and a move that starts at the screen's left edge
 * (the browser's 戻る) never open it. The left 「受け取った」 is covered by press-feedback / b2 / toast tests.
 */
const ctl = vi.hoisted(() => ({
  toast: vi.fn(),
  markDeliveredForUndo: vi.fn(),
  excludeParcel: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  search: "",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return { ...harnessHooks(actual), useTransition: () => [false, (fn: () => unknown) => void fn()], useContext: () => ctl.toast };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: ctl.replace, refresh: ctl.refresh }), useSearchParams: () => new URLSearchParams(ctl.search) }));
vi.mock("@/app/app/parcel-actions", () => ({
  markDeliveredForUndo: (...a: unknown[]) => ctl.markDeliveredForUndo(...a),
  restoreStatuses: vi.fn(),
  restoreExcluded: vi.fn(),
  excludeParcel: (...a: unknown[]) => ctl.excludeParcel(...a),
}));

const { SwipeToDeliver } = await import("@/app/app/delivered-controls");

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const card = createElement("a", { href: "/app/parcels/p1" }, "カード");
const setup = (canExclude?: boolean) => mount(() => SwipeToDeliver({ id: "p1", status: "shipped", children: card, canExclude }));
const surface = (view: Mounted) => view.host((h) => typeof h.props.onPointerDown === "function");
const fire = (view: Mounted, name: "onPointerDown" | "onPointerMove" | "onPointerUp", e: Record<string, number> = {}) =>
  (surface(view).props[name] as (e: unknown) => void)(e);
const translate = (view: Mounted) => (surface(view).props.style as { transform: string }).transform;
/** Moves from (x0, 100) by dx, as a finger would, and lets the state draw. */
async function drag(view: Mounted, x0: number, dx: number, release = true) {
  fire(view, "onPointerDown", { clientX: x0, clientY: 100 });
  fire(view, "onPointerMove", { clientX: x0 + dx, clientY: 100 });
  await flush();
  if (release) {
    fire(view, "onPointerUp");
    await flush();
  }
}
const faces = (view: Mounted) => view.hosts((h) => String(h.props.className ?? "").includes("bg-neutral-200"));
/** The grey face is drawn and not hidden. The same helper must fail for a card built without it (negative control). */
const faceShown = (view: Mounted) => faces(view).some((h) => !String(h.props.className).includes("invisible") && hostText(h).includes(EXCLUDE_BUTTON_LABEL));
const excludeButton = (view: Mounted): Host => view.host((h) => h.type === "button" && (hostText(h).includes(EXCLUDE_BUTTON_LABEL) || hostText(h).includes("外しています")));
const receivedFace = (view: Mounted) => view.host((h) => String(h.props.className ?? "").includes("bg-emerald-600"));

beforeEach(() => {
  ctl.search = "";
  for (const f of Object.values(ctl)) if (typeof f !== "string") f.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("swipe to the right: 外す", () => {
  it("opens a grey face with the label and stays open at 96px", async () => {
    const view = setup(true);
    expect(faceShown(view)).toBe(false);
    await drag(view, 100, 130);
    expect(faceShown(view)).toBe(true);
    expect(hostText(excludeButton(view))).toBe(EXCLUDE_BUTTON_LABEL);
    expect(translate(view)).toBe("translateX(96px)");
    expect(ctl.excludeParcel).not.toHaveBeenCalled();
  });

  it("negative control: the same check says no face for a card without canExclude", async () => {
    const view = setup(false);
    await drag(view, 100, 130);
    expect(faceShown(view)).toBe(false);
  });

  it("moving all the way (past 120px) does not take the parcel out", async () => {
    const view = setup(true);
    await drag(view, 100, 400);
    expect(ctl.excludeParcel).not.toHaveBeenCalled();
    expect(translate(view)).toBe("translateX(96px)");
    expect(ctl.replace).not.toHaveBeenCalled();
  });

  it("a short move closes again", async () => {
    const view = setup(true);
    await drag(view, 100, 30);
    expect(translate(view)).toBe("translateX(0px)");
    expect(faceShown(view)).toBe(false);
  });

  it("the button takes it out once (a second press is ignored) and moves to the list on success", async () => {
    let release!: (v: { ok: true }) => void;
    ctl.excludeParcel.mockImplementation(() => new Promise((r) => (release = r)));
    const view = setup(true);
    await drag(view, 100, 130);
    const press = () => (excludeButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    press();
    press();
    await flush();
    expect(ctl.excludeParcel).toHaveBeenCalledTimes(1);
    expect(ctl.excludeParcel).toHaveBeenCalledWith("p1");
    expect(excludeButton(view).props["aria-busy"]).toBe(true);
    release({ ok: true });
    await flush();
    expect(ctl.replace).toHaveBeenCalledWith("/app?excluded=p1");
  });

  it("keeps the other values of the query (?sample=1&demo=busy) and adds excluded=<id> after them", async () => {
    ctl.search = "sample=1&demo=busy";
    ctl.excludeParcel.mockResolvedValue({ ok: true });
    const view = setup(true);
    await drag(view, 100, 130);
    (excludeButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await flush();
    expect(ctl.replace).toHaveBeenCalledWith("/app?sample=1&demo=busy&excluded=p1");
    // negative control: the old form drops the query, so the check above would fail for it
    expect(`/app?excluded=${"p1"}`).not.toBe("/app?sample=1&demo=busy&excluded=p1");
  });

  it("a refusal says so under the card, keeps the card and does not move", async () => {
    // gone / manual / signed out all come back as ok:false; whatever words came, the page's words are shown.
    ctl.excludeParcel.mockResolvedValue({ ok: false, error: "別の文" });
    const view = setup(true);
    await drag(view, 100, 130);
    (excludeButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await flush();
    const alert = view.host((h) => h.props.role === "alert");
    expect(hostText(alert)).toBe(EXCLUDE_FAILED);
    expect(view.text()).toContain("カード");
    expect(ctl.replace).not.toHaveBeenCalled();
    expect(ctl.refresh).not.toHaveBeenCalled();
    // The face is closed and the press is released.
    expect(translate(view)).toBe("translateX(0px)");
    expect(faceShown(view)).toBe(false);
    // It can be tried again.
    await drag(view, 100, 130);
    (excludeButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await flush();
    expect(ctl.excludeParcel).toHaveBeenCalledTimes(2);
  });

  it("a thrown call is the same refusal", async () => {
    ctl.excludeParcel.mockRejectedValue(new Error("network"));
    const view = setup(true);
    await drag(view, 100, 130);
    (excludeButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await flush();
    expect(hostText(view.host((h) => h.props.role === "alert"))).toBe(EXCLUDE_FAILED);
  });

  it("a card that cannot be excluded (manual) does not move to the right and has no face", async () => {
    const view = setup(); // default: false
    await drag(view, 100, 200);
    expect(translate(view)).toBe("translateX(0px)");
    expect(faces(view)).toHaveLength(0);
  });

  it("a card being saved by 受け取った does not move to the right", async () => {
    ctl.markDeliveredForUndo.mockImplementation(() => new Promise(() => {}));
    const view = setup(true);
    await drag(view, 300, -150);
    expect(view.text()).toContain("保存しています…");
    await drag(view, 100, 200);
    expect(translate(view)).not.toBe("translateX(96px)");
    expect(Number(/translateX\((-?\d+)px\)/.exec(translate(view))![1])).toBeLessThan(0);
  });

  it("a card being taken out stays open and does not follow a new drag", async () => {
    ctl.excludeParcel.mockImplementation(() => new Promise(() => {}));
    const view = setup(true);
    await drag(view, 100, 130);
    (excludeButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await flush();
    await drag(view, 100, -200);
    expect(translate(view)).toBe("translateX(96px)");
    expect(ctl.markDeliveredForUndo).not.toHaveBeenCalled();
  });

  it("moving to the right never calls 受け取った and never shows its face", async () => {
    const view = setup(true);
    await drag(view, 100, 400);
    expect(ctl.markDeliveredForUndo).not.toHaveBeenCalled();
    expect(String(receivedFace(view).props.className)).toContain("invisible");
    expect(receivedFace(view).props["aria-hidden"]).toBe(true);
  });

  it("a move that starts at the left edge (clientX <= 24) is not taken, but 25 is", async () => {
    const edge = setup(true);
    await drag(edge, 24, 200);
    expect(translate(edge)).toBe("translateX(0px)");
    expect(faceShown(edge)).toBe(false);
    const near = setup(true);
    await drag(near, 25, 200);
    expect(translate(near)).toBe("translateX(96px)");
  });

  it("a move that goes mostly down is the page scrolling: nothing opens", async () => {
    const view = setup(true);
    fire(view, "onPointerDown", { clientX: 100, clientY: 100 });
    fire(view, "onPointerMove", { clientX: 130, clientY: 200 });
    await flush();
    fire(view, "onPointerUp");
    await flush();
    expect(translate(view)).toBe("translateX(0px)");
  });

  it("the left swipe is as before, from the edge too", async () => {
    ctl.markDeliveredForUndo.mockResolvedValue({ saved: 1, written: [] });
    const view = setup(true);
    await drag(view, 20, -150);
    expect(ctl.markDeliveredForUndo).toHaveBeenCalledWith(["p1"]);
    expect(String(receivedFace(view).props.className)).not.toContain("invisible");
  });

  it("the card itself keeps touch-pan-y (vertical scrolling is the browser's)", () => {
    expect(String(surface(setup(true)).props.className)).toContain("touch-pan-y");
  });
});

describe("pointercancel, the click on the card, and the two kinds of saving", () => {
  const cancel = (view: Mounted) => (surface(view).props.onPointerCancel as (e: unknown) => void)({});
  const clickCard = (view: Mounted) => {
    const e = fakeEvent();
    (surface(view).props.onClickCapture as (e: unknown) => void)(e);
    return e.defaultPrevented;
  };
  const left = (view: Mounted) => view.host((h) => h.type === "button" && hostText(h).includes("受け取った"));

  it("[1] letting go or cancelling (pointercancel) with the face open never takes the parcel out", async () => {
    const view = setup(true);
    await drag(view, 100, 300, false);
    cancel(view);
    await flush();
    expect(ctl.excludeParcel).not.toHaveBeenCalled();
    expect(translate(view)).toBe("translateX(96px)");
    // A cancel in the middle of a short move closes it, also without a call.
    const small = setup(true);
    await drag(small, 100, 30, false);
    cancel(small);
    await flush();
    expect(translate(small)).toBe("translateX(0px)");
    expect(ctl.excludeParcel).not.toHaveBeenCalled();
  });

  it("[2] a press on the card while the face is open does not open the link and closes the face", async () => {
    const view = setup(true);
    await drag(view, 100, 130);
    expect(translate(view)).toBe("translateX(96px)");
    expect(clickCard(view)).toBe(true);
    await flush();
    expect(translate(view)).toBe("translateX(0px)");
    expect(faceShown(view)).toBe(false);
    expect(ctl.excludeParcel).not.toHaveBeenCalled();
    // Closed: a plain click goes through to the link.
    expect(clickCard(view)).toBe(false);
  });

  it("[3] while taking out, 受け取った does not start", async () => {
    ctl.excludeParcel.mockImplementation(() => new Promise(() => {}));
    const view = setup(true);
    await drag(view, 100, 130);
    (excludeButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await flush();
    (left(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await flush();
    expect(ctl.markDeliveredForUndo).not.toHaveBeenCalled();
    expect(translate(view)).toBe("translateX(96px)");
  });

  it("[3] while 受け取った is saving, the right face's button does nothing", async () => {
    ctl.markDeliveredForUndo.mockImplementation(() => new Promise(() => {}));
    const view = setup(true);
    await drag(view, 300, -150);
    expect(view.text()).toContain("保存しています…");
    (excludeButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await flush();
    expect(ctl.excludeParcel).not.toHaveBeenCalled();
    expect(faceShown(view)).toBe(false);
  });

  it("[4] after a refusal 受け取った works again (the shared saving is released)", async () => {
    ctl.excludeParcel.mockResolvedValue({ ok: false, error: "x" });
    ctl.markDeliveredForUndo.mockResolvedValue({ saved: 1, written: [] });
    const view = setup(true);
    await drag(view, 100, 130);
    (excludeButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await flush();
    (left(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await flush();
    expect(ctl.markDeliveredForUndo).toHaveBeenCalledWith(["p1"]);
  });
});

describe("[5] the card is gone from the list once it is taken out", () => {
  it("waits for the list drawn again from the server's rows, after replace and refresh", async () => {
    const rows = new Set(["p1"]);
    const redraw = { current: () => {} };
    ctl.excludeParcel.mockImplementation(async (id: string) => {
      rows.delete(id); // the database function ran; the page still shows the old rows until it is asked again
      return { ok: true };
    });
    // Both a navigation and a refresh make the server send the rows again.
    ctl.replace.mockImplementation(() => redraw.current());
    ctl.refresh.mockImplementation(() => redraw.current());
    const view = mount(() => (rows.has("p1") ? SwipeToDeliver({ id: "p1", status: "shipped", children: card, canExclude: true }) : createElement("p", null, "荷物はありません")));
    redraw.current = () => view.rerender();
    await drag(view, 100, 130);
    expect(view.text()).toContain("カード");
    (excludeButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    await vi.waitFor(() => expect(view.text()).toContain("荷物はありません"));
    expect(view.text()).not.toContain("カード");
    expect(ctl.replace).toHaveBeenCalledWith("/app?excluded=p1");
    expect(ctl.refresh).toHaveBeenCalledTimes(1);
    expect(ctl.replace.mock.invocationCallOrder[0]).toBeLessThan(ctl.refresh.mock.invocationCallOrder[0]);
  });
});

describe("page.tsx hands canExclude to every swipe card", () => {
  const src = readFileSync(path.join(process.cwd(), "src/app/app/page.tsx"), "utf8");
  const calls = (text: string) => [...text.matchAll(/<SwipeToDeliver\b[^>]*>/g)].map((m) => m[0]);
  const allGuarded = (text: string) => calls(text).length >= 2 && calls(text).every((c) => /canExclude=\{\w+\.source !== "manual"\}/.test(c));

  it("every <SwipeToDeliver> passes canExclude from source !== manual", () => {
    expect(allGuarded(src)).toBe(true);
  });
  it("negative control: the check fails once one is taken off", () => {
    expect(allGuarded(src.replace(' canExclude={p.source !== "manual"}', ""))).toBe(false);
    expect(allGuarded(src.replace(/canExclude=\{parcel\.source !== "manual"\}/, 'canExclude'))).toBe(false);
  });
});
