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

Request: `{}` for an explicit retry (an empty body is accepted too), or
`{ "after_consent": "<decided_at returned by set_ai_reading>" }` for the automatic reading immediately
after a successful grant. The automatic form is described below; it can drain successive batches.

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
or recovery. A successful grant starts the waiting mail automatically within the existing daily caps.
A reading failure does not undo the saved permission. An in-flight batch which finds permission
withdrawn does not send its next mail and does not add that mail to `read`; it can return `read_failed`.

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
They can be removed through the existing deletion controls.

## Automatic reading after a grant

After `set_ai_reading` successfully returns `decision = granted`, iOS immediately calls
`POST /api/mail/read-waiting` with `{ "after_consent": "<returned decided_at>" }`. Web performs the same
step in its Server Action using `runReadAfterConsent` in `src/lib/ai-consent-run.ts`.
Send the returned timestamp string unchanged, including fractional seconds and timezone. Do not round
it through a millisecond date representation: the database uses it as the identifier of this grant.
There is no age cutoff for a valid timestamp; malformed timestamps are `400 invalid_input`.

The server claims `claim_ai_reading_backlog(p_user_id, p_decided_at)` before reading. Only the service
role can execute it. It verifies the current grant under a row lock and starts that grant's automatic
reading once. Repeating the same decision and text version keeps `decided_at` unchanged, so concurrent
button presses do not start a second reading. A stale timestamp, a withdrawn grant, or an already
claimed grant cannot start another run. A withdrawal followed by a new grant has a new server timestamp.

The automatic run takes the user's plain unread mail marked by a non-null `consent_waiting_until`,
with immutable `received_at` at or before the returned grant timestamp. Its deadline must be later
than both the grant and the current batch's start time. All conditions apply before the batch limit.
This includes legacy allowance or Claude-stop failures marked by migration 120000 without replacing
their stored `error` for selection. A retry's `created_at` is not the arrival time. Samples and
forwarding confirmations are excluded even if a stale row has a marker. New arrivals continue
through the normal pipeline; the manual reader keeps its wider unread set.

The run reads successive batches until no eligible mail remains, a daily cap is reached, reading
stops, or a failure ends the run. It uses the existing per-user and global Claude claims for every
paid call. The owned store checks expiry again before takeover, so content that expires after the
query is not sent to Claude. Samples keep their separate precomputed path.

The response keeps the existing `read`, `over_limit`, `busy`, and `stopped` fields. An already claimed
or stale grant can successfully report no new reading; it does not consume another allowance.
Use the existing limit and reading-failure messages. The permission stays saved on a claim or reading
failure. Explicit later retries use `{}`, so the one-time automatic claim does not prevent recovery.
Do not reset permission, automatically replay a failed reading, or show the permission screen as though
the choice was never saved. Each real mail still passes the current server permission check before
its paid processing; withdrawing stops subsequent unread mail while retaining prior results.

The automatic reader also requires the cost-guard timing contract from `src/lib/unread.ts`: bounded
triage/extraction timeouts, a complete-mail budget with time for database writes, and a request budget
below the route duration. It reserves that complete-mail budget before starting each mail, across all
batches. If the contract is missing or inconsistent, it fails before claiming or sending any mail;
the permission remains saved. Deploy this automatic reader together with the cost-guard branch's
SDK timeout and retry controls. A mail must not be started just because there is a positive amount of
time left. An interrupted or uncertain paid request is not automatically replayed.

## Storage and expiry while waiting for permission

Consent-waiting mail uses the existing per-user unread count and byte limits. It does not consume
the active global unread storage pool, including after a later grant while the same mail waits for
the daily Claude allowance. Storage rejection keeps the existing intake notice and response fields.
No permission choice or retry extends its deadline.

The retention period is defined once by `public.ai_consent_waiting_retention()` in migration
`20261113120000_consent_waiting_storage.sql`. The database assigns `consent_waiting_until` from the
immutable original `received_at`. Declining or withdrawing keeps unread mail only until that
arrival-based deadline. A grant does not reset it. Clients must not promise indefinite retention
of consent-waiting mail, or calculate a fresh deadline when retrying.

The existing daily cleanup removes expired waiting mail. Taking over an expired row also clears it
before Claude is called and uses the existing discarded outcome. If a partial reading has already
been saved, cleanup clears the mail content while keeping its saved results and parcel. Completed
readings remain until the user deletes them. No new cron or client-scheduled cleanup is required.

## Permission at each paid claim

Migration `20261113121000_claude_claim_consent.sql` also checks the current consent inside both
paid-claim RPCs. It locks the user's consent row `FOR SHARE` before taking any daily allowance.
A withdrawal serialized before the claim prevents that claim and keeps the mail waiting, including
when withdrawal occurs after the pipeline's first check or between triage and extraction.
The existing permission choice and previously saved results stay intact. A legitimate release of
an earlier claim remains possible after withdrawal.

Only SQLSTATE `42501` with the exact message `ai_consent_required` is treated as the fixed permission
denial. Lease failures, database errors and failure to retain the waiting state remain failures.
The initial API guard and its existing response contract are unchanged; a running batch stopped by
a later withdrawal can still report `read_failed` as described above.

The transaction serializes claim authorization with withdrawal. Its locks are released when the
claim commits, before the external HTTP request; they are not held across Claude's response. An
already authorized call cannot be recalled by a later withdrawal. Clients must not replay such a
call automatically or reset the saved permission when reporting the stopped batch.

## Scope of the waiting-mail deadline

The 14-day deadline applies to unread mail marked by a consent-waiting history. Mail arriving
while permission is granted and waiting only because of an allowance or a reading failure does
not acquire that deadline unless it later enters consent waiting, including on withdrawal.
The settings and privacy text share `UNREAD_MAIL_STORAGE_NOTICE` for ordinary unread storage
without promising a deadline. `AI_CONSENT_TEXT.waitingRetention` describes consent waiting
separately. This wording does not extend the SQL cleanup scope.

## A retained reading whose original content is unavailable

The embedded `emails` read includes `error` as well as `body_state`. For a dropped body, the exact
reason `ai_consent_wait_expired` identifies the consent-waiting deadline; the Web uses
`CONSENT_WAIT_EXPIRED_NOTICE` for this case. A null, missing or unknown reason does not establish a
past key or login state: it receives the existing neutral content-not-kept explanation. Raw reasons
are not displayed. This changes neither the saved parcel and reading nor plain and sealed content.
