import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import { NO_BODY_TEXT, NO_SUBJECT_TEXT } from "@/lib/mail-notices";
import { fakeEvent, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * Opening the key again in a tab (src/app/app/unlock-form.tsx), and a sealed mail on the parcel
 * page (src/app/app/parcels/[id]/sealed-mail.tsx): the password with the session's address, the
 * press shown at once; mail sealed to an earlier key is said to be closed, with nothing to open it.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const EMAIL = "qa@example.com";
const KEY = { keyId: "a".repeat(32), publicKey: new Uint8Array(65), privateKey: {} as CryptoKey };

const mocks = vi.hoisted(() => ({ open: vi.fn(), readSealedMail: vi.fn(), openMail: vi.fn(), key: null as unknown }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});
vi.mock("@/lib/crypto/password-flows", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/crypto/password-flows")>()), openKeyAgain: mocks.open }));
vi.mock("@/lib/crypto/envelope", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/crypto/envelope")>()), openMail: mocks.openMail }));
vi.mock("@/lib/crypto/tab-key", () => ({ useTabKey: () => mocks.key }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: vi.fn(), readSealedMail: mocks.readSealedMail }));

const { UnlockForm } = await import("@/app/app/unlock-form");
const { SealedMail } = await import("@/app/app/parcels/[id]/sealed-mail");

const textOfHost = (h: Host | string): string => (typeof h === "string" ? h : h.children.map(textOfHost).join(""));
const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

async function unlockForm() {
  const view = mount(() => UnlockForm({ userId: USER, email: EMAIL }));
  (view.host((h) => h.type === "input" && h.props.type === "password").props.onChange as (e: unknown) => void)({ target: { value: "うちの猫は三毛で7歳" } });
  await drawn();
  return view;
}
const press = (view: Mounted) => (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());

beforeEach(() => {
  mocks.open.mockReset();
  mocks.readSealedMail.mockReset();
  mocks.openMail.mockReset();
  mocks.key = null;
});

describe("opening the key again", () => {
  it("spins with 「開いています…」 at once, and opens with the session's address and the password", async () => {
    let answer!: (v: unknown) => void;
    mocks.open.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await unlockForm();
    const done = press(view);
    await drawn();
    expect(textOfHost(view.host((h) => h.type === "button"))).toBe("開いています…");
    expect(mocks.open.mock.calls[0][0]).toEqual({ email: EMAIL, password: "うちの猫は三毛で7歳", userId: USER });
    answer({ ok: true });
    await done;
    await drawn();
    expect(view.host((h) => h.type === "input" && h.props.type === "password").props.value).toBe("");
    expect(textOfHost(view.host((h) => h.type === "button"))).toBe("開く");
  });

  it.each(["wrong_password", "no_key", "network", "signed_out"] as const)("%s is told with its fixed words", async (code) => {
    mocks.open.mockResolvedValue({ ok: false, code });
    const view = await unlockForm();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES[code]);
  });

  it("names the session's address for a password manager, in a field without a name", async () => {
    const view = await unlockForm();
    const username = view.host((h) => h.type === "input" && h.props.autoComplete === "username");
    expect(username.props).toMatchObject({ value: EMAIL, readOnly: true, hidden: true });
    expect(view.hosts((h) => "name" in h.props)).toEqual([]);
  });
});

describe("a sealed mail", () => {
  const sealed = () => mount(() => SealedMail({ userId: USER, email: EMAIL, emailId: "e1", fromDomain: "shop.example.test", notes: null, confidence: null }));
  const envelope = (kid: string) => ({ v: 1, alg: "P256-HKDF-SHA256-A256GCM", kid, epk: "AA==", iv: "AAAAAAAAAAAAAAAA", ct: "AAAAAAAAAAAAAAAAAAAAAA==" });

  it("sealed to an earlier key: says it does not open, and offers nothing to open it with", async () => {
    mocks.key = KEY;
    mocks.readSealedMail.mockResolvedValue({ ok: true, envelope: envelope("b".repeat(32)) });
    const view = sealed();
    await vi.waitFor(() => expect(view.text()).toContain("前の鍵で暗号化したメールです。開けません。"));
    expect(view.hosts((h) => h.type === "input" || h.type === "form")).toEqual([]);
    expect(view.text()).not.toContain("合言葉");
  });

  it("without the key open in this tab: asks for the password", async () => {
    // The form inside has hooks of its own: drawn as the server draws it.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const html = renderToStaticMarkup(createElement(SealedMail, { userId: USER, email: EMAIL, emailId: "e1", fromDomain: "shop.example.test", notes: null, confidence: null }));
    expect(html).toContain("パスワードで開きます。このタブを閉じるまで覚えます。");
    expect(html).toContain('type="password"');
    expect(mocks.readSealedMail).not.toHaveBeenCalled();
  });

  it("an opened mail with no body says NO_BODY_TEXT, and one with a body shows the body", async () => {
    mocks.key = KEY;
    mocks.readSealedMail.mockResolvedValue({ ok: true, envelope: envelope(KEY.keyId) });
    mocks.openMail.mockResolvedValue({ subject: "件名", from_name: null, from_address: "shop@example.test", text: "  ", html: null });
    const empty = sealed();
    await vi.waitFor(() => expect(empty.hosts((h) => h.type === "pre")).toHaveLength(1));
    expect(textOfHost(empty.host((h) => h.type === "pre"))).toBe(NO_BODY_TEXT);
    mocks.openMail.mockResolvedValue({ subject: "件名", from_name: null, from_address: "shop@example.test", text: "ご注文ありがとう", html: null });
    const full = sealed();
    await vi.waitFor(() => expect(full.hosts((h) => h.type === "pre")).toHaveLength(1));
    expect(textOfHost(full.host((h) => h.type === "pre"))).toBe("ご注文ありがとう");
  });

  it("an opened mail with a blank or empty subject says NO_SUBJECT_TEXT in pale type; a real subject is shown as it is", async () => {
    mocks.key = KEY;
    mocks.readSealedMail.mockResolvedValue({ ok: true, envelope: envelope(KEY.keyId) });
    const subjectLine = (view: Mounted) => view.host((h) => h.type === "p" && String(h.props.className).includes("leading-snug"));
    for (const subject of ["", "  \u3000 "]) {
      mocks.openMail.mockResolvedValue({ subject, from_name: null, from_address: "shop@example.test", text: "本文", html: null });
      const view = sealed();
      await vi.waitFor(() => expect(view.hosts((h) => h.type === "pre")).toHaveLength(1));
      expect(textOfHost(subjectLine(view))).toBe(NO_SUBJECT_TEXT);
      expect(String(subjectLine(view).props.className)).toContain("text-neutral-500");
    }
    mocks.openMail.mockResolvedValue({ subject: "発送のお知らせ", from_name: null, from_address: "shop@example.test", text: "本文", html: null });
    const real = sealed();
    await vi.waitFor(() => expect(real.hosts((h) => h.type === "pre")).toHaveLength(1));
    expect(textOfHost(subjectLine(real))).toBe("発送のお知らせ");
    expect(String(subjectLine(real).props.className)).not.toContain("text-neutral");
  });

  it("an opened mail whose subject is null, or only invisible characters, says NO_SUBJECT_TEXT", async () => {
    mocks.key = KEY;
    mocks.readSealedMail.mockResolvedValue({ ok: true, envelope: envelope(KEY.keyId) });
    const subjectLine = (view: Mounted) => view.host((h) => h.type === "p" && String(h.props.className).includes("leading-snug"));
    for (const subject of [null, "\u200b", "\u200b \ufeff\u200e"]) {
      mocks.openMail.mockResolvedValue({ subject, from_name: null, from_address: "shop@example.test", text: "本文", html: null });
      const view = sealed();
      await vi.waitFor(() => expect(view.hosts((h) => h.type === "pre")).toHaveLength(1));
      expect(textOfHost(subjectLine(view))).toBe(NO_SUBJECT_TEXT);
      expect(String(subjectLine(view).props.className)).toContain("text-neutral-500");
    }
  });

  it("before it is opened (no key in this tab, or still opening) it never says it has no subject", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    expect(renderToStaticMarkup(createElement(SealedMail, { userId: USER, email: EMAIL, emailId: "e1", fromDomain: "shop.example.test", notes: null, confidence: null }))).not.toContain(NO_SUBJECT_TEXT);
    mocks.key = KEY;
    mocks.readSealedMail.mockReturnValue(new Promise(() => {}));
    expect(sealed().text()).not.toContain(NO_SUBJECT_TEXT);
  });

  it("a read that fails is told as such, never as an earlier key", async () => {
    mocks.key = KEY;
    mocks.readSealedMail.mockResolvedValue({ ok: false, error: "network" });
    const view = sealed();
    await vi.waitFor(() => expect(view.text()).toContain("開けませんでした"));
    expect(view.text()).not.toContain("前の鍵");
  });
});
