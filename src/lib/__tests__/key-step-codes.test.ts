import { describe, expect, it } from "vitest";
import { KEY_IN_USE_CHANGED, KEY_INPUT_INVALID, KEY_WRAP_CHANGED } from "@/lib/crypto/key-messages";
import { keyActionCode, flowMessage } from "@/lib/crypto/password-flows";
import { LOGIN_MESSAGES, keyStepCode } from "@/lib/login-errors";
import { registerKey } from "@/lib/mail-keys";
import { FakeDb } from "./fake-db";
import { USER, asAdmin } from "./pipeline-fixtures";

/**
 * The web's reading of what a key step of src/lib/mail-keys.ts answers (keyStepCode), after the
 * server's fixes of R3-PW-8: a value of the wrong form, a rewrap to the wrap it replaces and a key
 * registered already all come as KEY_INPUT_INVALID, and are invalid_input (「ページを読み込み直して
 * ください」), not key_failed (「もう一度お試しください」, which would only fail again). checkWrap's own
 * sentences are no longer sent.
 */

describe("keyStepCode", () => {
  it.each([
    [KEY_INPUT_INVALID, "invalid_input"],
    ["the wrap to put back is the one stored now", "invalid_input"],
    [KEY_IN_USE_CHANGED, "key_in_use_changed"],
    [KEY_WRAP_CHANGED, "key_wrap_changed"],
    ["no key is waiting to be activated", "key_not_pending"],
    ["user_keys activate failed: activate_user_key: no matching key is waiting to be activated", "key_not_pending"],
    ["the key did not open its challenge", "key_challenge_failed"],
    ["no key in use with this id", "key_not_in_use"],
    ["user_keys update failed: deadlock detected", "key_failed"],
  ] as const)("%s → %s", (error, code) => {
    expect(keyStepCode(error)).toBe(code);
  });

  it("the sentences checkWrap no longer sends are not known any more (any unknown text is key_failed)", () => {
    for (const gone of ["wrapped key has an unexpected size", "wrap iv must be 12 bytes", "salt must be 16 bytes"]) expect(keyStepCode(gone), gone).toBe("key_failed");
  });

  it("a key Action's KEY_INPUT_INVALID reaches the screen as invalid_input, in its words", () => {
    expect(keyActionCode(KEY_INPUT_INVALID)).toBe("invalid_input");
    expect(flowMessage(keyActionCode(KEY_INPUT_INVALID))).toBe(LOGIN_MESSAGES.invalid_input);
    expect(flowMessage(keyActionCode(KEY_INPUT_INVALID))).not.toBe(LOGIN_MESSAGES.key_failed);
  });

  it("seam: what the server step answers for a value of the wrong form is read as invalid_input", async () => {
    const answer = await registerKey(asAdmin(new FakeDb()), USER, { publicKey: "not base64!", wrappedPrivateKey: "AA==", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000, expectedCurrentKeyId: null });
    expect(answer).toEqual({ ok: false, error: KEY_INPUT_INVALID });
    if (answer.ok) throw new Error("refused expected");
    expect(keyActionCode(answer.error)).toBe("invalid_input");
  });
});
