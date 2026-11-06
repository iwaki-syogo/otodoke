import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { identifyCarrier, normalizeTracking } from "@/lib/carriers";

/**
 * fixtures/demo is public. Its tracking numbers must not pass the mod-7 check digit that Yamato,
 * Sagawa and Japan Post use (a number that passes could belong to a real parcel), and the Amazon
 * mails must not carry the "buy it again" recommendation block (it lists the account's past purchases).
 */
const DEMO = path.join(process.cwd(), "fixtures", "demo");

function passesMod7(digits: string): boolean {
  return Number(digits.slice(0, -1)) % 7 === Number(digits.slice(-1));
}

const extractions = JSON.parse(readFileSync(path.join(DEMO, "extractions.json"), "utf8")) as Record<string, { tracking_number?: { value: string | null } }>;
const trackingNumbers = [...new Set(Object.values(extractions).map((x) => x.tracking_number?.value ?? null).filter((v): v is string => !!v))];

describe("demo fixtures are safe to publish", () => {
  it("has tracking numbers to check", () => {
    expect(trackingNumbers.length).toBe(4);
  });

  it.each(trackingNumbers)("tracking number %s does not pass the mod-7 check digit", (n) => {
    const digits = normalizeTracking(n);
    expect(digits).toMatch(/^\d{12}$/);
    expect(passesMod7(digits)).toBe(false);
  });

  it.each(trackingNumbers)("tracking number %s is still read as a bare 12-digit number: the carrier comes from the mail", (n) => {
    expect(identifyCarrier(n).key).toBe("unknown");
    expect(identifyCarrier(n, "ヤマト運輸").key).toBe("yamato");
    expect(identifyCarrier(n, "佐川急便").key).toBe("sagawa");
  });

  it("keeps no recommendation block in any demo mail", () => {
    for (const f of readdirSync(path.join(DEMO, "mails"))) {
      const mail = JSON.parse(readFileSync(path.join(DEMO, "mails", f), "utf8")) as { text: string | null; html: string | null };
      for (const body of [mail.text, mail.html]) {
        expect(body ?? "", f).not.toMatch(/もう一度買う|この商品を見た|おすすめ商品/);
      }
      // product images of the recommendation block were the only ones with this size suffix
      expect(mail.html ?? "", f).not.toContain("_SR276,276_");
    }
  });

  describe("whole fixture set", () => {
    type Mail = { text: string | null; html: string | null; subject: string; message_id: string | null; date: string | null };
    const files = readdirSync(path.join(DEMO, "mails"));
    const mails = files.map((f) => ({ f, mail: JSON.parse(readFileSync(path.join(DEMO, "mails", f), "utf8")) as Mail }));
    const expectedRaw = readFileSync(path.join(DEMO, "expected.json"), "utf8");

    it("has all 17 mails", () => {
      expect(mails.length).toBe(17);
    });

    it("carries no 12-digit tracking-shaped number that passes the mod-7 check digit (digits, hyphens and spaces)", () => {
      const sources = [{ name: "expected.json", body: expectedRaw }, ...mails.flatMap(({ f, mail }) => [
        { name: `${f} text`, body: mail.text ?? "" },
        { name: `${f} html`, body: mail.html ?? "" },
        { name: `${f} subject`, body: mail.subject },
      ])];
      const bad: string[] = [];
      let seen12 = 0;
      for (const { name, body } of sources) {
        for (const m of body.matchAll(/\d+(?:[-\s]\d+)*/g)) {
          const digits = normalizeTracking(m[0]);
          if (digits.length !== 12) continue;
          seen12++;
          if (passesMod7(digits)) bad.push(`${name}: ${m[0]}`);
        }
      }
      expect(seen12).toBeGreaterThan(0);
      expect(bad).toEqual([]);
    });

    it("uses made-up Message-IDs only", () => {
      for (const { f, mail } of mails) expect(mail.message_id, f).toMatch(/^<demo-[0-9a-f]+@example\.invalid>$/);
    });

    it("has send times rounded to the minute (seconds are 00)", () => {
      for (const { f, mail } of mails) expect(mail.date, f).toMatch(/T\d{2}:\d{2}:00(\+00:00|Z|[+-]\d{2}:\d{2})$/);
    });

    it("keeps no removed-block wording in the extraction notes", () => {
      const text = JSON.stringify(Object.values(extractions).map((x) => (x as { notes?: unknown }).notes ?? null));
      expect(text).not.toMatch(/もう一度買う|おすすめ|この商品を見た/);
    });
  });
});
