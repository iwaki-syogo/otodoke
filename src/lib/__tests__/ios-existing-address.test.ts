import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS existing address]
 *  - the guidance box sits above the form, as the Web's /login (login-form.tsx: "Above the form: on a phone a box
 *    below it can be off-screen"): in LoginView's body after the title and before the address field;
 *  - the sign-up's judgement of "this address is registered" is the Web's (src/lib/login-auth.ts): a user whose
 *    `identities` is an empty array, or a user_already_exists refusal read by its code alone; the codes that say
 *    "sent" are the same list.
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

describe("the sign-up's judgement of a registered address is the Web's", () => {
  const web = read("src/lib/login-auth.ts");
  const swift = stripComments(read("ios/Otodoke/Auth/AuthService.swift"));

  /** The codes of the "sent" list: the array literal that precedes `.includes(` / `.contains(`. */
  const webSent = (src: string) => [...(src.match(/\[((?:"[a-z_]+",?\s*)+)\]\.includes\(error\.code/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  const swiftSent = (src: string) => [...(src.match(/\[((?:"[a-z_]+",?\s*)+)\]\.contains\(code/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();

  it("an empty `identities` array is existing, on both sides", () => {
    expect(web).toContain("Array.isArray(data.user?.identities) && data.user.identities.length === 0");
    expect(swift).toMatch(/if case let \.user\(user\) = answer, let identities = user\.identities, identities\.isEmpty \{ return \.existing \}/);
  });

  it("user_already_exists is read by its code alone (no status), and only for the sign-up", () => {
    expect(web).toMatch(/result\.error\.code === "user_already_exists" && step === "sign-up"/);
    expect(web.match(/result\.error\.code === "user_already_exists"[^)]*/)?.[0]).not.toMatch(/status/);
    const line = swift.match(/if case let \.refused\(_, code\) = Self\.answer\(of: error\), code == "user_already_exists" \{ return \.existing \}/);
    expect(line).not.toBeNull();
  });

  it("the codes that say sent are the same list, and email_exists is among them on both sides", () => {
    expect(webSent(web)).toEqual(["email_exists", "over_email_send_rate_limit", "user_already_exists", "user_not_found"]);
    expect(swiftSent(swift)).toEqual(webSent(web));
    expect(web).toMatch(/\.includes\(error\.code \?\? ""\) \|\| error\.status === 429\) return "sent"/);
    expect(swift).toMatch(/\.contains\(code \?\? ""\) \|\| status == 429 \{ return \.sent \}/);
  });

  it("the other refusals are the same too: captcha, the per-IP rate, an invalid address", () => {
    expect(web).toContain('error.code === "captcha_failed") return "captcha"');
    expect(web).toContain('error.code === "over_request_rate_limit") return "rate"');
    expect(web).toContain('error.code === "email_address_invalid" || error.code === "validation_failed") return "invalid_email"');
    expect(swift).toContain('if code == "captcha_failed" { return .failed(.captcha) }');
    expect(swift).toContain('if code == "over_request_rate_limit" { return .failed(.rate) }');
    expect(swift).toContain('if code == "email_address_invalid" || code == "validation_failed" { return .failed(.invalidEmail) }');
  });

  it("negative control: a changed list, a status in the check or a missing identities test is caught", () => {
    expect(swiftSent(swift.replace('"email_exists", ', ""))).not.toEqual(webSent(web));
    expect(webSent(web.replace('"user_not_found", ', ""))).not.toEqual(swiftSent(swift));
    expect(swift.replace("identities.isEmpty", "identities.count > 1")).not.toMatch(/identities\.isEmpty \{ return \.existing \}/);
    const withStatus = 'if case let .refused(status, code) = Self.answer(of: error), status == 422, code == "user_already_exists" { return .existing }';
    expect(withStatus).not.toMatch(/\.refused\(_, code\) = Self\.answer\(of: error\), code == "user_already_exists"/);
  });
});
