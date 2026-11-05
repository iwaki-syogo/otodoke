/**
 * Write the fixed test vectors for envelope v1 and the key wrap (fixtures/crypto/envelope-v1.json).
 * The web tests and the iOS app both decrypt them byte for byte. The keys in it are made up for
 * the vectors and protect nothing.
 *
 *   NODE_ENV=test npx tsx scripts/crypto-vectors.ts          # check the file still reproduces
 *   NODE_ENV=test npx tsx scripts/crypto-vectors.ts --write  # make new keys (only if the file is missing)
 */
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fromBase64, randomBytes, toBase64, utf8, concat } from "../src/lib/crypto/bytes";
import { HKDF_SALT, keyIdOf, mailAad, sealMail, type MailPlaintext } from "../src/lib/crypto/envelope";
import { KDF_ITERATIONS, keyWrapAad, normalizePassphrase, wrapPrivateKey } from "../src/lib/crypto/key-wrap";

const FILE = path.join(process.cwd(), "fixtures", "crypto", "envelope-v1.json");
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const EMAIL_ID = "00000000-0000-4000-8000-0000000000ee";
/** Full-width letters and digits and an ideographic space, so the vector proves NFKC. */
const PASSPHRASE = "ＯＴＯＤＯＫＥ　テスト合言葉１２３";
const MAIL: MailPlaintext = {
  subject: "【テスト店】ご注文の商品を発送しました",
  from_name: "テスト店",
  from_address: "shop@example.test",
  text: "テスト 太郎 様\nご注文番号: TEST-0001\nお届け予定: 2026/11/09（月）\n",
  html: "<p>テスト 太郎 様</p><p>ご注文番号: TEST-0001</p>",
};

async function pair() {
  const p = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", p.privateKey);
  return {
    private_key_pkcs8: toBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", p.privateKey))),
    private_key_d: toBase64(fromBase64(jwk.d!.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (jwk.d!.length % 4)) % 4))),
    public_key: toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", p.publicKey))),
  };
}

type Pair = Awaited<ReturnType<typeof pair>>;

async function intermediates(recipient: Pair, ephemeral: Pair) {
  const priv = await crypto.subtle.importKey("pkcs8", fromBase64(ephemeral.private_key_pkcs8), ECDH, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", fromBase64(recipient.public_key), ECDH, true, []);
  const z = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
  const ikm = await crypto.subtle.importKey("raw", z, "HKDF", false, ["deriveBits"]);
  const info = concat(fromBase64(ephemeral.public_key), fromBase64(recipient.public_key));
  const key = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8(HKDF_SALT), info }, ikm, 256));
  return { shared_secret_z: toBase64(z), hkdf_info: toBase64(info), aes_key: toBase64(key) };
}

async function build(recipient: Pair, ephemeral: Pair, iv: string, salt: string, wrapIv: string) {
  const publicKey = fromBase64(recipient.public_key);
  const keyId = await keyIdOf(publicKey);
  const envelope = await sealMail({ keyId, publicKey }, USER_ID, EMAIL_ID, MAIL, {
    ephemeralPrivateKeyPkcs8: fromBase64(ephemeral.private_key_pkcs8),
    ephemeralPublicKey: fromBase64(ephemeral.public_key),
    iv: fromBase64(iv),
  });
  const wrapped = await wrapPrivateKey(fromBase64(recipient.private_key_pkcs8), PASSPHRASE, USER_ID, { salt: fromBase64(salt), iv: fromBase64(wrapIv) });
  const passBytes = utf8(normalizePassphrase(PASSPHRASE));
  const base = await crypto.subtle.importKey("raw", passBytes, "PBKDF2", false, ["deriveBits"]);
  const kek = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(salt), iterations: KDF_ITERATIONS }, base, 256));
  return {
    format: "otodoke envelope v1 / key wrap v1. Made-up keys for tests; they protect nothing.",
    envelope: {
      recipient: { ...recipient, key_id: keyId },
      ephemeral,
      user_id: USER_ID,
      email_id: EMAIL_ID,
      aad: mailAad(USER_ID, EMAIL_ID),
      iv,
      hkdf_salt: HKDF_SALT,
      plaintext_object: MAIL,
      plaintext_json: JSON.stringify({ v: 1, ...MAIL }),
      ...(await intermediates(recipient, ephemeral)),
      envelope,
    },
    key_wrap: {
      user_id: USER_ID,
      passphrase: PASSPHRASE,
      passphrase_nfkc: normalizePassphrase(PASSPHRASE),
      passphrase_nfkc_utf8: toBase64(passBytes),
      aad: keyWrapAad(USER_ID),
      kdf_salt: wrapped.kdf_salt,
      kdf_iterations: wrapped.kdf_iterations,
      kek: toBase64(kek),
      private_key_pkcs8: recipient.private_key_pkcs8,
      wrapped_private_key: wrapped.wrapped_private_key,
      wrap_iv: wrapped.wrap_iv,
    },
  };
}

async function main() {
  if (process.env.NODE_ENV !== "test") throw new Error("run with NODE_ENV=test (fixed ephemeral keys are refused otherwise)");
  if (process.argv.includes("--write")) {
    if (existsSync(FILE)) throw new Error(`${FILE} exists. The iOS app depends on it: delete it by hand only on purpose.`);
    const out = await build(await pair(), await pair(), toBase64(randomBytes(12)), toBase64(randomBytes(16)), toBase64(randomBytes(12)));
    await mkdir(path.dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(out, null, 2) + "\n");
    console.log(`wrote ${path.relative(process.cwd(), FILE)}`);
    return;
  }
  const saved = JSON.parse(await readFile(FILE, "utf8"));
  const e = saved.envelope;
  const again = await build(
    { private_key_pkcs8: e.recipient.private_key_pkcs8, private_key_d: e.recipient.private_key_d, public_key: e.recipient.public_key },
    e.ephemeral,
    e.iv,
    saved.key_wrap.kdf_salt,
    saved.key_wrap.wrap_iv,
  );
  const same = JSON.stringify(again) === JSON.stringify(saved);
  console.log(same ? "vectors reproduce" : "vectors DIFFER");
  if (!same) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
