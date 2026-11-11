"use client";

/**
 * The key steps of password-v1 in the browser (docs/crypto/password-v1.md): one password signs in
 * and opens the key that opens the stored mail.
 *
 *   signUpWithPassword    /signup: the account, with the login secret (the key comes at the first sign-in)
 *   signInAndOpenKey      /login, and 設定 for a user with no key: sign in, then open the key in use
 *                         or, when there is none, make the first one. A key the password does not
 *                         open can be opened with another one, and is then wrapped again for the
 *                         password that signed in (openWithAnother)
 *   openKeyAgain          a reloaded or new tab: open the key in use again (Supabase Auth is not asked)
 *   changePassword        設定: the same key wrapped again for the new password, then the new login secret
 *   finishPasswordReset   /reset-password: a new key for the new password, then the new login secret
 *
 * From the password the browser makes master once per step (600,000 PBKDF2 rounds), and from it
 * the login secret (sent as the account's password) and the KEK (kept here). master, the login
 * secret and the KEKs live in these functions only and are let go when they return: they are put in
 * no React state and not in tab-key.ts, which keeps only the opened private key (a CryptoKey that
 * cannot be exported).
 *
 * The address: on /login, the one typed (the sign-in is made with it); after the login (opening
 * again, a change, a reset), the session's, which the server pages hand down. Before a first key
 * is made on /login, the two are checked to be the same for password-v1 (emailNorm): every later
 * step makes master from the session's.
 *
 * The Server Actions come in as `ports` (the screens pass the real ones; the tests pass fakes).
 * Every answer is a code (FlowCode); flowMessage gives the words. Server code must not import this
 * file (src/lib/__tests__/passphrase-stays-in-browser.test.ts).
 */
import { toBase64 } from "./bytes";
import { challengeAad, openBytes, type EnvelopeV1, type PrivateRecipient } from "./envelope";
import { createWrappedKey, openStoredKeyWithKek, rewrapStoredKey, type StoredKey } from "./key-wrap";
import { authSecretHex, deriveMaster, emailNorm, kekFor, newKdfSalt, normalizePassword } from "./password-v1";
import { forgetTabKey, setTabKey } from "./tab-key";
import { KEY_SESSION_STALE, keyStepCode, loginMessage, type ChangeSecretResult, type FinishResetResult, type LoginCode, type SignInResult, type SignUpResult } from "@/lib/login-errors";
import type { ChangeSecretInput, FinishResetInput, SignInInput, SignUpInput } from "@/lib/login-input";
import type { KeyActivation, KeyRead, KeyRegistration, KeyResult, KeyRewrap, StoredKeyColumns } from "@/lib/mail-keys";

// ---- The Server Actions the steps call ----------------------------------------------------------

/** src/app/app/settings/key-actions.ts */
export interface KeyPorts {
  readMailKey: (input: KeyRead) => Promise<KeyResult<{ key: StoredKeyColumns | null }>>;
  registerMailKey: (input: KeyRegistration) => Promise<KeyResult<{ keyId: string; challenge: EnvelopeV1 }>>;
  activateMailKey: (input: KeyActivation) => Promise<KeyResult<{ keyId: string }>>;
}

/** The signed-in user's id and address as Supabase Auth keeps it (src/app/login/session-actions.ts). */
export type SignedInAddress = { ok: true; userId: string; email: string } | { ok: false };

/** /login, and 設定's key for a user with none. */
export interface SignInPorts extends KeyPorts {
  /** src/app/login/actions.ts */
  signInWithAuthSecret: (input: SignInInput) => Promise<SignInResult>;
  readSignedInAddress: () => Promise<SignedInAddress>;
  /** key-actions.ts: a key opened with another password, wrapped again for the one that signed in. */
  rewrapMailKey: (input: KeyRewrap) => Promise<KeyResult<{ keyId: string }>>;
}

/** 設定's 「パスワードを変える」. */
export interface ChangePorts {
  readMailKey: KeyPorts["readMailKey"];
  /** src/app/app/settings/password-actions.ts */
  changeLoginSecret: (input: ChangeSecretInput) => Promise<ChangeSecretResult>;
}

/** /reset-password. */
export interface ResetPorts {
  readMailKey: KeyPorts["readMailKey"];
  registerMailKey: KeyPorts["registerMailKey"];
  /** src/app/reset-password/actions.ts */
  finishReset: (input: FinishResetInput) => Promise<FinishResetResult>;
}

// ---- What the steps come to -----------------------------------------------------------------------

/**
 * Every answer is a code of src/lib/login-errors.ts, with its words in LOGIN_MESSAGES: the server's,
 * and those the browser finds itself (wrong_password, wrong_current_password, no_key,
 * address_mismatch, other_password_wrong). A sign-in whose key did not open is told with
 * key_not_opened.
 */
export type FlowCode = LoginCode;

/** The words for a code (LOGIN_MESSAGES; the unknown-code words for anything else). */
export function flowMessage(code: FlowCode): string {
  return loginMessage(code);
}

export type Failed = { ok: false; code: FlowCode };

/**
 * 「ほかのパスワードで開く」: the key in use opened with `otherPassword`, wrapped again for the
 * password that signed in, stored, and opened in this tab. It holds that password's master, never
 * the password: the screen keeps no copy of it.
 */
export type OpenWithAnother = (otherPassword: string) => Promise<{ ok: true } | Failed>;

/**
 * After a sign-in that went through:
 * - `opened`: the key in use is open in this tab; `made`: there was none, and the first one is
 *   made, in use and open.
 * - `not_opened`: the key in use does not open with this password: a key made before password-v1,
 *   or a change that stopped half-way (the login is the old password, the key opens with the new
 *   one). `openWithAnother` tries a password that opened it before; a reset makes a new key and
 *   loses the mail sealed before.
 * - `failed`: the key could not be opened or made, for `code`. Signing in again tries again.
 */
export type KeyAfterSignIn = { key: "opened" } | { key: "made" } | { key: "not_opened"; openWithAnother: OpenWithAnother } | { key: "failed"; code: FlowCode };

export type SignInOutcome = ({ ok: true; userId: string } & KeyAfterSignIn) | Failed;

// ---- Reading the Actions' answers --------------------------------------------------------------------

/** What src/app/app/settings/key-actions.ts says for a session that is not signed in. */
const KEY_ACTION_SIGNED_OUT = "ログインし直してください";

/** The code for the `error` of a key Action (key-actions.ts, with the texts of mail-keys.ts). */
export function keyActionCode(error: string): FlowCode {
  if (error === KEY_SESSION_STALE) return "stale_session";
  if (error === "network") return "network";
  if (error === KEY_ACTION_SIGNED_OUT) return "signed_out";
  return keyStepCode(error);
}

/** An AES-GCM open that failed: the KEK is not the one the key was wrapped with (another password). */
function isWrongKek(err: unknown): boolean {
  return err instanceof Error && err.name === "OperationError";
}

/** The stored form of a wrap made here, as openStoredKeyWithKek reads a row. */
function rowOf(made: Awaited<ReturnType<typeof createWrappedKey>>): StoredKey {
  return { key_id: made.keyId, public_key: toBase64(made.publicKey), ...made.wrapped };
}

/** The row opened with the KEK of `master` and the row's own kdf_salt; null when that KEK does not open it. Throws for anything else. */
async function openRow(row: StoredKey, master: CryptoKey, userId: string): Promise<PrivateRecipient | null> {
  try {
    return await openStoredKeyWithKek(row, await kekFor(master, row.kdf_salt), userId);
  } catch (err) {
    if (isWrongKek(err)) return null;
    throw err;
  }
}

// ---- Making a key -------------------------------------------------------------------------------------

type Registered = { ok: true; keyId: string; answer: string; recipient: PrivateRecipient } | Failed;

/**
 * A new key pair wrapped with the KEK of `master` (a new kdf_salt), registered as waiting, read
 * back from the database, opened from that copy with the KEK made again from its own salt, and its
 * challenge opened: the answer that puts it in use. `expectedCurrentKeyId` is the key in use this
 * step started from (the server refuses when another tab or device has put one in use since).
 */
async function registerNewKey(master: CryptoKey, userId: string, expectedCurrentKeyId: string | null, ports: Pick<KeyPorts, "readMailKey" | "registerMailKey">): Promise<Registered> {
  const salt = newKdfSalt();
  const made = await createWrappedKey(await kekFor(master, salt), salt, userId);
  // Opened again with the KEK made from the salt as it will be stored: a salt mixed up on the
  // way would only show here (and a key that cannot open is never sent).
  if (!(await openRow(rowOf(made), master, userId))) return { ok: false, code: "key_failed" };
  const reg = await ports.registerMailKey({
    publicKey: toBase64(made.publicKey),
    wrappedPrivateKey: made.wrapped.wrapped_private_key,
    wrapIv: made.wrapped.wrap_iv,
    kdfSalt: made.wrapped.kdf_salt,
    kdfIterations: made.wrapped.kdf_iterations,
    expectedCurrentKeyId,
  });
  if (!reg.ok) return { ok: false, code: keyActionCode(reg.error) };
  if (reg.keyId !== made.keyId) return { ok: false, code: "key_failed" };

  // From the copy the database holds: it opens with this password and is this pair.
  const back = await ports.readMailKey({ keyId: reg.keyId });
  if (!back.ok) return { ok: false, code: keyActionCode(back.error) };
  const row = back.key;
  const sent = rowOf(made);
  if (!row || row.key_id !== sent.key_id || row.public_key !== sent.public_key || row.wrapped_private_key !== sent.wrapped_private_key || row.wrap_iv !== sent.wrap_iv || row.kdf_salt !== sent.kdf_salt) {
    return { ok: false, code: "key_failed" };
  }
  const recipient = await openRow(row, master, userId);
  if (!recipient) return { ok: false, code: "key_failed" };
  const answer = await openBytes(recipient, challengeAad(userId, reg.keyId), reg.challenge);
  return { ok: true, keyId: reg.keyId, answer: toBase64(answer), recipient };
}

/**
 * openWithAnother for a sign-in with `loginMaster` whose password did not open the key in use.
 * master is made from the session's address, as every step after the login (the typed one must be
 * the same for password-v1, or the next sign-in would make another master); the key in use is read
 * again (another tab may have changed it), opened with the KEK of the other password and the row's
 * kdf_salt, wrapped again with the KEK of the login's password and a new salt, opened from that
 * wrap, and only then stored, over the wrap it was opened from (rewrapMailKey; a session less than
 * 15 minutes after the password sign-in, which this follows). A key that opens with the login's
 * password already (another tab did this meanwhile) is only opened.
 */
function anotherPasswordOpener(loginMaster: CryptoKey, typedEmail: string, userId: string, ports: SignInPorts): OpenWithAnother {
  return async (otherPassword) => {
    try {
      const who = await ports.readSignedInAddress();
      // Another account signed in meanwhile (another tab): its key is not this one's to wrap.
      if (!who.ok || who.userId !== userId) return { ok: false, code: "signed_out" };
      if (emailNorm(who.email) !== emailNorm(typedEmail)) return { ok: false, code: "address_mismatch" };
      const [otherMaster, read] = await Promise.all([deriveMaster(who.email, otherPassword), ports.readMailKey({ keyId: null })]);
      if (!read.ok) return { ok: false, code: keyActionCode(read.error) };
      if (!read.key) return { ok: false, code: "no_key" };
      const stored = read.key;
      const already = await openRow(stored, loginMaster, userId);
      if (already) {
        setTabKey(userId, already);
        return { ok: true };
      }
      if (!(await openRow(stored, otherMaster, userId))) return { ok: false, code: "other_password_wrong" };
      const salt = newKdfSalt();
      const wrap = await rewrapStoredKey(stored, await kekFor(otherMaster, stored.kdf_salt), await kekFor(loginMaster, salt), salt, userId);
      // The new wrap opens with the login's password, from the salt it carries: nothing else is stored.
      const reopened = await openRow({ ...stored, ...wrap }, loginMaster, userId);
      if (!reopened) return { ok: false, code: "key_failed" };
      const saved = await ports.rewrapMailKey({
        keyId: stored.key_id,
        previousWrappedPrivateKey: stored.wrapped_private_key,
        wrappedPrivateKey: wrap.wrapped_private_key,
        wrapIv: wrap.wrap_iv,
        kdfSalt: wrap.kdf_salt,
        kdfIterations: wrap.kdf_iterations,
      });
      if (!saved.ok) return { ok: false, code: keyActionCode(saved.error) };
      setTabKey(userId, reopened);
      return { ok: true };
    } catch {
      return { ok: false, code: "other" };
    }
  };
}

/** The key in use read again and opened with the same master (another tab or device put one in use meanwhile). */
async function openKeyInUse(master: CryptoKey, typedEmail: string, userId: string, ports: SignInPorts): Promise<KeyAfterSignIn> {
  const read = await ports.readMailKey({ keyId: null });
  if (!read.ok) return { key: "failed", code: keyActionCode(read.error) };
  if (!read.key) return { key: "failed", code: "key_failed" };
  const recipient = await openRow(read.key, master, userId);
  if (!recipient) return { key: "not_opened", openWithAnother: anotherPasswordOpener(master, typedEmail, userId, ports) };
  setTabKey(userId, recipient);
  return { key: "opened" };
}

/** After the sign-in: the key in use opened, or the first one made. */
async function openOrMakeKey(master: CryptoKey, typedEmail: string, userId: string, ports: SignInPorts): Promise<KeyAfterSignIn> {
  const read = await ports.readMailKey({ keyId: null });
  if (!read.ok) return { key: "failed", code: keyActionCode(read.error) };
  if (read.key) {
    const recipient = await openRow(read.key, master, userId);
    if (!recipient) return { key: "not_opened", openWithAnother: anotherPasswordOpener(master, typedEmail, userId, ports) };
    setTabKey(userId, recipient);
    return { key: "opened" };
  }

  // No key yet. Every later step makes master from the session's address: make this key only when
  // the typed one is the same for password-v1 (an address with letters outside ASCII could differ).
  const who = await ports.readSignedInAddress();
  if (!who.ok || who.userId !== userId) return { key: "failed", code: "other" };
  if (emailNorm(who.email) !== emailNorm(typedEmail)) return { key: "failed", code: "address_mismatch" };

  const reg = await registerNewKey(master, userId, null, ports);
  if (!reg.ok) return reg.code === "key_in_use_changed" ? openKeyInUse(master, typedEmail, userId, ports) : { key: "failed", code: reg.code };
  const done = await ports.activateMailKey({ keyId: reg.keyId, challenge: reg.answer, expectedCurrentKeyId: null });
  if (!done.ok) {
    const code = keyActionCode(done.error);
    return code === "key_in_use_changed" ? openKeyInUse(master, typedEmail, userId, ports) : { key: "failed", code };
  }
  setTabKey(userId, reg.recipient);
  return { key: "made" };
}

// ---- The steps -------------------------------------------------------------------------------------------

/**
 * Sign in with the address and the password, then open the key in use, or make the first one.
 * The tab's key is forgotten first (another account may have used this tab).
 */
export async function signInAndOpenKey(input: { email: string; password: string; captchaToken?: string }, ports: SignInPorts): Promise<SignInOutcome> {
  forgetTabKey();
  try {
    const master = await deriveMaster(input.email, input.password);
    const signIn = await ports.signInWithAuthSecret({ email: input.email, authSecret: await authSecretHex(master), captchaToken: input.captchaToken });
    if (!signIn.ok) return signIn;
    try {
      return { ok: true, userId: signIn.userId, ...(await openOrMakeKey(master, input.email, signIn.userId, ports)) };
    } catch {
      return { ok: true, userId: signIn.userId, key: "failed", code: "other" };
    }
  } catch {
    return { ok: false, code: "other" };
  }
}

/**
 * Make an account with the address and the password: only the login secret is sent. No key yet:
 * the confirmation link comes first, and the key is made at the first sign-in (decision 6).
 */
export async function signUpWithPassword(input: { email: string; password: string; captchaToken?: string }, ports: { signUpWithAuthSecret: (input: SignUpInput) => Promise<SignUpResult> }): Promise<SignUpResult | Failed> {
  try {
    const master = await deriveMaster(input.email, input.password);
    return await ports.signUpWithAuthSecret({ email: input.email, authSecret: await authSecretHex(master), captchaToken: input.captchaToken });
  } catch {
    return { ok: false, code: "other" };
  }
}

/**
 * Open the key in use again in this tab (after a reload, in a new tab), with the session's address.
 * Only the wrapped key is read; Supabase Auth is not asked.
 */
export async function openKeyAgain(input: { email: string; password: string; userId: string }, ports: Pick<KeyPorts, "readMailKey">): Promise<{ ok: true } | Failed> {
  try {
    const [master, read] = await Promise.all([deriveMaster(input.email, input.password), ports.readMailKey({ keyId: null })]);
    if (!read.ok) return { ok: false, code: keyActionCode(read.error) };
    if (!read.key) return { ok: false, code: "no_key" };
    const recipient = await openRow(read.key, master, input.userId);
    if (!recipient) return { ok: false, code: "wrong_password" };
    setTabKey(input.userId, recipient);
    return { ok: true };
  } catch {
    return { ok: false, code: "key_failed" };
  }
}

/**
 * Change the password while the current one is known, with the session's address. The key in use
 * is opened with the current password, wrapped again with the KEK of the new one (a new kdf_salt),
 * opened again from that wrap, and only then sent with both login secrets (changeLoginSecret stores
 * the wrap and sets the new secret, and puts the wrap back when Supabase refuses the secret).
 *
 * A wrap that opens with the new password already (an earlier change whose new secret was refused
 * and whose wrap could not be put back, or whose answer was lost) is wrapped again the same way, so
 * trying the change again brings the key and the login back to one password.
 */
export async function changePassword(input: { email: string; userId: string; current: string; next: string; captchaToken?: string }, ports: ChangePorts): Promise<{ ok: true } | Failed> {
  if (normalizePassword(input.current) === normalizePassword(input.next)) return { ok: false, code: "same_secret" };
  try {
    const [read, currentMaster, newMaster] = await Promise.all([ports.readMailKey({ keyId: null }), deriveMaster(input.email, input.current), deriveMaster(input.email, input.next)]);
    if (!read.ok) return { ok: false, code: keyActionCode(read.error) };
    let rewrap: KeyRewrap | null = null;
    let reopened: PrivateRecipient | null = null;
    if (read.key) {
      const stored = read.key;
      const opener = (await openRow(stored, currentMaster, input.userId)) ? currentMaster : (await openRow(stored, newMaster, input.userId)) ? newMaster : null;
      if (!opener) return { ok: false, code: "wrong_current_password" };
      const salt = newKdfSalt();
      const wrap = await rewrapStoredKey(stored, await kekFor(opener, stored.kdf_salt), await kekFor(newMaster, salt), salt, input.userId);
      // The new wrap opens with the KEK made again from the salt it carries (A's check).
      reopened = await openRow({ ...stored, ...wrap }, newMaster, input.userId);
      if (!reopened) return { ok: false, code: "key_failed" };
      rewrap = { keyId: stored.key_id, previousWrappedPrivateKey: stored.wrapped_private_key, wrappedPrivateKey: wrap.wrapped_private_key, wrapIv: wrap.wrap_iv, kdfSalt: wrap.kdf_salt, kdfIterations: wrap.kdf_iterations };
    }
    const res = await ports.changeLoginSecret({
      currentAuthSecret: await authSecretHex(currentMaster),
      newAuthSecret: await authSecretHex(newMaster),
      rewrap,
      captchaToken: input.captchaToken,
    });
    if (!res.ok) return { ok: false, code: res.code === "credentials" ? "wrong_current_password" : res.code };
    if (reopened) setTabKey(input.userId, reopened);
    return { ok: true };
  } catch {
    return { ok: false, code: "other" };
  }
}

/**
 * The end of a reset (/reset-password), with the session's address: a new key for the new
 * password (registered, read back, its challenge opened), then finishReset sets the new login
 * secret and puts the key in use (the old key is retired: mail sealed to it no longer opens).
 *
 * Safe to run again from the start when it did not go through (a new key replaces the waiting one;
 * a login secret set already is taken as set): the screen's 「もう一度試す」 does that.
 *
 * A session too old for a key step (registerMailKey takes a reset link's session of the last 15
 * minutes) is reset_expired here, never stale_session: whoever resets has no password to log in
 * again with, and the way on is a new reset mail.
 */
export async function finishPasswordReset(input: { email: string; userId: string; password: string }, ports: ResetPorts): Promise<{ ok: true } | Failed> {
  const result = await resetSteps(input, ports);
  return result.ok || result.code !== "stale_session" ? result : { ok: false, code: "reset_expired" };
}

async function resetSteps(input: { email: string; userId: string; password: string }, ports: ResetPorts): Promise<{ ok: true } | Failed> {
  forgetTabKey();
  try {
    const [master, current] = await Promise.all([deriveMaster(input.email, input.password), ports.readMailKey({ keyId: null })]);
    if (!current.ok) return { ok: false, code: keyActionCode(current.error) };
    const expectedCurrentKeyId = current.key?.key_id ?? null;
    const reg = await registerNewKey(master, input.userId, expectedCurrentKeyId, ports);
    if (!reg.ok) return reg;
    const done = await ports.finishReset({ authSecret: await authSecretHex(master), expectedUserId: input.userId, expectedEmailNorm: emailNorm(input.email), keyId: reg.keyId, challenge: reg.answer, expectedCurrentKeyId });
    if (!done.ok) return { ok: false, code: done.code };
    setTabKey(input.userId, reg.recipient);
    return { ok: true };
  } catch {
    return { ok: false, code: "other" };
  }
}
