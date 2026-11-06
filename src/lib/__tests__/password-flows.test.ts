import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64, utf8 } from "@/lib/crypto/bytes";
import { openMail, sealMail, type PrivateRecipient } from "@/lib/crypto/envelope";
import { KEY_IN_USE_CHANGED, KEY_WRAP_CHANGED } from "@/lib/crypto/key-messages";
import { createWrappedKey, type StoredKey } from "@/lib/crypto/key-wrap";
import { KEY_SESSION_STALE, LOGIN_MESSAGES, keyStepCode } from "@/lib/login-errors";
import { normalizeLoginAddress } from "@/lib/login-form";
import { activateKey, readStoredKey, registerKey, rewrapKey } from "@/lib/mail-keys";
import { FakeDb } from "./fake-db";
import { asAdmin } from "./pipeline-fixtures";

/**
 * The key steps of password-v1 in the browser (src/lib/crypto/password-flows.ts), with Node's
 * WebCrypto and stand-ins for the Server Actions: the key Actions run the real server steps of
 * src/lib/mail-keys.ts on the fake database; Supabase Auth is a map of address -> login secret.
 *
 * master is made with 1,000 PBKDF2 rounds here (the same construction otherwise): these tests are
 * about the order of the steps. One test makes it with the real 600,000 against the test vectors
 * (fixtures/crypto/password-v1.json), the contract shared with the iOS app.
 */

const derive = vi.hoisted(() => ({ real: false, calls: [] as Array<{ email: string; password: string }> }));
vi.mock("@/lib/crypto/password-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/password-v1")>();
  return {
    ...actual,
    deriveMaster: async (email: string, password: string) => {
      derive.calls.push({ email, password });
      if (derive.real) return actual.deriveMaster(email, password);
      const base = await crypto.subtle.importKey("raw", utf8(actual.normalizePassword(password)), "PBKDF2", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: utf8(`otodoke/pw/v1|${actual.emailNorm(email)}`), iterations: 1000 }, base, 256);
      return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits", "deriveKey"]);
    },
  };
});
const tab = vi.hoisted(() => ({ setTabKey: vi.fn(), forgetTabKey: vi.fn() }));
vi.mock("@/lib/crypto/tab-key", () => tab);

const { changePassword, finishPasswordReset, flowMessage, keyActionCode, openKeyAgain, signInAndOpenKey } = await import("@/lib/crypto/password-flows");

const USER = "00000000-0000-4000-8000-00000000000a";
const EMAIL = "someone@example.test";
const PASSWORD = "うちの猫は三毛で7歳";
const NEW_PASSWORD = "correct horse battery 2026";
const SIGNED_OUT = "ログインし直してください";

/** The server side, as the Actions behave (src/app/**\/actions.ts, src/lib/login-auth.ts, src/lib/mail-keys.ts). */
class Server {
  db = new FakeDb();
  /** Supabase Auth: the account's address as kept, and its login secret. */
  account = { userId: USER, email: EMAIL, secret: "" };
  signedIn = false;
  /** Every Action call, in order. */
  log: string[] = [];
  /** Answers to put in front of the real step, once each. */
  before: Partial<Record<string, () => Promise<unknown> | unknown>> = {};

  private async step<T>(name: string, run: () => Promise<T>): Promise<T> {
    this.log.push(name);
    const hook = this.before[name];
    if (hook) {
      delete this.before[name];
      const answer = await hook();
      if (answer !== undefined) return answer as T;
    }
    return run();
  }

  signInWithAuthSecret = vi.fn((input: { email: string; authSecret: string; captchaToken?: string | null }) =>
    this.step("signIn", async () => {
      if (normalizeLoginAddress(input.email) !== normalizeLoginAddress(this.account.email) || input.authSecret !== this.account.secret) return { ok: false as const, code: "credentials" as const };
      this.signedIn = true;
      return { ok: true as const, userId: USER };
    }),
  );
  readSignedInAddress = vi.fn(() => this.step("readSignedInAddress", async () => (this.signedIn ? { ok: true as const, userId: USER, email: this.account.email } : { ok: false as const })));
  readMailKey = vi.fn((input: { keyId: string | null }) =>
    this.step(input.keyId ? "readMailKey(id)" : "readMailKey(in use)", async () => (this.signedIn ? readStoredKey(asAdmin(this.db), USER, input) : { ok: false as const, error: SIGNED_OUT })),
  );
  registerMailKey = vi.fn((input: unknown) => this.step("registerMailKey", () => registerKey(asAdmin(this.db), USER, input)));
  activateMailKey = vi.fn((input: unknown) => this.step("activateMailKey", () => activateKey(asAdmin(this.db), USER, input)));
  rewrapMailKey = vi.fn((input: unknown) => this.step("rewrapMailKey", async () => (this.signedIn ? rewrapKey(asAdmin(this.db), USER, input) : { ok: false as const, error: SIGNED_OUT })));
  finishReset = vi.fn((input: { authSecret: string; keyId: string; challenge: string; expectedCurrentKeyId: string | null }) =>
    this.step("finishReset", async () => {
      this.account.secret = input.authSecret;
      const done = await activateKey(asAdmin(this.db), USER, { keyId: input.keyId, challenge: input.challenge, expectedCurrentKeyId: input.expectedCurrentKeyId });
      return done.ok ? { ok: true as const, keyId: done.keyId } : { ok: false as const, code: keyStepCode(done.error) };
    }),
  );
  changeLoginSecret = vi.fn((input: { currentAuthSecret: string; newAuthSecret: string; rewrap: { keyId: string; previousWrappedPrivateKey: string; wrappedPrivateKey: string; wrapIv: string; kdfSalt: string; kdfIterations: number } | null }) =>
    this.step("changeLoginSecret", async () => {
      if (input.currentAuthSecret === input.newAuthSecret) return { ok: false as const, code: "same_secret" as const };
      if (input.currentAuthSecret !== this.account.secret) return { ok: false as const, code: "credentials" as const };
      if (input.rewrap) {
        const done = await rewrapKey(asAdmin(this.db), USER, input.rewrap);
        if (!done.ok) return { ok: false as const, code: keyStepCode(done.error) };
      }
      this.account.secret = input.newAuthSecret;
      return { ok: true as const };
    }),
  );

  inUse = () => this.db.rows("user_keys").filter((k) => k.user_id === USER && k.activated_at && !k.retired_at);
}

let server: Server;
beforeEach(() => {
  server = new Server();
  derive.real = false;
  derive.calls = [];
  tab.setTabKey.mockReset();
  tab.forgetTabKey.mockReset();
});

/** The login secret the browser makes for a password (the account is made with it, as sign-up does). */
async function secretFor(password: string, email = EMAIL): Promise<string> {
  const { authSecretHex, deriveMaster } = await import("@/lib/crypto/password-v1");
  return authSecretHex(await deriveMaster(email, password));
}

async function signUp(password = PASSWORD) {
  server.account.secret = await secretFor(password);
  derive.calls = [];
}

const login = (password = PASSWORD, email = EMAIL) => signInAndOpenKey({ email, password }, server);

/** The key the tab was given last. */
const tabKey = (): PrivateRecipient => tab.setTabKey.mock.calls.at(-1)![1] as PrivateRecipient;

/** A mail sealed to the key in use opens with `key`: the key the tab holds is the one in use. */
async function opensMailOfKeyInUse(key: PrivateRecipient) {
  const row = server.inUse()[0];
  const sealed = await sealMail({ keyId: String(row.key_id), publicKey: Uint8Array.from(Buffer.from(String(row.public_key), "base64")) }, USER, "mail-1", { subject: "発送のお知らせ", from_name: null, from_address: "shop@example.test", text: "本文", html: null });
  return (await openMail(key, USER, "mail-1", sealed)).subject === "発送のお知らせ";
}

describe("signing in: the first sign-in makes the key", () => {
  it("signs in with the login secret, finds no key, checks the address, then registers, reads back, and activates", async () => {
    await signUp();
    const result = await login();
    expect(result).toEqual({ ok: true, userId: USER, key: "made" });
    expect(server.log).toEqual(["signIn", "readMailKey(in use)", "readSignedInAddress", "registerMailKey", "readMailKey(id)", "activateMailKey"]);
    expect(server.inUse()).toHaveLength(1);
    expect(tab.forgetTabKey).toHaveBeenCalledTimes(1);
    expect(tab.setTabKey).toHaveBeenCalledTimes(1);
    expect(tab.setTabKey.mock.calls[0][0]).toBe(USER);
    expect(await opensMailOfKeyInUse(tabKey())).toBe(true);
    // One master for the whole sign-in, made from the address as typed.
    expect(derive.calls).toEqual([{ email: EMAIL, password: PASSWORD }]);
  });

  it("never sends the password: the sign-in carries a 64-hex login secret, and no Action input holds the password", async () => {
    await signUp();
    await login();
    const sent = server.signInWithAuthSecret.mock.calls[0][0];
    expect(sent.authSecret).toMatch(/^[0-9a-f]{64}$/);
    const everything = JSON.stringify([
      ...server.signInWithAuthSecret.mock.calls,
      ...server.readMailKey.mock.calls,
      ...server.registerMailKey.mock.calls,
      ...server.activateMailKey.mock.calls,
    ]);
    expect(everything).not.toContain(PASSWORD);
    // The stored wrap is password-v1's: its kdf_salt is the HKDF salt (16 bytes), 600,000 recorded.
    const row = server.inUse()[0];
    expect(Buffer.from(String(row.kdf_salt), "base64")).toHaveLength(16);
    expect(row.kdf_iterations).toBe(600_000);
  });

  it("a sign-in Supabase refuses makes no master-based step and keeps the tab without a key", async () => {
    await signUp();
    expect(await login("ちがうパスワードですよ")).toEqual({ ok: false, code: "credentials" });
    expect(server.log).toEqual(["signIn"]);
    expect(tab.setTabKey).not.toHaveBeenCalled();
    expect(server.db.rows("user_keys")).toHaveLength(0);
  });
});

describe("signing in: a key in use", () => {
  it("opens it in a later sign-in (a new tab): the same key, nothing registered", async () => {
    await signUp();
    await login();
    const keyId = server.inUse()[0].key_id;
    server.log = [];
    tab.setTabKey.mockReset();
    expect(await login()).toEqual({ ok: true, userId: USER, key: "opened" });
    expect(server.log).toEqual(["signIn", "readMailKey(in use)"]);
    expect(tabKey().keyId).toBe(keyId);
    expect(tabKey().privateKey.extractable).toBe(false);
    expect(await opensMailOfKeyInUse(tabKey())).toBe(true);
  });

  it("a key that another KEK wrapped (a passphrase row) does not open: signed in, told so, nothing made", async () => {
    await signUp();
    server.signedIn = true;
    // A row wrapped with a KEK that is not this password's (the passphrase's, before password-v1).
    const other = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    const made = await createWrappedKey(other, salt, USER);
    server.db.rows("user_keys").push({ user_id: USER, key_id: made.keyId, public_key: toBase64(made.publicKey), ...made.wrapped, activated_at: "2026-11-06T00:00:00Z", retired_at: null });
    server.signedIn = false;

    expect(await login()).toEqual({ ok: true, userId: USER, key: "not_opened", openWithAnother: expect.any(Function) });
    expect(tab.setTabKey).not.toHaveBeenCalled();
    expect(server.log).not.toContain("registerMailKey");
    expect(server.inUse().map((k) => k.key_id)).toEqual([made.keyId]);
  });
});

describe("signing in: the key opens with another password (a change that stopped half-way)", () => {
  /**
   * The state R3-PW-1 found: a change whose wrap was stored, whose new secret Supabase refused, and
   * whose wrap could not be put back (secret_change_refused_key_new). The login is PASSWORD; the
   * key opens with NEW_PASSWORD.
   */
  async function halfChanged() {
    await signUp();
    await login();
    server.before.changeLoginSecret = async () => {
      await rewrapKey(asAdmin(server.db), USER, server.changeLoginSecret.mock.calls.at(-1)![0].rewrap!);
      return { ok: false, code: "secret_change_refused_key_new" };
    };
    expect(await changePassword({ email: EMAIL, userId: USER, current: PASSWORD, next: NEW_PASSWORD }, server)).toEqual({ ok: false, code: "secret_change_refused_key_new" });
    server.signedIn = false;
    tab.setTabKey.mockReset();
    tab.forgetTabKey.mockReset();
  }

  /** A sign-in with PASSWORD whose key did not open, and what it offers. */
  async function notOpened(email = EMAIL) {
    const signedIn = await login(PASSWORD, email);
    if (!signedIn.ok || signedIn.key !== "not_opened") throw new Error(`not_opened expected, got ${JSON.stringify(signedIn)}`);
    server.log = [];
    derive.calls = [];
    return signedIn.openWithAnother;
  }

  it("the old password signs in; the new one opens the key, wrapped again for the old one; the next sign-in opens it", async () => {
    await halfChanged();
    const keyId = String(server.inUse()[0].key_id);
    const before = String(server.inUse()[0].wrapped_private_key);
    // The address typed in other ASCII capitals: master is made from the session's.
    const openWithAnother = await notOpened("SomeOne@Example.TEST");
    expect(tab.setTabKey).not.toHaveBeenCalled();

    expect(await openWithAnother(NEW_PASSWORD)).toEqual({ ok: true });
    expect(server.log).toEqual(["readSignedInAddress", "readMailKey(in use)", "rewrapMailKey"]);
    expect(derive.calls).toEqual([{ email: EMAIL, password: NEW_PASSWORD }]);
    // Over the wrap it opened, with a new salt; the same key, now open in this tab.
    expect(server.rewrapMailKey.mock.calls[0][0]).toMatchObject({ keyId, previousWrappedPrivateKey: before });
    expect(server.inUse().map((k) => k.key_id)).toEqual([keyId]);
    expect(String(server.inUse()[0].wrapped_private_key)).not.toBe(before);
    expect(tabKey().keyId).toBe(keyId);
    expect(await opensMailOfKeyInUse(tabKey())).toBe(true);

    // The next sign-in, with the login's password, opens it; the other one no longer does.
    server.signedIn = false;
    tab.setTabKey.mockReset();
    expect(await login(PASSWORD)).toEqual({ ok: true, userId: USER, key: "opened" });
    expect(await opensMailOfKeyInUse(tabKey())).toBe(true);
    expect(await openKeyAgain({ email: EMAIL, password: PASSWORD, userId: USER }, server)).toEqual({ ok: true });
    expect(await openKeyAgain({ email: EMAIL, password: NEW_PASSWORD, userId: USER }, server)).toEqual({ ok: false, code: "wrong_password" });
  });

  it("a password that does not open it either is told so; nothing is stored, and it can be tried again", async () => {
    await halfChanged();
    const before = String(server.inUse()[0].wrapped_private_key);
    const openWithAnother = await notOpened();
    expect(await openWithAnother("まだちがうパスワードです")).toEqual({ ok: false, code: "other_password_wrong" });
    expect(flowMessage("other_password_wrong")).toBe("このパスワードでも、メールの鍵を開けませんでした。");
    expect(server.log).not.toContain("rewrapMailKey");
    expect(String(server.inUse()[0].wrapped_private_key)).toBe(before);
    expect(tab.setTabKey).not.toHaveBeenCalled();
    expect(await openWithAnother(NEW_PASSWORD)).toEqual({ ok: true });
  });

  it("a key wrapped again for the login's password meanwhile (another tab) is only opened", async () => {
    await halfChanged();
    const fromAnotherTab = await notOpened();
    const openWithAnother = await notOpened();
    expect(await fromAnotherTab(NEW_PASSWORD)).toEqual({ ok: true });
    server.log = [];
    tab.setTabKey.mockReset();
    // The password typed here does not matter any more: the login's opens it.
    expect(await openWithAnother("まだちがうパスワードです")).toEqual({ ok: true });
    expect(server.log).toEqual(["readSignedInAddress", "readMailKey(in use)"]);
    expect(await opensMailOfKeyInUse(tabKey())).toBe(true);
  });

  it("another account signed in meanwhile: nothing is read or wrapped for it", async () => {
    await halfChanged();
    const openWithAnother = await notOpened();
    server.readSignedInAddress.mockResolvedValueOnce({ ok: true, userId: "00000000-0000-4000-8000-00000000000b", email: "other@example.test" });
    expect(await openWithAnother(NEW_PASSWORD)).toEqual({ ok: false, code: "signed_out" });
    expect(server.log).toEqual([]);
    expect(tab.setTabKey).not.toHaveBeenCalled();
  });

  it.each([
    ["a wrap another tab changed", KEY_WRAP_CHANGED, "key_wrap_changed"],
    ["a session older than 15 minutes since the password", KEY_SESSION_STALE, "stale_session"],
  ] as const)("a refused save (%s) is told with its words, and the tab gets nothing", async (_, error, code) => {
    await halfChanged();
    const openWithAnother = await notOpened();
    server.before.rewrapMailKey = () => ({ ok: false, error });
    expect(await openWithAnother(NEW_PASSWORD)).toEqual({ ok: false, code });
    expect(flowMessage(code)).toBe(LOGIN_MESSAGES[code]);
    expect(tab.setTabKey).not.toHaveBeenCalled();
    expect(await openKeyAgain({ email: EMAIL, password: NEW_PASSWORD, userId: USER }, server)).toEqual({ ok: true });
  });

  it("the change's words say to try the same new password again, which brings both to it", () => {
    expect(LOGIN_MESSAGES.secret_change_refused_key_new).toBe("パスワードを変えられませんでした。同じ新しいパスワードで、もう一度お試しください。");
    expect(LOGIN_MESSAGES.key_not_opened).toBe("このパスワードでは、メールの鍵を開けませんでした。");
  });
});

describe("signing in: another tab or device makes the first key at the same time", () => {
  /** The other device: the same password makes and activates a key, through the same steps. */
  async function otherDeviceMakesKey() {
    const other = new Server();
    other.db = server.db;
    other.account = server.account;
    other.signedIn = true;
    const result = await signInAndOpenKey({ email: EMAIL, password: PASSWORD }, other);
    expect(result).toMatchObject({ ok: true, key: "made" });
    return String(server.inUse()[0].key_id);
  }

  it("refused at registration (the key in use changed): reads the key in use again and opens it with the same master", async () => {
    await signUp();
    let theirs = "";
    server.before.registerMailKey = async () => {
      theirs = await otherDeviceMakesKey();
      return undefined; // then the real registration, which is refused
    };
    tab.setTabKey.mockReset();
    const result = await login();
    expect(result).toEqual({ ok: true, userId: USER, key: "opened" });
    expect(server.inUse().map((k) => k.key_id)).toEqual([theirs]);
    expect(tabKey().keyId).toBe(theirs);
    expect(server.log.slice(-2)).toEqual(["registerMailKey", "readMailKey(in use)"]);
    expect(derive.calls.filter((c) => c.password === PASSWORD).length).toBe(2); // ours once, theirs once
  });

  it("refused at activation (it was made between our registration and activation): the same", async () => {
    await signUp();
    let theirs = "";
    server.before.activateMailKey = async () => {
      theirs = await otherDeviceMakesKey();
      // Their registration removed our waiting row; ours is refused like the database refuses it.
      return { ok: false, error: KEY_IN_USE_CHANGED };
    };
    const result = await login();
    expect(result).toEqual({ ok: true, userId: USER, key: "opened" });
    expect(tabKey().keyId).toBe(theirs);
    expect(server.inUse()).toHaveLength(1);
  });
});

describe("the address of a first key", () => {
  it("makes no key when the session's address is not the typed one for password-v1 (letters outside ASCII)", async () => {
    // Supabase keeps the address in its own lower case (U+0130 becomes i + U+0307); the browser's
    // email_norm leaves U+0130 as it is. The sign-in itself went through.
    const typed = "İstanbul@example.test";
    server.account.email = typed;
    server.account.secret = await secretFor(PASSWORD, typed);
    server.readSignedInAddress.mockImplementation(async () => ({ ok: true as const, userId: USER, email: "i̇stanbul@example.test" }));
    expect(await login(PASSWORD, typed)).toEqual({ ok: true, userId: USER, key: "failed", code: "address_mismatch" });
    expect(server.registerMailKey).not.toHaveBeenCalled();
    expect(server.db.rows("user_keys")).toHaveLength(0);
    expect(flowMessage("address_mismatch")).toBe("このアカウントでは、メールの鍵を作れませんでした。");
  });

  it("negative control: the same address in other ASCII capitals and with spaces around it is the same: the key is made", async () => {
    await signUp();
    expect(await login(PASSWORD, "  SomeOne@Example.TEST\t")).toEqual({ ok: true, userId: USER, key: "made" });
  });

  it("makes no key when the session is not the one that signed in", async () => {
    await signUp();
    server.readSignedInAddress.mockImplementation(async () => ({ ok: true as const, userId: "00000000-0000-4000-8000-00000000000b", email: EMAIL }));
    expect(await login()).toEqual({ ok: true, userId: USER, key: "failed", code: "other" });
    expect(server.registerMailKey).not.toHaveBeenCalled();
  });
});

describe("opening the key again (a reloaded tab)", () => {
  it("opens the key in use with the session's address and the password, without asking Supabase Auth", async () => {
    await signUp();
    await login();
    tab.setTabKey.mockReset();
    server.log = [];
    expect(await openKeyAgain({ email: EMAIL, password: PASSWORD, userId: USER }, server)).toEqual({ ok: true });
    expect(server.log).toEqual(["readMailKey(in use)"]);
    expect(await opensMailOfKeyInUse(tabKey())).toBe(true);
  });

  it("a wrong password is told as such, and the tab gets nothing", async () => {
    await signUp();
    await login();
    tab.setTabKey.mockReset();
    expect(await openKeyAgain({ email: EMAIL, password: "ちがうパスワードですよ", userId: USER }, server)).toEqual({ ok: false, code: "wrong_password" });
    expect(tab.setTabKey).not.toHaveBeenCalled();
    expect(flowMessage("wrong_password")).toBe("パスワードが違います。");
  });

  it("no key in use, and a key read that failed, are told apart (never as a wrong password)", async () => {
    await signUp();
    server.signedIn = true;
    expect(await openKeyAgain({ email: EMAIL, password: PASSWORD, userId: USER }, server)).toEqual({ ok: false, code: "no_key" });
    server.signedIn = false;
    expect(await openKeyAgain({ email: EMAIL, password: PASSWORD, userId: USER }, server)).toEqual({ ok: false, code: "signed_out" });
    server.before["readMailKey(in use)"] = () => ({ ok: false, error: "network" });
    expect(await openKeyAgain({ email: EMAIL, password: PASSWORD, userId: USER }, server)).toEqual({ ok: false, code: "network" });
  });
});

describe("changing the password", () => {
  it("opens with the current one, wraps again for the new one, checks it opens, then sends both secrets with the rewrap", async () => {
    await signUp();
    await login();
    const before = { ...server.inUse()[0] };
    server.log = [];
    tab.setTabKey.mockReset();
    expect(await changePassword({ email: EMAIL, userId: USER, current: PASSWORD, next: NEW_PASSWORD }, server)).toEqual({ ok: true });
    expect(server.log).toEqual(["readMailKey(in use)", "changeLoginSecret"]);
    const sent = server.changeLoginSecret.mock.calls[0][0];
    expect(sent.currentAuthSecret).toBe(await secretFor(PASSWORD));
    expect(sent.newAuthSecret).toBe(await secretFor(NEW_PASSWORD));
    expect(sent.rewrap).toMatchObject({ keyId: before.key_id, previousWrappedPrivateKey: before.wrapped_private_key, kdfIterations: 600_000 });
    expect(sent.rewrap!.kdfSalt).not.toBe(before.kdf_salt);
    expect(JSON.stringify(sent)).not.toContain(NEW_PASSWORD);

    // The same key, now opened by the new password only; the old mail still opens.
    const after = server.inUse()[0];
    expect(after.key_id).toBe(before.key_id);
    expect(await opensMailOfKeyInUse(tabKey())).toBe(true);
    expect(await openKeyAgain({ email: EMAIL, password: NEW_PASSWORD, userId: USER }, server)).toEqual({ ok: true });
    expect(await openKeyAgain({ email: EMAIL, password: PASSWORD, userId: USER }, server)).toEqual({ ok: false, code: "wrong_password" });
    expect(await login(PASSWORD)).toEqual({ ok: false, code: "credentials" });
    expect(await login(NEW_PASSWORD)).toEqual({ ok: true, userId: USER, key: "opened" });
  });

  it("a current password that does not open the key sends nothing", async () => {
    await signUp();
    await login();
    server.log = [];
    expect(await changePassword({ email: EMAIL, userId: USER, current: "ちがうパスワードですよ", next: NEW_PASSWORD }, server)).toEqual({ ok: false, code: "wrong_current_password" });
    expect(server.changeLoginSecret).not.toHaveBeenCalled();
    expect(flowMessage("wrong_current_password")).toBe("今のパスワードが違います。");
  });

  it("the same password twice is refused before anything is made or sent", async () => {
    expect(await changePassword({ email: EMAIL, userId: USER, current: "ＰＡＳＳ１２３４ねこ", next: "PASS1234ねこ" }, server)).toEqual({ ok: false, code: "same_secret" });
    expect(derive.calls).toEqual([]);
    expect(server.log).toEqual([]);
    expect(flowMessage("same_secret")).toBe(LOGIN_MESSAGES.same_secret);
  });

  it("Supabase refusing the current login secret is told as the current password being wrong", async () => {
    await signUp();
    await login();
    server.before.changeLoginSecret = () => ({ ok: false, code: "credentials" });
    expect(await changePassword({ email: EMAIL, userId: USER, current: PASSWORD, next: NEW_PASSWORD }, server)).toEqual({ ok: false, code: "wrong_current_password" });
  });

  it("with no key in use: sends no rewrap", async () => {
    await signUp();
    server.signedIn = true;
    expect(await changePassword({ email: EMAIL, userId: USER, current: PASSWORD, next: NEW_PASSWORD }, server)).toEqual({ ok: true });
    expect(server.changeLoginSecret.mock.calls[0][0].rewrap).toBeNull();
    expect(tab.setTabKey).not.toHaveBeenCalled();
  });

  it("after a change whose new secret was refused and whose wrap stayed new, trying again brings both back to one password", async () => {
    await signUp();
    await login();
    // First try: the rewrap is stored, Supabase refuses the new secret, and the wrap cannot be put back.
    server.before.changeLoginSecret = async () => {
      const input = server.changeLoginSecret.mock.calls.at(-1)![0];
      await rewrapKey(asAdmin(server.db), USER, input.rewrap!);
      return { ok: false, code: "secret_change_refused_key_new" };
    };
    expect(await changePassword({ email: EMAIL, userId: USER, current: PASSWORD, next: NEW_PASSWORD }, server)).toEqual({ ok: false, code: "secret_change_refused_key_new" });
    expect(await openKeyAgain({ email: EMAIL, password: NEW_PASSWORD, userId: USER }, server)).toEqual({ ok: true });
    expect(server.account.secret).toBe(await secretFor(PASSWORD));

    // The same change again: the key opens with the new password already, and is wrapped again for it.
    expect(await changePassword({ email: EMAIL, userId: USER, current: PASSWORD, next: NEW_PASSWORD }, server)).toEqual({ ok: true });
    expect(server.account.secret).toBe(await secretFor(NEW_PASSWORD));
    expect(await login(NEW_PASSWORD)).toEqual({ ok: true, userId: USER, key: "opened" });
  });

  it.each(["secret_change_refused", "secret_change_unknown", "key_wrap_changed", "key_in_use_changed", "signed_out", "rate"] as const)("answers %s with its fixed words", async (code) => {
    await signUp();
    await login();
    server.before.changeLoginSecret = () => ({ ok: false, code });
    const result = await changePassword({ email: EMAIL, userId: USER, current: PASSWORD, next: NEW_PASSWORD }, server);
    expect(result).toEqual({ ok: false, code });
    expect(flowMessage(code)).toBe(LOGIN_MESSAGES[code]);
  });
});

describe("finishing a reset", () => {
  /** A user whose password is forgotten: a key in use from before, the reset link's session. */
  async function forgotten() {
    await signUp("わすれたパスワードです");
    await login("わすれたパスワードです");
    const old = String(server.inUse()[0].key_id);
    server.log = [];
    tab.setTabKey.mockReset();
    tab.forgetTabKey.mockReset();
    return old;
  }

  it("reads the key in use, registers a new key, reads it back, then finishReset with the new secret and its challenge", async () => {
    const old = await forgotten();
    expect(await finishPasswordReset({ email: EMAIL, userId: USER, password: NEW_PASSWORD }, server)).toEqual({ ok: true });
    expect(server.log).toEqual(["readMailKey(in use)", "registerMailKey", "readMailKey(id)", "finishReset"]);
    const sent = server.finishReset.mock.calls[0][0];
    expect(sent.authSecret).toBe(await secretFor(NEW_PASSWORD));
    expect(sent.expectedCurrentKeyId).toBe(old);
    expect(server.registerMailKey.mock.calls.at(-1)![0]).toMatchObject({ expectedCurrentKeyId: old });
    // The new key is in use and open; the old one is retired.
    expect(server.inUse().map((k) => k.key_id)).not.toContain(old);
    expect(tab.forgetTabKey).toHaveBeenCalledTimes(1);
    expect(await opensMailOfKeyInUse(tabKey())).toBe(true);
    expect(await login(NEW_PASSWORD)).toEqual({ ok: true, userId: USER, key: "opened" });
  });

  it("when only the activation fails: told, and running it again from the start goes through with one key in use", async () => {
    const old = await forgotten();
    server.before.finishReset = async () => {
      // The new secret is set; the activation fails (a database error).
      server.account.secret = server.finishReset.mock.calls.at(-1)![0].authSecret;
      return { ok: false, code: "key_failed" };
    };
    expect(await finishPasswordReset({ email: EMAIL, userId: USER, password: NEW_PASSWORD }, server)).toEqual({ ok: false, code: "key_failed" });
    expect(server.inUse().map((k) => k.key_id)).toEqual([old]);
    expect(tab.setTabKey).not.toHaveBeenCalled();

    expect(await finishPasswordReset({ email: EMAIL, userId: USER, password: NEW_PASSWORD }, server)).toEqual({ ok: true });
    expect(server.inUse()).toHaveLength(1);
    expect(server.inUse()[0].key_id).not.toBe(old);
    // One waiting key at most: the retry's registration replaced the first one.
    expect(server.db.rows("user_keys").filter((k) => !k.activated_at)).toHaveLength(0);
    expect(await login(NEW_PASSWORD)).toEqual({ ok: true, userId: USER, key: "opened" });
  });

  it("a stale session (more than 15 minutes) is refused at registration and told with the fixed words", async () => {
    await forgotten();
    server.before.registerMailKey = () => ({ ok: false, error: KEY_SESSION_STALE });
    expect(await finishPasswordReset({ email: EMAIL, userId: USER, password: NEW_PASSWORD }, server)).toEqual({ ok: false, code: "stale_session" });
    expect(server.finishReset).not.toHaveBeenCalled();
    expect(flowMessage("stale_session")).toBe(LOGIN_MESSAGES.stale_session);
  });

  it("finishReset's own codes come through (reset_expired, signed_out)", async () => {
    await forgotten();
    server.before.finishReset = () => ({ ok: false, code: "reset_expired" });
    expect(await finishPasswordReset({ email: EMAIL, userId: USER, password: NEW_PASSWORD }, server)).toEqual({ ok: false, code: "reset_expired" });
    expect(flowMessage("reset_expired")).toBe(LOGIN_MESSAGES.reset_expired);
  });
});

describe("the key Actions' answers", () => {
  it("are read as codes: stale, no answer, signed out, and the texts of mail-keys.ts", () => {
    expect(keyActionCode(KEY_SESSION_STALE)).toBe("stale_session");
    expect(keyActionCode("network")).toBe("network");
    expect(keyActionCode(SIGNED_OUT)).toBe("signed_out");
    expect(keyActionCode(KEY_IN_USE_CHANGED)).toBe("key_in_use_changed");
    expect(keyActionCode("user_keys insert failed: boom")).toBe("key_failed");
  });

  it("a code this version does not know gets the unknown-code words, never the text itself", () => {
    expect(flowMessage("no_such_code" as never)).toBe("ログインできませんでした。もう一度お試しください。");
    expect(flowMessage("constructor" as never)).toBe("ログインできませんでした。もう一度お試しください。");
  });
});

describe("the contract shared with the iOS app (fixtures/crypto/password-v1.json, 600,000 rounds)", () => {
  type Vector = { name: string; email: string; password: string; auth_secret: string; user_id: string; user_keys_row: StoredKey };
  const vectors = JSON.parse(readFileSync(path.resolve(__dirname, "../../../fixtures/crypto/password-v1.json"), "utf8")) as { cases: Vector[]; private_key: { key_id: string } };
  const v = vectors.cases.find((c) => c.name === "ascii")!;

  it("the sign-in sends the vector's auth_secret, and opening again opens the vector's stored row", async () => {
    derive.real = true;
    const seen: string[] = [];
    const ports = {
      signInWithAuthSecret: async (input: { authSecret: string }) => {
        seen.push(input.authSecret);
        return { ok: false as const, code: "credentials" as const };
      },
      readSignedInAddress: async () => ({ ok: false as const }),
      readMailKey: async () => ({ ok: true as const, key: v.user_keys_row }),
      registerMailKey: async () => ({ ok: false as const, error: "unused" }),
      activateMailKey: async () => ({ ok: false as const, error: "unused" }),
      rewrapMailKey: async () => ({ ok: false as const, error: "unused" }),
    };
    await signInAndOpenKey({ email: v.email, password: v.password }, ports);
    expect(seen).toEqual([v.auth_secret]);
    expect(await openKeyAgain({ email: v.email, password: v.password, userId: v.user_id }, ports)).toEqual({ ok: true });
    expect(tabKey().keyId).toBe(vectors.private_key.key_id);
  }, 20_000);
});
