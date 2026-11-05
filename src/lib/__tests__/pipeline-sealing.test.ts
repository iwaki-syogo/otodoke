import { afterEach, describe, expect, it, vi } from "vitest";
import { processInboundEmail, type InboundEmail } from "@/lib/pipeline";
import { toBase64 } from "@/lib/crypto/bytes";
import { openMail, type PrivateRecipient } from "@/lib/crypto/envelope";
import { createKeyPair } from "@/lib/crypto/key-wrap";
import { FakeDb, type Row } from "./fake-db";
import { OTHER, USER, asAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const PLAINTEXT_COLUMNS = ["subject", "from_name", "from_address", "text_body", "html_body"] as const;

/** A user with a key in use, as user_keys holds it, and the private half for the test to open with. */
async function keyedUser(db: FakeDb, userId = USER): Promise<PrivateRecipient> {
  const k = await createKeyPair();
  db.rows("user_keys").push({
    user_id: userId,
    key_id: k.keyId,
    public_key: toBase64(k.publicKey),
    wrapped_private_key: "unused-here",
    wrap_iv: "",
    kdf_salt: "",
    kdf_iterations: 600000,
    challenge_hash: "0".repeat(64),
    activated_at: "2026-11-01T00:00:00Z",
    retired_at: null,
  });
  return { keyId: k.keyId, publicKey: k.publicKey, privateKey: await crypto.subtle.importKey("pkcs8", k.pkcs8, ECDH, false, ["deriveBits"]) };
}

const order = reading({ relevance: "order", order_number: sure("ORD-55550000"), items: [item("テスト商品", 1200)], total_amount: sure(1200) });

function realMail(over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    ...mailOf("2026-11-03T01:00:00Z"),
    messageId: "<m1@example.test>",
    from: "Order@Shop.Example.TEST",
    fromName: "テスト店",
    subject: "【テスト店】ご注文ありがとうございます",
    text: "ご注文番号: ORD-55550000\nテスト商品 1,200円",
    html: "<p>ご注文番号: ORD-55550000</p>",
    ...over,
  };
}

/**
 * The rule this whole change is about: once a mail is read, its subject, sender and body are
 * not in the database in plaintext. Answers the rows that break it (a public sample read while
 * the user had no key is the one allowed exception).
 */
function plaintextAfterReading(db: FakeDb): Row[] {
  const keyed = new Set(db.rows("user_keys").filter((k) => k.activated_at && !k.retired_at).map((k) => k.user_id));
  return db.rows("emails").filter((e) => {
    if (e.processing_status !== "processed") return false;
    const anyPlain = PLAINTEXT_COLUMNS.some((c) => e[c] !== null && e[c] !== undefined);
    const sample = String(e.message_id ?? "").startsWith("demo:") && !keyed.has(e.user_id);
    if (sample) return false;
    return anyPlain || e.body_state === "plain" || e.body_state === undefined;
  });
}

describe("pipeline: a read mail is sealed to the user's key", () => {
  it("seals subject, sender and body in one envelope and keeps none of them in plaintext", async () => {
    const db = new FakeDb();
    const key = await keyedUser(db);
    const mail = realMail();
    const out = await processInboundEmail(asAdmin(db), mail, { precomputed: precomputed(order) });
    expect(out.kind).toBe("processed");

    const [row] = db.rows("emails");
    for (const c of PLAINTEXT_COLUMNS) expect(row[c]).toBeNull();
    expect(row.body_state).toBe("sealed");
    expect(row.from_domain).toBe("shop.example.test");
    expect(row.message_id).toBe("<m1@example.test>");
    expect(plaintextAfterReading(db)).toEqual([]);

    // Only the user's private key opens it, bound to this user and this row.
    const opened = await openMail(key, USER, String(row.id), row.body_envelope);
    expect(opened).toEqual({ subject: mail.subject, from_name: mail.fromName, from_address: mail.from, text: mail.text, html: mail.html });
    await expect(openMail(key, OTHER, String(row.id), row.body_envelope)).rejects.toThrow();

    // The parcel data stays plaintext, as disclosed.
    expect(db.rows("parcels")).toHaveLength(1);
    expect(db.rows("parcel_items")[0].name).toBe("テスト商品");
    expect(db.rows("extractions")).toHaveLength(1);
  });

  it("the status and the seal go in the same write", async () => {
    const db = new FakeDb();
    await keyedUser(db);
    await processInboundEmail(asAdmin(db), realMail(), { precomputed: precomputed(order) });
    const done = db.callsOn("emails", "update").filter((q) => (q.values as Row).processing_status === "processed");
    expect(done).toHaveLength(1);
    expect(done[0].values).toMatchObject({ body_state: "sealed", subject: null, text_body: null, html_body: null, from_name: null, from_address: null });
  });

  it("seals a mail that files no parcel (noted) too", async () => {
    const db = new FakeDb();
    await keyedUser(db);
    const out = await processInboundEmail(asAdmin(db), realMail(), { precomputed: precomputed(reading({ relevance: "other_purchase" })) });
    expect(out.kind).toBe("noted");
    expect(db.rows("emails")[0].body_state).toBe("sealed");
    expect(plaintextAfterReading(db)).toEqual([]);
  });

  it("seals a sample mail too once the user has a key", async () => {
    const db = new FakeDb();
    await keyedUser(db);
    await processInboundEmail(asAdmin(db), realMail({ messageId: "demo:amazon/order" }), { precomputed: precomputed(order), publicSample: true });
    expect(db.rows("emails")[0].body_state).toBe("sealed");
  });

  it("ignores a retired key", async () => {
    const db = new FakeDb();
    await keyedUser(db);
    db.rows("user_keys")[0].retired_at = "2026-11-02T00:00:00Z";
    await processInboundEmail(asAdmin(db), realMail(), { precomputed: precomputed(order) });
    expect(db.rows("emails")[0].body_state).toBe("dropped");
  });
});

describe("pipeline: without a key", () => {
  it("drops subject, sender and body of a real mail but keeps the parcel", async () => {
    const db = new FakeDb();
    const out = await processInboundEmail(asAdmin(db), realMail(), { precomputed: precomputed(order) });
    expect(out.kind).toBe("processed");
    const [row] = db.rows("emails");
    for (const c of PLAINTEXT_COLUMNS) expect(row[c]).toBeNull();
    expect(row.body_state).toBe("dropped");
    expect(row.body_envelope).toBeNull();
    expect(row.from_domain).toBe("shop.example.test");
    expect(db.rows("parcels")).toHaveLength(1);
    expect(plaintextAfterReading(db)).toEqual([]);
  });

  it("keeps a public sample mail readable", async () => {
    const db = new FakeDb();
    await processInboundEmail(asAdmin(db), realMail({ messageId: "demo:amazon/order" }), { precomputed: precomputed(order), publicSample: true });
    const [row] = db.rows("emails");
    expect(row.body_state).toBe("plain");
    expect(row.subject).toBe("【テスト店】ご注文ありがとうございます");
    expect(plaintextAfterReading(db)).toEqual([]);
  });
});

describe("pipeline: unread mail stays plaintext so it can be read again", () => {
  it("over the daily limit", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const db = new FakeDb();
    await keyedUser(db);
    db.rpc = (name: string, args?: unknown) => {
      db.rpcCalls.push({ name, args });
      return Promise.resolve({ data: "user_limit", error: null });
    };
    const out = await processInboundEmail(asAdmin(db), realMail({ subject: "【テスト店】ご注文の商品を発送しました" }));
    expect(out.kind).toBe("over_limit");
    const [row] = db.rows("emails");
    expect(row.processing_status).toBe("over_limit");
    expect(row.body_state).toBe("plain");
    expect(row.text_body).toBe("ご注文番号: ORD-55550000\nテスト商品 1,200円");
    expect(plaintextAfterReading(db)).toEqual([]);
  });

  it("when the model refuses", async () => {
    const db = new FakeDb();
    await keyedUser(db);
    const out = await processInboundEmail(asAdmin(db), realMail(), { precomputed: { ...precomputed(order), refused: true } });
    expect(out.kind).toBe("discarded");
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", body_state: "plain" });
  });
});

describe("pipeline: Gmail's forwarding confirmation", () => {
  const confirmation = (): InboundEmail =>
    realMail({
      from: "forwarding-noreply@google.com",
      subject: "Gmail Forwarding Confirmation",
      text: "To allow, click:\nhttps://mail-settings.google.com/mail/vf-%5Babc%5D-xyz\n",
      html: null,
    });

  it("keeps only the approval link in plaintext and seals the rest as it arrives", async () => {
    const db = new FakeDb();
    const key = await keyedUser(db);
    const out = await processInboundEmail(asAdmin(db), confirmation());
    expect(out.kind).toBe("forwarding_confirmation");
    const [row] = db.rows("emails");
    expect(row.forwarding_confirm_url).toBe("https://mail-settings.google.com/mail/vf-%5Babc%5D-xyz");
    expect(row.body_state).toBe("sealed");
    for (const c of PLAINTEXT_COLUMNS) expect(row[c]).toBeNull();
    expect((await openMail(key, USER, String(row.id), row.body_envelope)).subject).toBe("Gmail Forwarding Confirmation");
    expect(plaintextAfterReading(db)).toEqual([]);
    // Written once, already closed: no window with the body in plaintext.
    expect(db.callsOn("emails", "update")).toHaveLength(0);
  });

  it("without a key, keeps the link and drops the rest", async () => {
    const db = new FakeDb();
    await processInboundEmail(asAdmin(db), confirmation());
    expect(db.rows("emails")[0]).toMatchObject({ body_state: "dropped", subject: null, text_body: null, forwarding_confirm_url: "https://mail-settings.google.com/mail/vf-%5Babc%5D-xyz" });
  });
});

describe("pipeline: not knowing the key fails closed", () => {
  it("stores nothing and pays for nothing when user_keys cannot be read", async () => {
    const db = new FakeDb();
    db.hooks.push((q) => (q.table === "user_keys" ? { data: null, error: { message: "boom" } } : undefined));
    await expect(processInboundEmail(asAdmin(db), realMail(), { precomputed: precomputed(order) })).rejects.toThrow("user_keys lookup failed");
    expect(db.rows("emails")).toHaveLength(0);
    expect(db.rows("parcels")).toHaveLength(0);
  });

  it("refuses a key row whose id is not its public key's", async () => {
    const db = new FakeDb();
    await keyedUser(db);
    db.rows("user_keys")[0].key_id = "0".repeat(32);
    await expect(processInboundEmail(asAdmin(db), realMail(), { precomputed: precomputed(order) })).rejects.toThrow("does not match");
    expect(db.rows("emails")).toHaveLength(0);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("negative control: the invariant test catches a pipeline that does not seal", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/mail-seal");
    vi.resetModules();
  });

  it("with sealing bypassed, plaintext is left after reading and the check finds it", async () => {
    vi.resetModules();
    vi.doMock("@/lib/mail-seal", async (importOriginal) => {
      const real = await importOriginal<typeof import("@/lib/mail-seal")>();
      return { ...real, closedBody: async () => ({}) };
    });
    const { processInboundEmail: unsealed } = await import("@/lib/pipeline");
    const db = new FakeDb();
    await keyedUser(db);
    await unsealed(asAdmin(db), realMail(), { precomputed: precomputed(order) });
    expect(plaintextAfterReading(db)).toHaveLength(1);

    // And without a key.
    const db2 = new FakeDb();
    await unsealed(asAdmin(db2), realMail(), { precomputed: precomputed(order) });
    expect(plaintextAfterReading(db2)).toHaveLength(1);
  });
});
