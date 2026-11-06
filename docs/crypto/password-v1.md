# password-v1: the login secret and the key-encryption key from one password

A user has one password. From it, the client (web or iOS) makes two values that have nothing to do
with each other:

- **auth_secret**, sent to Supabase Auth as the account's password;
- **KEK**, the key that wraps the user's private key (the key that opens the stored mail, envelope v1).

The server only ever receives auth_secret. The password, master and the KEK never leave the device.

What does not change: envelope v1 (`src/lib/crypto/envelope.ts`), the `user_keys` row and its forms
(`supabase/migrations/20261106120000_mail_encryption_keys.sql`), and the wrap itself (AES-256-GCM, IV,
AAD, the order of ciphertext and tag, base64), all as in `src/lib/crypto/key-wrap.ts`. Only the KEK is
made differently: key-wrap.ts makes it with PBKDF2 straight from a separate passphrase and `kdf_salt`;
password-v1 makes it from the login password as below.

Test vectors: `fixtures/crypto/password-v1.json` (see [Test vectors](#test-vectors)).

## In one look

```
email_norm    = the address with ASCII whitespace taken off both ends, then A-Z made a-z
salt_pw       = UTF-8("otodoke/pw/v1|" + email_norm)
password_norm = NFKC(password)                                   (nothing trimmed)
master        = PBKDF2-HMAC-SHA256(UTF-8(password_norm), salt_pw, 600000 rounds, 32 bytes)
auth_secret   = lowercase hex of HKDF-SHA256(ikm = master, salt = empty, info = UTF-8("otodoke/auth/v1"), 32 bytes)
KEK           = HKDF-SHA256(ikm = master, salt = kdf_salt (16 bytes), info = UTF-8("otodoke/kek/v1"), 32 bytes)
wrapped key   = AES-256-GCM(key = KEK, iv = 12 bytes, aad = UTF-8("otodoke/key/v1|" + user_id), plaintext = PKCS#8)
                stored as base64(ciphertext || 16-byte tag)
```

## Conventions

- Text becomes bytes as **UTF-8**: no byte order mark, no terminating NUL, no length prefix. `+` is
  joining the strings before encoding; there is no other separator than the `|` written in the prefix.
- A string is handled as a sequence of Unicode **code points** (scalar values), not UTF-16 code units
  and not user-perceived characters.
- **hex** is lowercase, two digits per byte.
- **base64** is the standard alphabet (`A-Z a-z 0-9 + /`) with `=` padding and no line breaks. It is
  what `src/lib/crypto/bytes.ts` writes and the only form it reads (no base64url, no missing padding).
- Lengths are in bytes unless they say characters.

## Step 1: email_norm

Input: the address as the user typed it.

1. Take off the start, and then off the end, every code point of this set, as long as one is there:

   | Code point | Name |
   |---|---|
   | U+0009 | CHARACTER TABULATION |
   | U+000A | LINE FEED |
   | U+000C | FORM FEED |
   | U+000D | CARRIAGE RETURN |
   | U+0020 | SPACE |

   This is "ASCII whitespace" as the WHATWG Infra Standard defines it. Nothing else is taken off:
   not U+000B, U+0085, U+00A0, U+3000 or U+FEFF, and nothing between the first and the last other
   code point.
2. Replace each code point from U+0041 to U+005A (A-Z) with the code point 0x20 above it (a-z).
   Every other code point stays as it is: no Unicode case mapping, no locale, no NFKC.

Nothing is checked here (an invalid address still has an email_norm). email_norm only ever touches
ASCII, so it comes out the same on every platform and in every locale.

Do not use the platform's own functions for this. They take off or change other characters, and not
the same ones everywhere:

- JS `trim()` takes off U+00A0, U+3000 and U+FEFF but not U+0085. Swift's
  `trimmingCharacters(in: .whitespacesAndNewlines)` takes off U+0085 (and U+00A0, U+3000) but not U+FEFF.
- JS `toLowerCase()` and Swift `lowercased()` turn U+0130 `İ` into U+0069 U+0307. The Turkish locale
  turns it into `i`, and turns ASCII `I` into U+0131 `ı`.

## Step 2: salt_pw

`salt_pw = UTF-8("otodoke/pw/v1|" + email_norm)`. The prefix is the 14 bytes `otodoke/pw/v1|`.
For `user@example.test`: `6f746f646f6b652f70772f76317c75736572406578616d706c652e74657374`.

## Step 3: password_norm

`password_norm = NFKC(password)`, and its bytes are UTF-8(password_norm).

- Nothing is trimmed and letter case is kept. A space typed before or after the password is part of it.
  NFKC turns U+3000 IDEOGRAPHIC SPACE into U+0020 SPACE, which then stays.
- JS: `password.normalize("NFKC")`.
- Swift: not `precomposedStringWithCompatibilityMapping` alone; see [Notes for iOS](#notes-for-ios).

## Step 4: master

`master = PBKDF2(PRF = HMAC-SHA256, P = UTF-8(password_norm), S = salt_pw, c = 600000, dkLen = 32)`
(RFC 8018, section 5.2).

The round count is fixed by this version. It is not read from the `user_keys` row: master is needed
before sign-in (for auth_secret), when the row cannot be read yet.

## Step 5: auth_secret

`auth_secret = hex(HKDF-SHA256(IKM = master, salt = empty, info = UTF-8("otodoke/auth/v1"), L = 32))`
(RFC 5869).

- 64 characters, `0-9a-f` only. This text is the password given to Supabase Auth on sign-up, sign-in
  and password change. It meets `supabase/config.toml` as it is now (`minimum_password_length = 6`,
  `password_requirements = ""`); a requirement for upper-case letters or symbols would refuse it.
- **The empty salt.** The salt is the byte string of length 0. RFC 5869 section 2.2 says a salt that is
  not provided is HashLen (32) zero bytes, and HMAC pads a key shorter than its block with zeros, so an
  empty salt and a salt of 32 zero bytes give the same output. An API that insists on a salt may be
  given either; the tests check both. Pass bytes, not a placeholder such as the text `"null"`.
  - WebCrypto: `salt: new Uint8Array(0)`.
  - Node: `hkdfSync("sha256", master, Buffer.alloc(0), info, 32)`.
  - CryptoKit: `salt: Data()`, or the `deriveKey` overload without a salt (both give the vectors).

## Step 6: KEK

`KEK = HKDF-SHA256(IKM = master, salt = kdf_salt, info = UTF-8("otodoke/kek/v1"), L = 32)`.

- `kdf_salt` is the 16 bytes of the row's `kdf_salt` column (base64-decoded). It is not salt_pw.
  Each wrap makes a new one: 16 bytes from a cryptographically secure random source.
- The KEK is the raw 32-byte AES-256 key, used as it is.

## Step 7: wrapping and opening the private key

The same as `src/lib/crypto/key-wrap.ts`:

- **Plaintext**: the PKCS#8 DER of the P-256 private key, as the client exported it. (The vectors use
  a 138-byte one, which includes the public key.)
- **IV**: 12 random bytes, new for every wrap.
- **AAD**: UTF-8(`"otodoke/key/v1|" + user_id`), where user_id is the account's id as text: 36
  characters, lowercase hex with hyphens, as Supabase returns it.
- **AES-256-GCM** with a 128-bit tag. `wrapped_private_key` is base64 of the ciphertext followed by the
  16-byte tag. The IV is stored on its own (`wrap_iv`), not in front of the ciphertext.
- **Opening**: take the last 16 bytes as the tag and decrypt with the KEK, the IV and the same AAD. A
  failure means a wrong password or address, another user's row, or a changed byte: refuse, and do not
  try anything else. After opening, check what `openStoredKey` checks: the private key's public key is
  the row's `public_key`, and `key_id` is the first 16 bytes of SHA-256(`public_key`) in hex.

## The user_keys row

| Column | Value | Form | Check in the migration |
|---|---|---|---|
| `user_id` | the account | uuid | |
| `key_id` | first 16 bytes of SHA-256(public key) | hex, 32 characters | `^[0-9a-f]{32}$` |
| `public_key` | the 65-byte uncompressed P-256 point | base64, 88 characters | length 88 |
| `wrapped_private_key` | ciphertext \|\| tag | base64 | |
| `wrap_iv` | 12 bytes | base64, 16 characters | length 16 |
| `kdf_salt` | 16 bytes, the HKDF salt of the KEK | base64, 24 characters | length 24 |
| `kdf_iterations` | `600000`, the PBKDF2 round count of master | integer | at least 600000 |

The columns and their forms are those of the passphrase wrap. What moves is the meaning of two of them:
`kdf_salt` is now the HKDF salt of the KEK, and `kdf_iterations` records the round count of master,
which a reader does not take from the row (step 4). Nothing in a row tells a password-v1 row from a
passphrase row: both write 600000. How older rows are handled is not part of this document.

## When the password or the address changes

Both go into master, so a new password or a new address gives a new auth_secret and a new KEK. The
client makes both again, opens the private key with the old KEK, wraps it again with the new KEK (with
a new `kdf_salt` and `wrap_iv`), and sets the new auth_secret as the Supabase password.

email_norm must come from the same text in every flow. If a flow takes the address from the signed-in
session instead of from what the user typed, check that it gives the same email_norm: the auth server
may keep the address in a form of its own, which can differ for an address with non-ASCII letters.

## Security notes

- HKDF with different `info` makes auth_secret and the KEK independent: knowing auth_secret does not
  give the KEK without the password.
- Whoever has auth_secret (the server sees it at sign-in) or a `user_keys` row can still try password
  guesses offline, at one 600,000-round PBKDF2 per guess; salt_pw ties that work to one address. The
  password's strength is what protects the key, as it was with the passphrase.

## Test vectors

`fixtures/crypto/password-v1.json` is written by `scripts/crypto-password-v1-vectors.ts` from fixed
inputs. Nothing is random (the private key, the salts and the IVs come from SHA-256 of fixed labels),
so writing it again gives the same file. The values are made up and protect nothing.

```
npx tsx scripts/crypto-password-v1-vectors.ts --check   # the file is what the script writes
npx tsx scripts/crypto-password-v1-vectors.ts           # write it
```

`src/lib/__tests__/password-v1-vectors.test.ts` recomputes every value with Node's crypto and with
WebCrypto, checks the stored form against key-wrap.ts and the migration, and has negative controls
(a changed password character, another letter case in the address, another `kdf_salt`, another
`user_id` in the AAD, and the usual normalization mistakes).

The file is ASCII only. In `email`, `password`, `email_norm` and `password_norm`, every character
outside U+0021-U+007E, spaces included, is written as a `\uXXXX` escape, so none is mistaken by eye.

| Field | What it is |
|---|---|
| `email`, `password` | the input, as typed |
| `email_norm`, `password_norm` | steps 1 and 3, as text |
| `salt_pw_hex`, `password_norm_utf8_hex` | the bytes PBKDF2 takes, hex |
| `master_hex`, `kek_hex` | steps 4 and 6, hex |
| `auth_secret` | step 5: the 64-character text sent as the password |
| `user_id`, `aad` | the account id and the AAD, as text |
| `kdf_salt_hex`, `wrap_iv_hex` | the salt and IV of the wrap, hex |
| `wrap_ciphertext_hex`, `wrap_tag_hex` | the two parts of the wrapped key, hex |
| `user_keys_row` | the row exactly as stored (base64 as in the table above) |
| `private_key` | `d_hex`, `pkcs8_hex` (the plaintext), `public_key_hex`, `key_id`; one key for every case |

The cases (code points of the result in brackets):

| Case | Input | Result |
|---|---|---|
| `ascii` | `user@example.test`, `Tr0ub4dor&3` | unchanged |
| `password_halfwidth_katakana` | ﾃﾞｼﾞﾀﾙ [U+FF83 U+FF9E U+FF7C U+FF9E U+FF80 U+FF99] | デジタル [U+30C7 U+30B8 U+30BF U+30EB] |
| `password_fullwidth_alnum` | Ｐａｓｓ１２３ [U+FF30 U+FF41 U+FF53 U+FF53 U+FF11 U+FF12 U+FF13] | `Pass123` |
| `password_combining_mark` | `cafe` + U+0301 | `caf` + U+00E9 |
| `password_compatibility_chars` | ①㍻ [U+2460 U+337B] | `1` + 平成 [U+0031 U+5E73 U+6210] |
| `password_surrounding_spaces` | U+0020 U+3000 `Tr0ub4dor&3` U+0020 | U+0020 U+0020 `Tr0ub4dor&3` U+0020 |
| `email_uppercase` | `User@Example.TEST` | `user@example.test` (same master as `ascii`) |
| `email_surrounding_whitespace` | U+0020 U+0009 U+000A U+000C U+000D, the address, U+000D U+000A U+0009 U+0020 | `user@example.test` (same master as `ascii`) |
| `email_non_ascii_whitespace` | U+3000, the address, U+00A0 | unchanged: U+3000 and U+00A0 stay |
| `email_dotted_capital_i` | U+0130 `STANBUL.IZMIR@EXAMPLE.TEST` | U+0130 `stanbul.izmir@example.test` |

## Notes for the web

- `normalize("NFKC")` is NFKC. For the address, write the two rules of step 1 by hand (not `trim()` or
  `toLowerCase()`).
- key-wrap.ts's `wrapPrivateKey`, `unwrapPrivateKeyBytes` and `openStoredKey` take the passphrase and
  make the KEK inside. password-v1 needs the same wrap and open taking the KEK; the AES-GCM step and
  the stored form stay as they are.

## Notes for iOS

Each point below was checked by recomputing every case of the vectors in Swift on macOS 27, with
Foundation, CommonCrypto and CryptoKit.

1. **NFKC.** Use `password.decomposedStringWithCompatibilityMapping.precomposedStringWithCanonicalMapping`.
   iOS Foundation's `precomposedStringWithCompatibilityMapping` does not compose the voiced sound marks of
   half-width katakana: `ﾃﾞ` (U+FF83 U+FF9E) stays テ U+30C6 + U+3099 instead of becoming デ U+30C7, which
   JS `normalize("NFKC")` gives (seen on macOS 27 too; case `password_halfwidth_katakana`). So apply the
   compatibility decomposition, then the canonical composition, to match the JS NFKC. This is the
   definition of NFKC, and it gives the JS result in every case here.
2. **Compare bytes, not Strings.** Swift compares `String`s by canonical equivalence, so
   `"\u{30C6}\u{3099}" == "\u{30C7}"` and `"e\u{301}" == "\u{E9}"` are true. A test that compares
   `password_norm` as Strings passes with the wrong normalization. Compare `Array(s.utf8)` with
   `password_norm_utf8_hex`, and email_norm through `salt_pw_hex`.
3. **email_norm.** Work on `unicodeScalars`: drop the five code points of step 1 from both ends, and add
   0x20 to 0x41-0x5A. Not `trimmingCharacters(in:)` or `lowercased()`.
4. **PBKDF2.** CryptoKit has none. CommonCrypto: `CCKeyDerivationPBKDF(kCCPBKDF2, ..., kCCPRFHmacAlgSHA256,
   600000, ..., 32)` with the UTF-8 bytes of password_norm and their byte count.
5. **HKDF.** `HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: master), salt: Data() (or the
   kdf_salt bytes), info: Data("otodoke/auth/v1".utf8), outputByteCount: 32)`.
6. **AES-GCM.** `AES.GCM.seal(pkcs8, using: SymmetricKey(data: kek), nonce: AES.GCM.Nonce(data: iv),
   authenticating: Data(aad.utf8))`, then store `ciphertext + tag`. Not `combined`: it puts the 12-byte
   nonce in front. To open: `AES.GCM.SealedBox(nonce:ciphertext:tag:)` with the last 16 bytes as the tag.
7. **Hex** is lowercase (`String(format: "%02x", byte)`).

## Limits

NFKC does not change for characters a Unicode version already has, but a character newer than one
side's Unicode data is left as it is there. A password with such a character may come out differently on
an older device. The vectors use only long-established characters.
