/**
 * [M2+password-v1 review fix 1] What the Swift tests cannot see in a View:
 *  - SEC-N4: UnlockView's password field is emptied after every submit (opened or not) and when the app goes to
 *    the background;
 *  - B1-1: MainTabView(auth:) takes the generation's screens (MainScreens.of) and never makes them itself, and
 *    the app gives AuthService the maker once at launch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Line comments (not `//` inside a string) and block comments off. */
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      let inString = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "\\" && inString) {
          i++;
          continue;
        }
        if (c === '"') inString = !inString;
        if (!inString && c === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");

/** The body of `func name(...) {...}` (braces counted), or null. */
function funcBody(src: string, name: string): string | null {
  const start = src.search(new RegExp(`func ${name}\\(`));
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

/** SEC-N4's two checks on a source of UnlockView. */
function clearsThePassword(src: string): { afterEverySubmit: boolean; inTheBackground: boolean } {
  const submit = funcBody(src, "submit") ?? "";
  // The clear is in the task after model.submit, and not only under `if opened`.
  const afterSubmit = submit.slice(submit.indexOf("model.submit"));
  const unconditional = afterSubmit.replace(/if\s+opened\s*\{[^}]*\}/g, "");
  return {
    afterEverySubmit: /passphrase\s*=\s*""/.test(unconditional),
    inTheBackground: /onChange\(of:\s*scenePhase\)[\s\S]{0,200}\.background[\s\S]{0,80}passphrase\s*=\s*""/.test(src),
  };
}

describe("SEC-N4: the unlock's password field", () => {
  const view = () => stripComments(read("ios/Otodoke/Screens/Shared/UnlockView.swift"));

  it("is emptied after every submit and in the background", () => {
    expect(clearsThePassword(view())).toEqual({ afterEverySubmit: true, inTheBackground: true });
  });

  it("negative control: cleared only when opened, and no scenePhase, are both seen", () => {
    const before = `
      private func submit() {
        let typed = passphrase
        Task {
          let opened = await model.submit(password: typed)
          if opened {
            passphrase = ""
            onOpened()
          }
        }
      }`;
    expect(clearsThePassword(before)).toEqual({ afterEverySubmit: false, inTheBackground: false });
  });

  it("the comment stripper keeps a // inside a string", () => {
    expect(stripComments('let u = "https://otodoke.app" // note')).toBe('let u = "https://otodoke.app" ');
  });
});

describe("B1-1: the screens of a signed-in generation", () => {
  it("MainTabView(auth:) takes MainScreens.of(auth), not .live", () => {
    const src = stripComments(read("ios/Otodoke/Screens/MainTabView.swift"));
    const init = src.match(/init\(auth: AuthService\)\s*\{([\s\S]*?)\n\s{4}\}/)?.[1] ?? "";
    expect(init).toMatch(/\.of\(auth\)/);
    expect(init).not.toMatch(/\.live\(|attachKeys|cleanup|takeSignInSecret/);
  });

  it("the app gives AuthService the maker of the screens at launch", () => {
    const src = stripComments(read("ios/Otodoke/App/OtodokeApp.swift"));
    expect(src).toMatch(/makeSignedIn\s*=\s*\{\s*MainScreens\.live\(auth:\s*\$0\)\s*\}/);
  });
});
