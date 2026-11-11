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
failure. **Do not retry automatically** on a timeout or on `read_failed` (every attempt can spend Claude calls);
reload the list and let the user press again.

Answer: `200 { "ok": true, "read": 3, "over_limit": false, "busy": false, "stopped": false }`.
- `read`: the number of mails processed (every outcome except `over_limit`).
- `over_limit: true`: the allowance ran out and the rest keep waiting.
- `busy: true`: another read of the same account is holding some of the mails (not a failure; that read
  finishes them). Reload the list later.
- `stopped: true`: reading is stopped on the server (it cannot be used at all, so trying again does not
  help). The read ended at the first such mail and the rest keep waiting; this is a 200, not `read_failed`,
  and it wins over a failure earlier in the same run. (The name is `stopped`, not `unavailable`: that is already the `code` of the 503.) A client that does not know the field can ignore it:
  the other fields keep their names, types and meaning. Say it to the person as stopped, not as a failure.

A real failure answers `500 { "ok": false, "code": "read_failed", "read": 1 }`; `read` is how many were processed
before and around it (a failing mail does not stop the ones after it).

## Explicit permission for real-mail reading

Before `read-waiting` starts, the server reads this user's `ai_reading_consents` row through
`readingAllowed`. Only `decision = granted` permits the operation. The pipeline checks again for
each real mail, before either the Haiku check or extraction, without changing the daily allowance.

| Status | `code` | Meaning |
|---|---|---|
| 403 | `ai_consent_required` | No choice yet, or reading was declined or withdrawn. Open the reading-permission screen. |
| 503 | `unavailable` | The permission could not be read. Retry the permission lookup; this is not an unanswered choice. |

Both answers are `{ "ok": false, "code": "<code>" }`, with no paid reading started. A mail held by
the pipeline has `processing_status = failed` and a fixed `error`: `ai_consent_required` or
`ai_consent_unknown`. It remains in the existing unread set and can be read in place after permission
or recovery. Permission changes do not automatically start a paid reading. An in-flight read which
finds permission withdrawn fails that mail without adding it to `read`; it can return `read_failed`.

The initial guard also stops this endpoint from resuming interrupted sample rows without permission.
Use the existing demo API to load the made-up sample without permission: it uses saved extraction
results and never calls Claude. This exception requires both the internal public-sample flag and a
precomputed result; a sample flag by itself cannot authorize a real mail.

The consent read is `from("ai_reading_consents").select("decision, decided_at, text_version")`
filtered by the signed-in user's `user_id`. An empty result means undecided; a failed request must
stay distinct. Choices are recorded through
`rpc("set_ai_reading", { p_decision, p_text_version })`, where `p_decision` is `granted` or `declined`.
The current text version and the shared permission words are defined in `src/lib/ai-consent-text.ts`.
The server supplies `decided_at`; clients cannot write the table directly. Do not show the forwarding
address until the consent read confirms `granted`. Previously extracted results remain after withdrawal.
