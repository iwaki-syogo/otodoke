import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Review follow-ups in client screens, checked in their source (the tests run without a DOM):
 * [QA-5] Esc returns focus to the opener, [N3] the category chip keeps the choice until new
 * props arrive, [N4] the calendar tells a failed read apart from an empty month.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, "../../app/app", rel), "utf8");

describe("[QA-5] the Sagawa popup", () => {
  const source = read("parcels/[id]/tracking-button.tsx");

  it("returns focus to 追跡ページを開く when closed with Esc", () => {
    expect(source).toMatch(/if \(e\.key === "Escape"\) \{\s*setOpen\(false\);\s*opener\.current\?\.focus\(\);\s*\}/);
  });
});

describe("[N3] the category chip", () => {
  const source = read("category-sheet.tsx");

  it("shows the choice from the tap until the props move on, not only while saving", () => {
    expect(source).toContain("const shown = picked && picked.from === current ? picked.value : current;");
    expect(source).not.toMatch(/shown = pending/);
    expect(source).toContain("setPicked({ value: c, from: current });");
  });

  it("goes back to the stored value when the save fails", () => {
    expect(source.match(/setPicked\(null\);\s*setError\(/g)).toHaveLength(2);
  });
});

describe("[N4] the calendar", () => {
  const source = read("calendar/page.tsx");

  it("says 読み込めませんでした when the read fails, apart from an empty month", () => {
    expect(source).toMatch(/const \{ data, error \} = await supabase/);
    expect(source).toMatch(/failed \? \(\s*<p[^>]*>読み込めませんでした<\/p>/);
    expect(source).toContain("この月の予定はありません");
  });
});
