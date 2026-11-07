import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS b7-tap] A token made by a person's tap on the Turnstile check tries the waiting screen at once. The widget
 * page tells Swift that it asks for a tap (before-interactive-callback, Cloudflare's widget configurations); the
 * kind it posts must be the one the Swift notice reads, and the model must read the mark through hasTap and clearTap().
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

// The string literals of `kind` the page posts, and the kinds Swift's Turnstile.notice() switches on.
function postedKinds(view: string): string[] {
  return [...view.matchAll(/post\("([a-z-]+)"/g)].map((m) => m[1]);
}
function handledKinds(view: string): string[] {
  return [...view.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]);
}

describe("ios b7-tap: the ask for a tap", () => {
  const view = read("ios/Otodoke/Auth/TurnstileView.swift");
  const model = read("ios/Otodoke/Auth/LoginModel.swift");

  it("renders both interactive callbacks, posting names the Swift side handles", () => {
    expect(view).toMatch(/"before-interactive-callback":\s*function\s*\(\)\s*\{\s*post\("interactive"\)/);
    expect(view).toMatch(/"after-interactive-callback":\s*function\s*\(\)\s*\{\s*post\("interactive-end"\)/);
    const handled = handledKinds(view);
    for (const kind of postedKinds(view)) expect(handled, kind).toContain(kind);
  });

  it("negative control: the checker sees a name that is posted but not handled", () => {
    const broken = view.replace('case "interactive":', 'case "interactiv":');
    const handled = handledKinds(broken);
    expect(postedKinds(broken).filter((k) => !handled.includes(k))).toEqual(["interactive"]);
  });

  it("reaches the model only through the used-once mark", () => {
    expect(model).toMatch(/turnstile\.hasTap/);
    // The tap is counted, stamped and tried as a press in this order (any spacing or line breaks between).
    expect(model).toMatch(/tapSends\s*\+=\s*1\s*;?\s*lastTapAt\s*=\s*now\(\)\s*;?\s*await\s+check\(\s*\.press\s*\)/);
  });

  // The text of one function, up to its closing brace (braces counted).
  function funcText(src: string, name: string): string {
    const at = src.search(new RegExp(`func ${name}\\(`));
    if (at < 0) return "";
    let depth = 0;
    for (let i = src.indexOf("{", at); i < src.length; i++) {
      if (src[i] === "{") depth++;
      if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
    }
    return "";
  }

  it("pickUpTap goes through tokenArrived (so through the gap and the limit) and only in front; the ends of a try call it", () => {
    expect(funcText(model, "pickUpTap")).toMatch(/await\s+tokenArrived\(\)/);
    expect(funcText(model, "pickUpTap")).toMatch(/isInFront/);
    expect(funcText(model, "check")).toMatch(/await\s+checkOnce\(trigger\)\s*await\s+pickUpTap\(\)/);
    expect(funcText(model, "resendConfirmation")).toMatch(/await\s+resendOnce\(\)\s*await\s+pickUpTap\(\)/);
  });

  it("the ends of a try keep a held tap instead of resetting the widget over it; a wait that ends lets it go", () => {
    expect(funcText(model, "checkOnce")).toMatch(/turnstile\?\.resetUnlessTapHeld\(\)/);
    expect(funcText(model, "resendOnce")).toMatch(/turnstile\?\.resetUnlessTapHeld\(\)/);
    expect(funcText(model, "checkOnce")).toMatch(/case \.credentials:\s*dropWait\(\)\s*\/\/[^\n]*\n\s*turnstile\?\.reset\(\)/);
  });

  it("negative control: the checks see a pickUpTap that skips tokenArrived, a try's end that resets, a missing pick-up", () => {
    const noCall = model.replace(/(private func pickUpTap[\s\S]*?)await tokenArrived\(\)/, "$1await check(.token)");
    expect(funcText(noCall, "pickUpTap")).not.toMatch(/await\s+tokenArrived\(\)/);
    const resets = model.replace("turnstile?.resetUnlessTapHeld()", "turnstile?.reset()");
    expect(funcText(resets, "checkOnce")).not.toMatch(/resetUnlessTapHeld/);
    const noPick = model.replace(/await resendOnce\(\)\s*await pickUpTap\(\)/, "await resendOnce()");
    expect(funcText(noPick, "resendConfirmation")).not.toMatch(/pickUpTap/);
    // Spacing alone does not break the order check.
    expect("tapSends += 1\n\n   lastTapAt = now()\nawait check(.press)").toMatch(/tapSends\s*\+=\s*1\s*;?\s*lastTapAt\s*=\s*now\(\)\s*;?\s*await\s+check\(\s*\.press\s*\)/);
  });
});
