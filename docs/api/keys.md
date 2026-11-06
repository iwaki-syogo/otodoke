# Key API for the iOS app (password-v1)

The iOS app cannot call the web's Server Actions, so the key steps of `src/app/app/settings/key-actions.ts`
are also served over HTTP. Each endpoint calls the same function of `src/lib/mail-keys.ts` as the web, behind
the same checks. Code: `src/app/api/keys/**`. Tests: `src/lib/__tests__/keys-api.test.ts`.

How the client makes the values (email_norm, auth_secret, KEK, the wrap): `docs/crypto/password-v1.md` and
`fixtures/crypto/password-v1.json`. No endpoint takes the password, master, the KEK or auth_secret.

## Common to every endpoint

- **Method**: `POST` only. Any other method gets `405` from Next.js.
- **Base URL**: the web app's origin, e.g. `https://otodoke.app`.
- **Headers**:
  - `Authorization: Bearer <access_token>`: the Supabase access token of the signed-in user (the
    `access_token` of the session supabase-swift holds). Checked by Supabase Auth (`getUser(token)`); the user
    is the token's, never one named in the body.
  - `Content-Type: application/json`.
- **No CORS**: the app is native; browsers are not served.
- **Body**: a JSON object with exactly the fields below. A missing field, another type, or **any extra field**
  is refused (`400 invalid_input`). Body at most 16 KB.
- **Freshness (decision 10)**: the session must have signed in with the password in the last 15 minutes
  (the `amr` claim of the token: `{ "method": "password", "timestamp": ... }`). An older session gets
  `403 stale_session`: sign in with the password again, then repeat the step. Refreshing the token does not
  help: the time is when the user signed in, kept across refreshes.
- **Answer**: JSON, `Cache-Control: no-store`.
  - Success: `200` and `{ "ok": true, ... }`.
  - Failure: `{ "ok": false, "code": "<code>" }` with the status in the table below. The code is fixed; no
    other text is sent (the server log has the code only).

### Result codes

| Status | `code` | Meaning | What the app does |
|---|---|---|---|
| 401 | `unauthorized` | No Bearer token, not a JWT, or Supabase Auth refused it (expired, signed out, forged). | Sign in again. |
| 403 | `stale_session` | Signed in more than 15 minutes ago. | Sign in with the password again, then repeat. |
| 400 | `invalid_input` | The body is not JSON, too long, has an unknown or missing field, or a value of the wrong form (base64, lengths, `kdfIterations` < 600000). | A bug in the app: do not repeat as is. |
| 409 | `key_in_use_changed` | The key in use is not `expectedCurrentKeyId` (another device made or replaced a key meanwhile). Postgres `P0001` of `activate_user_key_checked`. | Read `user_keys` again and start over. Nothing changed. |
| 409 | `key_not_pending` | No pending key with this `keyId` and challenge (`P0002`): never registered, replaced by a newer registration, or activated already. | Start over from register. |
| 409 | `key_wrap_changed` | The stored wrap is not the one the app opened (another device changed the password meanwhile). | Read the key again and start over. Nothing changed. |
| 409 | `key_not_in_use` | No key in use with this `keyId`. | Read the key again. |
| 422 | `key_challenge_failed` | The opened challenge is not the one the server sealed. | Start over from register. |
| 500 | `key_failed` | The database failed. | Try again later. |
| 503 | `unavailable` | Supabase Auth could not be asked. | Try again later. |

## POST /api/keys/register

Store a new key as **pending**. The key in use (if any) stays in use until activation. A pending key from an
earlier, unfinished try is replaced.

Request:

```json
{
  "publicKey": "<base64, the 65-byte uncompressed P-256 point>",
  "wrappedPrivateKey": "<base64, AES-256-GCM ciphertext || 16-byte tag of the PKCS#8>",
  "wrapIv": "<base64, 12 bytes>",
  "kdfSalt": "<base64, 16 bytes: the HKDF salt of the KEK>",
  "kdfIterations": 600000,
  "expectedCurrentKeyId": "<32 hex: the key in use as the app read it, or null when there is none>"
}
```

Answer `200`:

```json
{ "ok": true, "keyId": "<32 hex>", "challenge": { "...": "an envelope v1 sealed to publicKey" } }
```

`challenge` is an envelope v1 (`src/lib/crypto/envelope.ts`) of 32 random bytes, sealed to the new public key
with the AAD of a challenge (`challengeAad(userId, keyId)`).

## POST /api/keys/activate

Put the pending key in use. Under one lock the server checks the challenge's hash and that the key in use is
still `expectedCurrentKeyId`, retires the old key and activates this one (`activate_user_key_checked`).

Request:

```json
{ "keyId": "<32 hex>", "challenge": "<base64 of the 32 bytes the app opened>", "expectedCurrentKeyId": "<32 hex or null>" }
```

Answer `200`: `{ "ok": true, "keyId": "<32 hex>" }`.

## POST /api/keys/rewrap

Store a new wrap of the key in use (the password changed), only over the wrap the app opened.

Request:

```json
{
  "keyId": "<32 hex>",
  "previousWrappedPrivateKey": "<base64: the wrap the app opened with the old KEK>",
  "wrappedPrivateKey": "<base64: the new wrap>",
  "wrapIv": "<base64, 12 bytes, new>",
  "kdfSalt": "<base64, 16 bytes, new>",
  "kdfIterations": 600000
}
```

Answer `200`: `{ "ok": true, "keyId": "<32 hex>" }`.

## POST /api/keys/restore

Put back the wrap from before a rewrap, when the password change it belonged to did not go through (Supabase
refused the new auth_secret). Written only while the stored wrap is still the one that rewrap stored.

Request:

```json
{
  "keyId": "<32 hex>",
  "rewrappedPrivateKey": "<base64: the wrap the rewrap stored>",
  "wrappedPrivateKey": "<base64: the wrap from before it>",
  "wrapIv": "<base64: its IV>",
  "kdfSalt": "<base64: its salt>",
  "kdfIterations": 600000
}
```

Answer `200`: `{ "ok": true, "keyId": "<32 hex>" }`.

## Reading

There is no read endpoint. The app reads its own rows with its session through PostgREST:
`user_keys` has row level security `user_id = auth.uid()` and `select` granted to `authenticated`
(`supabase/migrations/20261106120000_mail_encryption_keys.sql`).

- The key in use: `activated_at is not null and retired_at is null` (at most one).
- A pending key (to check it opens before activation): by `key_id`, `activated_at is null`.

## Order

### The first key (the first sign-in with the password)

1. Sign in with Supabase Auth: `signInWithPassword(email, auth_secret)`. The 15 minutes start here.
2. Read `user_keys` (above). With a key in use, open it with the KEK instead; stop here.
3. Make a P-256 key pair, a new `kdfSalt`, the KEK and the wrap.
4. `POST /api/keys/register` with `expectedCurrentKeyId: null`.
5. **Read the pending row back** by `keyId` and open its `wrapped_private_key` with the KEK: this proves the
   stored wrap opens with this password and is the pair of the stored public key.
6. Open `challenge` with that private key.
7. `POST /api/keys/activate` with `keyId`, the opened bytes (base64) and `expectedCurrentKeyId: null`.

`409 key_in_use_changed` at 4 or 7: another device made the key first. Read the key in use and open it.

### Changing the password (the current one is known)

1. Open the key in use with the current password's KEK.
2. Sign in with the current auth_secret (the 15 minutes start here, and it checks the current password).
3. Wrap the same private key with the new password's KEK (new `kdfSalt` and `wrapIv`);
   `POST /api/keys/rewrap` with `previousWrappedPrivateKey` = the wrap from 1.
4. `updateUser(password: new auth_secret)`.
5. If Supabase **refused** it (a 4xx answer), `POST /api/keys/restore` with `rewrappedPrivateKey` = the wrap of 3
   and the four columns of the wrap from 1. If the answer is **unknown** (no answer, timeout, 5xx), do not
   restore: the key now opens with the new password, which may be the one that signs in.

The web does steps 2 to 5 in one Server Action (`changeLoginSecret`), so a closed tab cannot stop between
them. The app should do them without waiting for the user in between.

### Reset (the password is forgotten)

The reset mail's link opens the web (`/auth/confirm` → `/reset-password`): the new password and the new key
are made there. The old key is retired, and the mail sealed to it no longer opens. Afterwards the app signs in
with the new password and opens the key in use.
