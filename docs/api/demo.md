# Sample API for the iOS app

The iOS app cannot call the web's Server Actions, so 「サンプルを読み込む」 and 「全部消す」
(`loadDemo`, `clearAllParcels` in `src/app/app/settings/actions.ts`) are also served over HTTP. Both call the
same functions as the web (`src/lib/demo-run.ts`). Code: `src/app/api/demo/**`. Tests:
`src/lib/__tests__/demo-api.test.ts`, and `load-demo-concurrent.test.ts` for the load while another runs.

## Common to both endpoints

- **Method**: `POST` only (`405` from Next.js otherwise). JSON in and out. No CORS (native app).
- **Headers**: `Authorization: Bearer <access_token>` (the Supabase access token of the signed-in user, checked
  by `getUser(token)`; the user is the token's), and `Content-Type: application/json`.
- **No freshness rule**: any valid session may call (unlike `docs/api/keys.md`).
- **Body**: at most 1 KB; unknown fields are `400 invalid_input`.
- **Answer**: `Cache-Control: no-store`; `200 { "ok": true, ... }` or `{ "ok": false, "code": "<code>" }`.

| Status | `code` | Meaning |
|---|---|---|
| 401 | `unauthorized` | No Bearer token, not a JWT, or Supabase Auth refused it. Sign in again. |
| 400 | `invalid_input` | Body not JSON, too long, or has an unknown field. |
| 400 | `clear_confirm` | (clear) `confirm` is missing or not `"yes"`. Nothing was removed. |
| 500 | `demo_failed` | (load) The load failed part way. Mails done stay; it can be repeated. |
| 500 | `clear_failed` | (clear) The delete failed. |
| 503 | `unavailable` | Supabase Auth could not be asked. Try again later. |

## POST /api/demo/load

Feed the anonymized sample mails (97 mails, 86 parcels) through the real pipeline for the user. Never calls
Claude. Takes a while (up to 300 s). Repeating it is safe.

Request: `{}` (an empty body is accepted too).

**Timeout**: the answer comes only at the end, so the client's request timeout must be at least 300 seconds.
If the client times out anyway, the server still finishes the load: reload the parcel list instead of
treating it as a failure.

Answer: `200 { "ok": true, "processed": 97, "busy": false }`. `busy: true` means another load of the same
account is running (a second judge, or the web): this one stopped at a mail being read and left the rest to
the other, so `processed` can be smaller. Nothing is doubled. Read the list again later.

## POST /api/demo/clear

Remove everything the user has (all parcels and mails; their items and extractions go with them).

Request: `{ "confirm": "yes" }`.

Answer: `200 { "ok": true }`.
