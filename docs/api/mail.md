# Mail API for the iOS app

The iOS app cannot call the web's Server Actions, so 「届くはずの荷物として覚える」 and 「読めていないメールを読む」
(`markWronglyDropped`, `readWaitingMail` in `src/app/app/settings/actions.ts`) are also served over HTTP. Both
call the same functions as the web (`src/lib/mail-run.ts`). Code: `src/app/api/mail/**`. Tests:
`src/lib/__tests__/mail-api.test.ts`.

## Common to both endpoints

Same as `docs/api/demo.md`: `POST` only, JSON in and out, no CORS; `Authorization: Bearer <access_token>`
(checked by `getUser(token)`; the user is the token's, never the body's); no freshness rule; body at most
1 KB, unknown fields are `400 invalid_input`; every answer has `Cache-Control: no-store`.

| Status | `code` | Meaning |
|---|---|---|
| 401 | `unauthorized` | No Bearer token, not a JWT, or Supabase Auth refused it. |
| 400 | `invalid_input` | Body not JSON, too long, has an unknown field, or (mark-parcel) `id` is not a UUID. |
| 404 | `not_found` | (mark-parcel) No dropped mail of this user with that id. |
| 500 | `mark_failed` | (mark-parcel) The database failed. |
| 500 | `read_failed` | (read-waiting) A mail could not be read, or the waiting list could not be fetched. |
| 503 | `unavailable` | Supabase Auth could not be asked. Try again later. |

## POST /api/mail/mark-parcel

The user says a dropped mail was a parcel notice. Request: `{ "id": "<screen_events id, UUID>" }`.

Answer: `200 { "ok": true, "outcome": "<outcome>" }`. `outcome` is one of:

- `remembered`: the sender's domain is remembered; later mail from it is judged by the cheap Claude check.
- `shared`: a domain many people use (gmail.com, ...): not remembered.
- `forwarded`: the mail was a forwarded copy (subject `Fwd:` / `転送`): not remembered.
- `own`: the mail came from the user's own address domain: not remembered.

The web shows any failure as `flagged=failed`; here it is `404 not_found` or `500 mark_failed`.

## POST /api/mail/read-waiting

Read up to 20 mails that arrived after the daily limit (with Claude), oldest first. The daily Claude caps
(per user and global) are enforced in the pipeline (`claim_claude_call`), exactly as on the web; when the
allowance runs out the loop stops.

Request: `{}` (an empty body is accepted too).

**Timeout**: the answer comes only at the end (up to 300 s), so the client's request timeout must be at least
300 seconds. If the client times out anyway, the server still finishes: reload the list instead of showing a
failure.

Answer: `200 { "ok": true, "read": 3, "over_limit": false }`. `read` is the number of mails taken in;
`over_limit: true` means the allowance ran out and the rest keep waiting.
