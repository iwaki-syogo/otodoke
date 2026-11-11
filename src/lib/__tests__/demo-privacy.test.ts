import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { identifyCarrier, normalizeTracking } from "@/lib/carriers";
import { decodeEntities } from "@/lib/text/html-to-text";

/**
 * fixtures/demo is public. Its tracking numbers must not pass the mod-7 check digit that Yamato,
 * Sagawa and Japan Post use (a number that passes could belong to a real parcel), and the Amazon
 * mails must not carry the "buy it again" recommendation block (it lists the account's past purchases).
 */
const DEMO = path.join(process.cwd(), "fixtures", "demo");

/** Every public fixture, including saved extraction strings. Private evaluation sets stay unread. */
function publicFixtures(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["raw", "anonymized"].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? publicFixtures(file) : [file];
  });
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

/** Enumerate quoted/unquoted href/src attributes and inline or stylesheet CSS references. */
function fixtureUrls(text: string): string[] {
  const urls: string[] = [];
  const source = decodeEntities(text);
  for (const m of source.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    urls.push(m[1] ?? m[2] ?? m[3]);
  }
  for (const m of source.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi)) {
    urls.push(m[1] ?? m[2] ?? m[3]);
  }
  return urls.filter(Boolean);
}

/** Return only a reason: a failing public-data check must not print a newly introduced private URL. */
function privateUrlReason(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw, "https://example.invalid"); } catch { return "invalid URL"; }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)s3(?:[.\-][a-z0-9.\-]+)?\.amazonaws\.com$/.test(host)) return "delivery photo";
  if (/(^|\.)(ml\.kuronekoyamato\.co\.jp|toi\.kuronekoyamato\.co\.jp|k2k\.sagawa-exp\.co\.jp|trackings\.post\.japanpost\.jp)$/.test(host)
      || (/(^|\.)amazon\.co\.jp$/.test(host) && u.pathname === "/gp/r.html")
      || (host === "member.kms.kuronekoyamato.co.jp" && u.pathname.startsWith("/parcel/detail"))) return "tracking link";
  const privateKey = /(?:token|signature|credential|secret|password|tracking|recipient|email|(?:^|[_-])(?:auth|key|uid|ref|ref_)(?:$|[_-])|^x-amz-)/i;
  if ([...u.searchParams.keys()].some((key) => privateKey.test(key))
      || privateKey.test(u.hash) && /[=:]/.test(u.hash)) return "URL token";
  const publicImage = /(^|\.)(media-amazon\.com|rakuten-static\.com|r10s\.jp)$/.test(host) && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(u.pathname);
  if (!publicImage && u.pathname.split("/").some((part) => /^[A-Za-z0-9_=-]{24,}$/.test(part))) return "opaque URL token";
  return null;
}

const fixtureSources = publicFixtures(path.join(process.cwd(), "fixtures")).flatMap((file) => {
  const raw = readFileSync(file, "utf8");
  return (file.endsWith(".json") ? stringsIn(JSON.parse(raw)) : [raw]).map((body) => ({ file: path.relative(process.cwd(), file), body }));
});

function passesMod7(digits: string): boolean {
  return Number(digits.slice(0, -1)) % 7 === Number(digits.slice(-1));
}

const extractions = JSON.parse(readFileSync(path.join(DEMO, "extractions.json"), "utf8")) as Record<string, { tracking_number?: { value: string | null } }>;
const trackingNumbers = [...new Set(Object.values(extractions).map((x) => x.tracking_number?.value ?? null).filter((v): v is string => !!v))];

describe("demo fixtures are safe to publish", () => {
  it("enumerates every public fixture's href, src and CSS URLs without private references", () => {
    const urls = fixtureSources.flatMap(({ file, body }) => fixtureUrls(body).map((url) => ({ file, reason: privateUrlReason(url) })));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((x) => x.reason !== null)).toEqual([]);
  });

  it("detects a made-up 44-character delivery photo path in href, src and CSS", () => {
    const photo = `https://jp-prod-temp.s3.us-west-2.amazonaws.com/${"a".repeat(44)}`;
    const html = `<a href="${photo}"><img src='${photo}'></a><style>.photo { background: url(${photo}); }</style>`;
    expect(fixtureUrls(html)).toHaveLength(3);
    expect(fixtureUrls(html).map(privateUrlReason)).toEqual(["delivery photo", "delivery photo", "delivery photo"]);
  });

  it("detects tracking links and tokens including escaped query strings and unquoted attributes", () => {
    const html = '<a href="https://www.amazon.co.jp/gp/r.html">shop</a><img src=https://url536.ml.kuronekoyamato.co.jp/wf/open><a href="https://example.invalid/image?width=100&amp;token=fake">photo</a><div style="background:url(\'https://example.invalid/abcdefghijklmnopqrstuvwxyz\')"></div>';
    expect(fixtureUrls(html).map(privateUrlReason)).toEqual(["tracking link", "tracking link", "URL token", "opaque URL token"]);
  });

  it("allows made-up local images and public shop logos", () => {
    const html = '<img src="/demo/delivery-placeholder.svg"><img src="https://example.invalid/images/made-up.png"><img src="https://m.media-amazon.com/images/G/09/store-logo.png"><style>.logo{background:url("/demo/shop-logo.svg")}</style>';
    expect(fixtureUrls(html)).toHaveLength(4);
    expect(fixtureUrls(html).map(privateUrlReason)).toEqual([null, null, null, null]);
  });

  it("the anonymizer removes delivery photos and tracking URLs rather than scrambling their paths", () => {
    const result = execFileSync("python3", ["-c", `
import json, runpy
module = runpy.run_path("scripts/anonymize.py")
anon = module["Anonymizer"]({"salt": "made-up-test", "seeds": {}})
photo = "https://jp-prod-temp.s3.us-west-2.amazonaws.com/" + "a" * 44
unsafe = [photo, "https://url536.ml.kuronekoyamato.co.jp/wf/open?token=fake", "https://www.amazon.co.jp/gp/r.html?ref_=fake", "https://member.kms.kuronekoyamato.co.jp/parcel/detail?tracking=fake"]
safe = "https://m.media-amazon.com/images/G/09/store-logo.png"
print(json.dumps({"removed": [anon._urls(url) == "" for url in unsafe], "logoKept": anon._urls(safe) == safe}))
`], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(JSON.parse(result)).toEqual({ removed: [true, true, true, true], logoKept: true });
  });

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
