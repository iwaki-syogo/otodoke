import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS existing address]
 *  - the guidance box sits above the form, as the Web's /login (login-form.tsx: "Above the form: on a phone a box
 *    below it can be off-screen"): in LoginView's body after the title and before the address field;
 *  - iOS still identifies an empty identities array and user_already_exists as an existing address.
 *    Its migration to the generic waiting state belongs to the iOS owner. Web sign-up suppresses
 *    that distinction (I6); login-actions.test.ts verifies the responses for each Auth outcome,
 *    while this source contract prevents reintroducing the old Web branch. The three neutral
 *    non-send aliases stay shared; native delivery failures belong to the separate iOS handoff.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

/** LoginView's `var body: some View { … }` (up to the next declaration of the type). */
function viewBody(src: string): string {
  const start = src.indexOf("var body: some View {");
  const end = src.indexOf("private func waitingHeader", start);
  return start >= 0 && end > start ? src.slice(start, end) : "";
}

/** The guidance box comes after the title and before the address field. */
function boxIsAboveTheForm(body: string): boolean {
  const title = body.indexOf("LoginText.signInTitle");
  const box = body.indexOf("existingAddressBox");
  const email = body.indexOf("emailField");
  return title >= 0 && box >= 0 && email >= 0 && title < box && box < email;
}

describe("the guidance box is above the form (as the Web's /login)", () => {
  const view = stripComments(read("ios/Otodoke/Auth/LoginView.swift"));

  it("the Web draws it above the form: the box comes before the <form>", () => {
    const web = read("src/app/login/login-form.tsx");
    expect(web.indexOf('notice?.kind === "existing_account"')).toBeGreaterThan(-1);
    expect(web.indexOf('notice?.kind === "existing_account"')).toBeLessThan(web.indexOf("<form"));
  });

  it("LoginView's body has the box after the title and before the address field, once", () => {
    const body = viewBody(view);
    expect(body).not.toBe("");
    expect(boxIsAboveTheForm(body)).toBe(true);
    expect(body.match(/existingAddressBox/g)?.length).toBe(1);
    expect(body).toMatch(/if model\.isExistingAddress \{\s*existingAddressBox\s*\}/);
  });

  it("negative control: the box below the address field, below the title's absence, or missing is caught", () => {
    const body = viewBody(view);
    const box = body.match(/if model\.isExistingAddress \{\s*existingAddressBox\s*\}/)![0];
    const moved = body.replace(box, "").replace("emailField\n", `emailField\n${box}\n`);
    expect(moved).not.toBe(body);
    expect(boxIsAboveTheForm(moved)).toBe(false);
    expect(boxIsAboveTheForm(body.replace(box, ""))).toBe(false);
    expect(boxIsAboveTheForm(box + body)).toBe(false);
  });
});

describe("legacy iOS existing-address handling and Web sign-up privacy", () => {
  const web = read("src/lib/login-auth.ts");
  const webSignup = web.slice(web.indexOf("export async function signUp("), web.indexOf("export async function resendSignupMail("));
  const swift = stripComments(read("ios/Otodoke/Auth/AuthService.swift"));
  const genericWebSignup = (src: string) => src.includes('return { ok: true, code: "signup_exists_or_sent" };') && !/signup_existing|identities/.test(src);

  /** The codes of the "sent" list: the array literal that precedes `.includes(` / `.contains(`. */
  const webSent = (src: string) => [...(src.match(/\[((?:"[a-z_]+",?\s*)+)\]\.includes\(error\.code/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  const swiftSent = (src: string) => [...(src.match(/\[((?:"[a-z_]+",?\s*)+)\]\.contains\(code/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  const nonSendAliases = ["email_exists", "user_already_exists", "user_not_found"];
  const legacyNativeDeliveryCode = "over_email_send_rate_limit";
  const deliveryBranch = /if\s*\(error\.code === "over_email_send_rate_limit"\s*\|\| error\.status === 429\s*\|\| error\.status === 500\)\s*return "mail_busy";/;

  function mailContractProblems(webSource: string, nativeSource: string): string[] {
    const problems: string[] = [];
    const mail = stripComments(webSource).match(/function mailRefusal\([^\n]+\{([\s\S]*?)^\}/m)?.[1] ?? "";
    const nativeAliases = swiftSent(nativeSource);
    if (JSON.stringify(webSent(mail)) !== JSON.stringify(nonSendAliases)) problems.push("Web non-send aliases");
    // Permit removal of the one known legacy delivery code, never arbitrary new aliases.
    if (JSON.stringify(nativeAliases.filter((code) => code !== legacyNativeDeliveryCode)) !== JSON.stringify(nonSendAliases)
      || nativeAliases.filter((code) => code === legacyNativeDeliveryCode).length > 1) problems.push("native non-send aliases");
    const neutral = mail.match(/if\s*\(\[[^\]]*\]\.includes\(error\.code \?\? ""\)\)\s*return "sent";/);
    if (!neutral || mail.match(/return\s+"sent";/g)?.length !== 1) problems.push("Web sent fallback");
    const delivery = mail.match(deliveryBranch);
    if (!delivery) problems.push("Web delivery failure");
    const outage = mail.match(/if\s*\(isOutage\(error\)\)\s*return "network";/);
    if (!neutral || !delivery || !outage || neutral.index! >= delivery.index! || delivery.index! >= outage.index!) problems.push("Web failure precedence");
    return problems;
  }

  it("iOS still reads empty identities as existing; Web sign-up returns only the generic success", () => {
    expect(webSignup).toContain("export async function signUp(");
    expect(genericWebSignup(webSignup)).toBe(true);
    expect(swift).toMatch(/if case let \.user\(user\) = answer, let identities = user\.identities, identities\.isEmpty \{ return \.existing \}/);
  });

  it("user_already_exists is read by code alone: generic Web success, legacy iOS existing state", () => {
    expect(web).toMatch(/result\.error\.code === "user_already_exists" && step === "sign-up"/);
    expect(web.match(/result\.error\.code === "user_already_exists"[^)]*/)?.[0]).not.toMatch(/status/);
    const line = swift.match(/if case let \.refused\(_, code\) = Self\.answer\(of: error\), code == "user_already_exists" \{ return \.existing \}/);
    expect(line).not.toBeNull();
  });

  it("shares exactly three non-send aliases while Web delivery refusals are mail_busy", () => {
    expect(mailContractProblems(web, swift)).toEqual([]);
  });

  it("the other refusals are the same too: captcha, the per-IP rate, an invalid address", () => {
    expect(web).toContain('error.code === "captcha_failed") return "captcha"');
    expect(web).toContain('error.code === "over_request_rate_limit") return "rate"');
    expect(web).toContain('error.code === "email_address_invalid" || error.code === "validation_failed") return "invalid_email"');
    expect(swift).toContain('if code == "captcha_failed" { return .failed(.captcha) }');
    expect(swift).toContain('if code == "over_request_rate_limit" { return .failed(.rate) }');
    expect(swift).toContain('if code == "email_address_invalid" || code == "validation_failed" { return .failed(.invalidEmail) }');
  });

  it("negative control: removing an alias changes its original list and fails the shared contract", () => {
    expect(mailContractProblems(web, swift)).toEqual([]);
    const changedNative = swift.replace('"email_exists", ', "");
    expect(changedNative).not.toBe(swift);
    expect(swiftSent(changedNative)).not.toEqual(swiftSent(swift));
    expect(mailContractProblems(web, changedNative)).toContain("native non-send aliases");
    const changedWeb = web.replace(', "user_not_found"', "");
    expect(changedWeb).not.toBe(web);
    expect(webSent(changedWeb)).not.toEqual(webSent(web));
    expect(mailContractProblems(changedWeb, swift)).toContain("Web non-send aliases");
  });

  it("negative control: unknown native aliases are not accepted as part of the handoff", () => {
    const changed = swift.replace('"email_exists", ', '"email_exists", "unknown_non_send", ');
    expect(changed).not.toBe(swift);
    expect(mailContractProblems(web, changed)).toContain("native non-send aliases");
  });

  it("negative control: restoring sent or the generic outage helper for delivery failures is caught", () => {
    const sent = web.replace('return "mail_busy";', 'return "sent";');
    expect(sent).not.toBe(web);
    expect(mailContractProblems(sent, swift)).toContain("Web sent fallback");
    const rawSent = web.replace('.includes(error.code ?? "")) return "sent";', '.includes(error.code ?? "") || error.status === 429) return "sent";');
    expect(rawSent).not.toBe(web);
    expect(mailContractProblems(rawSent, swift)).toContain("Web sent fallback");
    for (const clause of [" || error.status === 429", " || error.status === 500"]) {
      const changed = web.replace(clause, "");
      expect(changed).not.toBe(web);
      expect(mailContractProblems(changed, swift)).toContain("Web delivery failure");
    }
    const earlyHelper = web.replace(deliveryBranch, 'if (isOutage(error)) return "network";\n$&');
    expect(earlyHelper).not.toBe(web);
    expect(mailContractProblems(earlyHelper, swift)).toContain("Web failure precedence");
  });

  it("positive control: native can remove its legacy delivery alias and formatting keeps the contract", () => {
    const nativeList = /\[((?:"[a-z_]+",?\s*)+)\](?=\.contains\(code)/;
    const withoutLegacy = swift.replace(nativeList, JSON.stringify(nonSendAliases));
    expect(swiftSent(withoutLegacy)).toEqual(nonSendAliases);
    expect(mailContractProblems(web, withoutLegacy)).toEqual([]);
    const withLegacy = withoutLegacy.replace(nativeList, JSON.stringify([...nonSendAliases, legacyNativeDeliveryCode]));
    expect(withLegacy).not.toBe(withoutLegacy);
    expect(mailContractProblems(web, withLegacy)).toEqual([]);
    const formatted = web.replace('"email_exists", ', '"email_exists",\n    ');
    expect(formatted).not.toBe(web);
    expect(mailContractProblems(formatted, swift)).toEqual([]);
  });

  it("negative control: a status in the existing check or a missing identities test is caught", () => {
    expect(swift.replace("identities.isEmpty", "identities.count > 1")).not.toMatch(/identities\.isEmpty \{ return \.existing \}/);
    const withStatus = 'if case let .refused(status, code) = Self.answer(of: error), status == 422, code == "user_already_exists" { return .existing }';
    expect(withStatus).not.toMatch(/\.refused\(_, code\) = Self\.answer\(of: error\), code == "user_already_exists"/);
  });

  it("negative control: restoring the Web existing-address result violates the source contract", () => {
    const restored = webSignup.replace('return { ok: true, code: "signup_exists_or_sent" };', 'return { ok: true, code: result.existing ? "signup_existing" : "signup_exists_or_sent" };');
    expect(restored).not.toBe(webSignup);
    expect(genericWebSignup(restored)).toBe(false);
  });
});
