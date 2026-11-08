import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FORWARDING_GUIDES } from "@/lib/forwarding-guide";

/**
 * 1.0 (11): the iPhone app does not show the Android paragraph of a service's linkNote. The Web's text is not changed
 * (it still has both); the comparison with the Swift text is in ios-forwarding-guide.test.ts (the Web's note minus its
 * Android paragraphs). Here: where Android is written, and that nothing of the iPhone text went with it.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const SWIFT = read("ios/Otodoke/Screens/Settings/ForwardingGuideText.swift");

const paragraphs = (note: string) => note.split("\n\n");
const withoutAndroid = (note: string) => paragraphs(note).filter((p) => !p.startsWith("Android")).join("\n\n");

describe("no Android paragraph in the iPhone app", () => {
  it("the Web still has an Android paragraph in its linkNote (the Web is not changed)", () => {
    const notes = FORWARDING_GUIDES.flatMap((g) => (g.linkNote ? [g.linkNote] : []));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.some((n) => paragraphs(n).some((p) => p.startsWith("Android")))).toBe(true);
  });

  it("Android is written only as the start of a paragraph of a linkNote, nowhere else in the Web's guide data", () => {
    for (const g of FORWARDING_GUIDES) {
      const others = [g.title, g.time, g.intro, g.link?.label, ...g.notes, ...g.groups.flatMap((x) => [x.heading, ...x.steps.map((s) => s.text)])];
      for (const text of others) expect(text ?? "", `${g.id}`).not.toContain("Android");
      for (const p of paragraphs(g.linkNote ?? "")) if (p.includes("Android")) expect(p.startsWith("Android"), g.id).toBe(true);
    }
  });

  it("the Swift text has no Android, and every iPhone paragraph of the Web note is still there", () => {
    expect(SWIFT).not.toContain("Android");
    for (const g of FORWARDING_GUIDES) {
      if (!g.linkNote) continue;
      for (const p of paragraphs(withoutAndroid(g.linkNote))) expect(SWIFT.replace(/\\n/g, "\n"), `${g.id}: ${p.slice(0, 12)}`).toContain(p);
    }
  });

  it("negative control: an Android paragraph that stays, or an iPhone paragraph that goes, is caught", () => {
    const gmail = FORWARDING_GUIDES.find((g) => g.id === "gmail")!.linkNote!;
    expect(withoutAndroid(gmail)).not.toContain("Android");
    expect(withoutAndroid(gmail)).toContain("iPhone では Safari で進めます。");
    expect(withoutAndroid(gmail)).toContain("Gmail を 2 つ以上使っている人は");
    expect(withoutAndroid(gmail)).not.toBe(gmail);
    expect(SWIFT.replace("iPhone では Safari で進めます。", "Android では Chrome で進めます。")).toContain("Android");
    expect(SWIFT.replace(/\\n\\nGmail を 2 つ以上[^"\\]*/, "")).not.toContain("Gmail を 2 つ以上");
  });
});
