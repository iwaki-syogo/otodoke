import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A pressable thing drawn smaller than 44×44px still takes a finger on at least 44×44px (the `tap`
 * utility in globals.css: an ::after the browser hit-tests as the element). The real check is the
 * browser one: every pressable thing on every screen, measured with elementFromPoint at 390px.
 * These hold the parts that check rests on.
 */

const ROOT = path.join(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

function sources(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) return name === "__tests__" ? [] : sources(rel);
    return rel.endsWith(".tsx") || rel.endsWith(".ts") ? [rel] : [];
  });
}

/** Every class string in the app's sources that names `tap` as a class. */
function tapClassStrings(): { file: string; classes: string[] }[] {
  const out: { file: string; classes: string[] }[] = [];
  for (const file of sources("src")) {
    const s = read(file);
    for (const m of s.matchAll(/(?:className=|const [A-Z_a-z]+ = )(?:"([^"]*)"|\{?`([^`]*)`)/g)) {
      const classes = (m[1] ?? m[2] ?? "").split(/\s+/).filter(Boolean);
      if (classes.includes("tap")) out.push({ file, classes });
    }
  }
  return out;
}

describe("the 44px hit area", () => {
  const css = read("src/app/globals.css");
  const utility = css.slice(css.indexOf("@utility tap"));

  it("is at least 44×44px, centred on the element, and does not move anything", () => {
    expect(utility).toMatch(/^@utility tap \{\n  position: relative;\n  &::after \{/);
    expect(utility).toContain('content: "";');
    expect(utility).toContain("position: absolute;");
    expect(utility).toContain("width: max(100%, 44px);");
    expect(utility).toContain("height: max(100%, 44px);");
    expect(utility).toContain("transform: translate(-50%, -50%);");
    // Nothing that changes how the element is drawn or laid out.
    const block = utility.slice(0, utility.indexOf("\n}\n") + 2);
    expect(block).not.toMatch(/margin|padding|min-height|min-width|z-index|background|border|display/);
  });

  it("is on the buttons of the 外す flow and the parcel page's receipt buttons", () => {
    const P = "src/app/app/parcels/[id]/";
    for (const [file, label] of [
      [P + "not-parcel-button.tsx", "外す"],
      [P + "mark-delivered-button.tsx", "受け取った"],
      [P + "not-delivered-button.tsx", "届いていない"],
      [P + "not-received-button.tsx", "受け取り済みを取り消す"],
      ["src/app/app/excluded/restore-button.tsx", "一覧に戻す"],
    ] as const) {
      expect(read(file), label).toMatch(/<PendingButton[\s\S]*?className="tap /);
    }
    // 元に戻す in the notice.
    expect(read("src/app/app/delivered-controls.tsx")).toContain('tone="light" onClick={undo} className="tap ');
  });

  it("keeps 16px between 受け取った and 外す, so their areas do not meet (30px and 28px drawn: 7 + 8 < 16)", () => {
    const page = read("src/app/app/parcels/[id]/page.tsx");
    expect(page).toContain('<div className="-mt-2">\n          <NotParcelButton');
    // The page's gap-6 (24px) less 8px.
    expect(page).toContain('<article className="flex flex-col gap-6">');
  });

  it("is never on an element placed with absolute/fixed/sticky (the utility would make it relative)", () => {
    const found = tapClassStrings();
    expect(found.length).toBeGreaterThan(40);
    const placed = found.filter(({ classes }) => classes.some((c) => c === "absolute" || c === "fixed" || c === "sticky" || c === "static"));
    expect(placed).toEqual([]);
  });

  it("detects a tap on an absolute element (negative control)", () => {
    const s = 'className="tap absolute inset-0"';
    const m = [...s.matchAll(/(?:className=)(?:"([^"]*)")/g)][0];
    expect(m[1].split(" ")).toEqual(expect.arrayContaining(["tap", "absolute"]));
  });

  it("the month picker's invisible input is at least 44px tall, centred on the month", () => {
    expect(read("src/app/app/month-picker.tsx")).toContain(
      'className="absolute left-0 top-1/2 h-[max(100%,2.75rem)] w-full -translate-y-1/2 cursor-pointer text-base opacity-0"',
    );
  });

  it("the swipe faces' buttons fill the face's height", () => {
    const c = read("src/app/app/delivered-controls.tsx");
    expect(c).toContain("flex w-full self-stretch items-center justify-start gap-2");
    expect(c).toContain("flex w-full self-stretch items-center justify-end gap-2");
  });
});
