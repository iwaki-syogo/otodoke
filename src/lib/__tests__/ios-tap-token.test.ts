import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS b7-tap] A token made by a person's tap on the Turnstile check tries the waiting screen at once. The widget
 * page tells Swift that it asks for a tap (before-interactive-callback, Cloudflare's widget configurations); the
 * kind it posts must be the one the Swift notice reads, and the model must read the mark through takeTap().
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
    expect(model).toMatch(/turnstile\?\.takeTap\(\)/);
    expect(model).toMatch(/tapped \? \.press : \.token/);
  });
});
