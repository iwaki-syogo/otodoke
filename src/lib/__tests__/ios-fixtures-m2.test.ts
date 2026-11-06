import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromBase64, fromUtf8 } from "@/lib/crypto/bytes";
import { keyIdOf, mailAad, openBytes, openMail, parseEnvelope, WrongKeyError, type PrivateRecipient } from "@/lib/crypto/envelope";
import {
  NO_ORDER_DATE_LABEL,
  SEARCH_MAX,
  deliveredFilterOptions,
  filterDelivered,
  groupByOrderMonth,
  itemNamesByParcel,
  monthChoices,
  searchWord,
} from "@/lib/delivered";
import type { ParcelRow } from "@/lib/match";
import { normalizeShop } from "@/lib/shop";

/**
 * [iOS batch 2, task 13] What scripts/ios-fixtures.ts adds for M2:
 *  - the crypto vectors for the iOS app, written outside git (ios/OtodokeTests/Fixtures/crypto/, ignored by
 *    ios/.gitignore): envelope-v1.json is fixtures/crypto/envelope-v1.json byte for byte (never copied by
 *    hand), negative-v1.json holds envelopes made with the Web's own sealBytes (its test injection) whose
 *    plaintext is wrong: a key missing, v = 2, bytes that are not UTF-8. .gitleaks.toml is not changed;
 *  - the delivered section of web-expected.json (WebParity4Tests decodes it through WebExpectedM2.swift):
 *    groupByOrderMonth, NO_ORDER_DATE_LABEL, itemNamesByParcel, searchWord (trim, SEARCH_MAX), filterDelivered
 *    (NFKC and toLowerCase on the title, the shop and the item names), deliveredFilterOptions, monthChoices.
 *
 * The CLI contract:
 *   tsx scripts/ios-fixtures.ts                      writes web-expected.json and the vectors (default places)
 *   tsx scripts/ios-fixtures.ts --stdout             prints web-expected.json only (never a vector)
 *   tsx scripts/ios-fixtures.ts --crypto-out <dir>   writes only the two vector files, into <dir>
 * The sealBytes injection needs NODE_ENV=test (vitest passes it on to the script).
 */

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts/ios-fixtures.ts");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const SOURCE = path.join(ROOT, "fixtures/crypto/envelope-v1.json");
const IOS_CRYPTO = "ios/OtodokeTests/Fixtures/crypto";
/** The last commit of M1: the sections from before M2 must come out as they were then. */
const M1_COMMIT = "163d35f";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const V = JSON.parse(readFileSync(SOURCE, "utf8"));
const E = V.envelope;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

async function vectorRecipient(): Promise<PrivateRecipient> {
  const raw = fromBase64(E.recipient.public_key);
  return { keyId: await keyIdOf(raw), publicKey: raw, privateKey: await crypto.subtle.importKey("pkcs8", fromBase64(E.recipient.private_key_pkcs8), ECDH, false, ["deriveBits"]) };
}

let tmp = "";
let fx: Any = null;
let stdout = "";

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "otodoke-ios-crypto-"));
  stdout = execFileSync(TSX, [SCRIPT, "--stdout"], { cwd: ROOT, env: { ...process.env, TZ: "UTC" }, encoding: "utf8", timeout: 60_000 });
  fx = JSON.parse(stdout);
  execFileSync(TSX, [SCRIPT, "--crypto-out", tmp], { cwd: ROOT, env: { ...process.env, TZ: "UTC" }, encoding: "utf8", timeout: 60_000 });
}, 180_000);

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** The comparison the byte test uses. */
function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

describe("task 13: the crypto vectors for iOS", () => {
  it("--crypto-out writes exactly the two vector files", () => {
    expect(readdirSync(tmp).sort()).toEqual(["envelope-v1.json", "negative-v1.json"]);
  });

  it("envelope-v1.json is the canonical file byte for byte", () => {
    expect(sameBytes(readFileSync(path.join(tmp, "envelope-v1.json")), readFileSync(SOURCE))).toBe(true);
  });

  it("negative control: one byte changed is not the same", () => {
    const copy = Buffer.from(readFileSync(path.join(tmp, "envelope-v1.json")));
    expect(copy.length).toBeGreaterThan(100);
    copy[100] ^= 0x01;
    expect(sameBytes(copy, readFileSync(SOURCE))).toBe(false);
    expect(sameBytes(copy.subarray(0, copy.length - 1), readFileSync(SOURCE))).toBe(false);
  });

  it("the default place is ignored by git (the vectors never show in git status)", () => {
    for (const name of ["envelope-v1.json", "negative-v1.json"]) {
      const file = `${IOS_CRYPTO}/${name}`;
      // Exit 0 = ignored; anything else throws.
      expect(() => execFileSync("git", ["check-ignore", "-q", file], { cwd: ROOT })).not.toThrow();
    }
    const tracked = execFileSync("git", ["ls-files", IOS_CRYPTO], { cwd: ROOT, encoding: "utf8" });
    expect(tracked.trim()).toBe("");
  });

  it("no vector goes into web-expected.json (it is committed; the vectors are not)", () => {
    const committed = readFileSync(path.join(ROOT, "ios/OtodokeTests/Fixtures/web-expected.json"), "utf8");
    for (const secret of [E.recipient.private_key_pkcs8, E.recipient.private_key_d, E.ephemeral.private_key_d, E.envelope.ct, V.key_wrap.wrapped_private_key, V.key_wrap.kek, E.aes_key]) {
      expect(stdout).not.toContain(secret);
      expect(committed).not.toContain(secret);
    }
  });

  it(".gitleaks.toml still allows only package-lock.json and the canonical vector file", () => {
    const toml = readFileSync(path.join(ROOT, ".gitleaks.toml"), "utf8");
    const paths = [...(toml.match(/paths\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/'''(.*?)'''/g)].map((m) => m[1]);
    expect(paths).toEqual(["package-lock\\.json", "^fixtures/crypto/envelope-v1\\.json$", "^fixtures/crypto/password-v1\\.json$"]);
  });
});

describe("task 13: the negative vectors are made by the Web's own functions", () => {
  const negatives = (): Any => JSON.parse(readFileSync(path.join(tmp, "negative-v1.json"), "utf8"));
  const FIELDS = ["subject", "from_name", "from_address", "text", "html"];

  it("names the three cases, each sealed to the vector's key with the vector's ids", () => {
    const n = negatives();
    expect(n.mail.map((m: Any) => m.name).sort()).toEqual(["bad_utf8", "missing_key", "version_2"]);
    for (const m of n.mail) {
      expect(Object.keys(m).sort(), m.name).toEqual(["aad", "email_id", "envelope", "name", "user_id"]);
      expect(m.user_id).toBe(E.user_id);
      expect(m.email_id).toBe(E.email_id);
      expect(m.aad).toBe(mailAad(E.user_id, E.email_id));
      expect(parseEnvelope(m.envelope).kid).toBe(E.recipient.key_id);
      // Not the positive vector again.
      expect(m.envelope.ct).not.toBe(E.envelope.ct);
    }
  });

  it("each opens as bytes (the crypto is sound) and is refused as mail (the plaintext is not)", async () => {
    const r = await vectorRecipient();
    for (const m of negatives().mail) {
      const bytes = await openBytes(r, m.aad, m.envelope);
      expect(bytes.length, m.name).toBeGreaterThan(0);
      const refused = await openMail(r, m.user_id, m.email_id, m.envelope).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused, m.name).toBeInstanceOf(Error);
      expect(refused, m.name).not.toBeInstanceOf(WrongKeyError);
    }
  });

  it("what is wrong in each is what the name says", async () => {
    const r = await vectorRecipient();
    const byName = Object.fromEntries(negatives().mail.map((m: Any) => [m.name, m]));
    const open = (name: string) => openBytes(r, byName[name].aad, byName[name].envelope);

    expect(() => fromUtf8(new Uint8Array(0))).not.toThrow();
    const bad = await open("bad_utf8");
    expect(() => fromUtf8(bad)).toThrow();

    const missing = JSON.parse(fromUtf8(await open("missing_key")));
    expect(missing.v).toBe(1);
    expect(FIELDS.filter((f) => !(f in missing))).toHaveLength(1);
    for (const f of FIELDS) if (f in missing) expect(missing[f] === null || typeof missing[f] === "string", f).toBe(true);

    const v2 = JSON.parse(fromUtf8(await open("version_2")));
    expect(v2.v).toBe(2);
    for (const f of FIELDS) expect(v2[f] === null || typeof v2[f] === "string", f).toBe(true);
  });

  it("the positive vector still opens with the Web's function (the negatives are not the positive broken by hand)", async () => {
    const r = await vectorRecipient();
    expect(await openMail(r, E.user_id, E.email_id, E.envelope)).toEqual(E.plaintext_object);
  });
});

// ---------------------------------------------------------------------------------------------

const PARCEL_COLUMNS = [
  "carrier", "category", "category_source", "created_at", "expected_date", "expected_date_end", "expected_text",
  "expected_window_end", "expected_window_start", "id", "last_email_at", "needs_review", "order_number", "ordered_at",
  "presence_evidence", "requires_presence", "shop", "shop_key", "source", "status", "title", "total_amount",
  "tracking_number", "tracking_url", "updated_at", "user_id",
];

/** Every entry has exactly these keys (null written out, never undefined: Swift decodes them). */
function fields(xs: Any[], keys: string[]) {
  expect(Array.isArray(xs)).toBe(true);
  expect(xs.length).toBeGreaterThan(0);
  for (const x of xs) expect(Object.keys(x).sort(), JSON.stringify(x).slice(0, 160)).toEqual([...keys].sort());
}

const ids = (xs: ParcelRow[]) => xs.map((p) => p.id);
const values = (c: Any) => ({ q: c.q ?? undefined, s: c.s ?? undefined, c: c.c ?? undefined, m: c.m ?? undefined });
const names = (items: Array<{ parcel_id: string; name: string }>) => itemNamesByParcel(items);

describe("task 13: the delivered section: names", () => {
  it("is a top-level key with the agreed sub-keys", () => {
    expect(Object.keys(fx.delivered).sort()).toEqual(
      ["noOrderDateLabel", "searchMax", "groupByOrderMonth", "itemNamesByParcel", "searchWord", "filterDelivered", "deliveredFilterOptions", "monthChoices"].sort(),
    );
    expect(fx.delivered.noOrderDateLabel).toBe(NO_ORDER_DATE_LABEL);
    expect(fx.delivered.searchMax).toBe(SEARCH_MAX);
  });

  it("has entries with the agreed field names", () => {
    const d = fx.delivered;
    fields(d.groupByOrderMonth, ["parcels", "out"]);
    for (const c of d.groupByOrderMonth) for (const g of c.out) expect(Object.keys(g).sort()).toEqual(["ids", "label"]);
    fields(d.itemNamesByParcel, ["items", "out"]);
    for (const c of d.itemNamesByParcel) for (const it of c.items) expect(Object.keys(it).sort()).toEqual(["name", "parcel_id"]);
    fields(d.searchWord, ["q", "out"]);
    fields(d.filterDelivered, ["parcels", "items", "q", "s", "c", "m", "out"]);
    fields(d.deliveredFilterOptions, ["parcels", "out"]);
    for (const c of d.deliveredFilterOptions) expect(Object.keys(c.out).sort()).toEqual(["categories", "months", "shops"]);
    fields(d.monthChoices, ["months", "m", "out"]);
  });

  it("writes whole parcel rows (every column), so Swift decodes them as ParcelRow", () => {
    const d = fx.delivered;
    const rows: Any[] = [...d.groupByOrderMonth, ...d.filterDelivered, ...d.deliveredFilterOptions].flatMap((c: Any) => c.parcels);
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual([...PARCEL_COLUMNS].sort());
  });
});

describe("task 13: every delivered out is what the Web's own function answers", () => {
  it("groupByOrderMonth", () => {
    for (const c of fx.delivered.groupByOrderMonth) {
      expect(c.out).toEqual(groupByOrderMonth(c.parcels as ParcelRow[]).map((g) => ({ label: g.label, ids: ids(g.parcels) })));
    }
  });

  it("itemNamesByParcel", () => {
    for (const c of fx.delivered.itemNamesByParcel) expect(c.out).toEqual(Object.fromEntries(names(c.items)));
  });

  it("searchWord", () => {
    for (const c of fx.delivered.searchWord) expect(c.out).toBe(searchWord(c.q ?? undefined));
  });

  it("filterDelivered", () => {
    for (const c of fx.delivered.filterDelivered) expect(c.out).toEqual(ids(filterDelivered(c.parcels as ParcelRow[], names(c.items), values(c))));
  });

  it("deliveredFilterOptions", () => {
    for (const c of fx.delivered.deliveredFilterOptions) expect(c.out).toEqual(deliveredFilterOptions(c.parcels as ParcelRow[]));
  });

  it("monthChoices", () => {
    for (const c of fx.delivered.monthChoices) expect(c.out).toEqual(monthChoices(c.months, c.m ?? undefined));
  });
});

describe("task 13: the delivered cases the plan asks for are there", () => {
  const d = () => fx.delivered;

  it("groupByOrderMonth: several months, a year boundary, ties kept in input order, undated last (null and malformed)", () => {
    const cases: Any[] = d().groupByOrderMonth;
    expect(cases.some((c) => c.out.length >= 3)).toBe(true);
    expect(cases.some((c) => c.out.some((g: Any) => g.label.startsWith("2025年12月")) && c.out.some((g: Any) => g.label.startsWith("2026年1月")))).toBe(true);
    expect(cases.some((c) => c.out.at(-1)?.label === NO_ORDER_DATE_LABEL)).toBe(true);
    const ordered = cases.flatMap((c) => c.parcels.map((p: Any) => p.ordered_at));
    expect(ordered).toContain(null);
    expect(ordered.some((o: Any) => typeof o === "string" && !/^\d{4}-\d{2}/.test(o))).toBe(true);
    // Two parcels with the same ordered_at, in an order the sort must keep (stable).
    expect(
      cases.some((c) => {
        const seen = new Map<string, number>();
        for (const p of c.parcels) if (p.ordered_at) seen.set(p.ordered_at, (seen.get(p.ordered_at) ?? 0) + 1);
        return [...seen.values()].some((n) => n >= 2);
      }),
    ).toBe(true);
    expect(cases.some((c) => c.parcels.length === 0)).toBe(true);
  });

  it("searchWord: null, spaces only, a full-width space trimmed, exactly SEARCH_MAX and over it", () => {
    const qs: Array<string | null> = d().searchWord.map((c: Any) => c.q);
    expect(qs).toContain(null);
    expect(qs.some((q) => q !== null && q.length > 0 && q.trim() === "")).toBe(true);
    expect(qs.some((q) => q !== null && /^　|　$/.test(q))).toBe(true);
    expect(qs.some((q) => q !== null && q.trim().length === SEARCH_MAX)).toBe(true);
    expect(qs.some((q) => q !== null && q.trim().length > SEARCH_MAX)).toBe(true);
    // A word whose cut falls between two halves of a surrogate pair is left to filterDelivered's cases:
    // every out here is well-formed text (Swift's String cannot hold a lone surrogate).
    for (const c of d().searchWord) expect(c.out.isWellFormed(), JSON.stringify(c.q)).toBe(true);
  });

  it("filterDelivered: NFKC and toLowerCase on the word, the title, the shop and the item names", () => {
    const cases: Any[] = d().filterDelivered;
    const qs = cases.map((c) => c.q ?? "");
    // full-width Latin, half-width katakana, a compatibility character, a capital sigma, a dotted capital I
    expect(qs.some((q) => /[Ａ-Ｚａ-ｚ]/.test(q))).toBe(true);
    expect(qs.some((q) => /[ｦ-ﾟ]/.test(q))).toBe(true);
    expect(qs.some((q) => /[①-⓿㌀-㏿Ⅰ-ⅿ]/.test(q))).toBe(true);
    expect(qs.some((q) => /[ΣΣσς]/.test(q))).toBe(true);
    expect(qs.some((q) => q.includes("İ"))).toBe(true);
    // Some case is found only through an item name (without the items it is not).
    expect(cases.some((c) => c.out.length > 0 && filterDelivered(c.parcels, new Map(), values(c)).length < c.out.length)).toBe(true);
    // Some case is found only through the shop normalized (Amazon by shop_key).
    expect(cases.some((c) => c.parcels.some((p: Any) => p.shop_key === "amazon" && normalizeShop(p) !== p.shop))).toBe(true);
    // Some case is found only because the word was folded (a plain includes() finds fewer).
    expect(
      cases.some((c) => {
        const word = searchWord(c.q ?? undefined);
        if (!word) return false;
        const plain = c.parcels.filter((p: Any) => [p.title ?? "", p.shop, normalizeShop(p), ...(names(c.items).get(p.id) ?? [])].some((t: string) => t.includes(word)));
        return plain.length < c.out.length;
      }),
    ).toBe(true);
  });

  it("filterDelivered: values that cannot narrow are left out, and the conditions combine", () => {
    const cases: Any[] = d().filterDelivered;
    const all = (c: Any) => c.out.length === c.parcels.length;
    expect(cases.some((c) => c.s !== null && !c.parcels.some((p: Any) => normalizeShop(p) === c.s) && all(c))).toBe(true); // unknown shop
    expect(cases.some((c) => c.c === "none")).toBe(true); // 未分類
    expect(cases.some((c) => c.c !== null && c.c !== "none" && c.c !== "" && all(c) && c.q === null && c.s === null && c.m === null)).toBe(true); // unknown category
    expect(cases.some((c) => c.m !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(c.m) && all(c))).toBe(true); // malformed month
    expect(cases.some((c) => [c.q, c.s, c.c, c.m].filter((v) => v !== null && v !== "").length >= 3)).toBe(true);
    expect(cases.some((c) => (c.q ?? "").trim().length > SEARCH_MAX)).toBe(true);
    expect(cases.some((c) => c.q !== null && c.q !== "" && c.out.length === 0)).toBe(true); // 見つかりません
  });

  it("deliveredFilterOptions: counts tied (code-unit order), Amazon by shop_key, malformed months left out", () => {
    const cases: Any[] = d().deliveredFilterOptions;
    expect(
      cases.some((c) => {
        const counts = new Map<string, number>();
        for (const p of c.parcels) counts.set(normalizeShop(p), (counts.get(normalizeShop(p)) ?? 0) + 1);
        const n = [...counts.values()];
        return new Set(n).size < n.length;
      }),
    ).toBe(true);
    expect(cases.some((c) => c.parcels.some((p: Any) => p.shop_key === "amazon"))).toBe(true);
    expect(cases.some((c) => c.parcels.some((p: Any) => typeof p.ordered_at === "string" && !/^\d{4}-(0[1-9]|1[0-2])/.test(p.ordered_at)))).toBe(true);
  });

  it("monthChoices: m in the data, m added, m malformed, no m", () => {
    const cases: Any[] = d().monthChoices;
    expect(cases.some((c) => c.m && c.months.includes(c.m))).toBe(true);
    expect(cases.some((c) => c.m && !c.months.includes(c.m) && c.out.includes(c.m))).toBe(true);
    expect(cases.some((c) => c.m && !c.out.includes(c.m))).toBe(true);
    expect(cases.some((c) => c.m === null)).toBe(true);
  });
});

describe("task 13: the sections from before M2 come out as they did at the end of M1", () => {
  it(`every key of web-expected.json at ${M1_COMMIT} is unchanged`, () => {
    const before = JSON.parse(execFileSync("git", ["show", `${M1_COMMIT}:ios/OtodokeTests/Fixtures/web-expected.json`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    for (const key of Object.keys(before)) {
      if (key === "carriers") continue;
      expect(fx[key], key).toEqual(before[key]);
    }
    // carriers: the Web's ded1789 (review R2-3, "No." labels and signs such as № ①) appended cases to each of
    // its lists. Every case from M1 still comes out the same, in the same place; only new ones follow.
    expect(Object.keys(fx.carriers)).toEqual(Object.keys(before.carriers));
    for (const [list, cases] of Object.entries(before.carriers as Record<string, unknown[]>)) {
      expect(fx.carriers[list].length, `carriers.${list}`).toBeGreaterThanOrEqual(cases.length);
      expect(fx.carriers[list].slice(0, cases.length), `carriers.${list}`).toEqual(cases);
    }
    expect(Object.keys(fx).filter((k) => !(k in before))).toEqual(["delivered"]);
  });

  it("the committed file holds the delivered section (regenerated, not hand-written)", () => {
    expect(existsSync(path.join(ROOT, "ios/OtodokeTests/Fixtures/web-expected.json"))).toBe(true);
    const committed = JSON.parse(readFileSync(path.join(ROOT, "ios/OtodokeTests/Fixtures/web-expected.json"), "utf8"));
    expect(committed.delivered).toBeDefined();
    expect(committed.delivered).toEqual(fx.delivered);
  });
});
