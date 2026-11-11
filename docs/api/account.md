# iOS account deletion

`POST /api/account/delete` is the native counterpart of settings' `deleteAccount` Server Action.
Deploy this endpoint on the Web before distributing an iOS build that calls it.

The request carries `Authorization: Bearer <Supabase access token>` and the JSON body
`{"confirm":"delete-account"}`. No user ID is accepted. `readBearerSession` asks Supabase Auth
to verify that same token and uses the verified user's ID. Cookie authentication is not used.
As on the Web, any valid signed-in session is sufficient; deletion does not add a password-age
restriction. The explicit confirmation field is required, as in the Web confirmation form.

The endpoint calls the same `deleteAuthUser` function in `src/lib/account-deletion.ts` as the
Server Action. It permanently deletes the Auth user, whose owned rows cascade in the database;
it does not soft-delete. An error response followed by a confirmed `user_not_found` lookup is
success, as on the Web. No request reads or accepts a password, opened key, or email body.

Responses carry `Cache-Control: no-store` and no CORS headers:

| Status | JSON | Meaning |
| --- | --- | --- |
| 200 | `{"ok":true}` | Account deleted; the app clears its session, keys and loaded data. |
| 400 | `{"ok":false,"code":"invalid_input"}` | Missing/wrong confirmation, malformed/oversized JSON, or unknown fields. |
| 401 | `{"ok":false,"code":"unauthorized"}` | Missing/refused token or token/user mismatch. |
| 500 | `{"ok":false,"code":"delete_failed"}` | Deletion could not be confirmed. Keep the device signed in. |
| 503 | `{"ok":false,"code":"unavailable"}` | Auth could not be reached; nothing was deleted. |

Only POST is exported (other methods are 405). The native client does not follow redirects or
retry deletion automatically. Error responses contain fixed codes only. The native confirmation
screen uses the Web's wording and explains removal of automatic mail forwarding.

# iOS password change

`POST /api/account/password` uses the same Bearer verification and JSON response shape. Its body
is `ChangeSecretInputSchema`: `currentAuthSecret`, `newAuthSecret`, `rewrap` (the existing
`KeyRewrapSchema`, or null), and optional `captchaToken`. Raw passwords, master and KEKs never
leave the app. The existing `changeSecret` function runs with the verified Bearer owner and an
ephemeral Auth client, instead of the browser's cookie client. It checks the current login secret
with CAPTCHA and the same application attempt limits, saves the wrap with its compare-and-swap
condition, then changes the Auth secret. A confirmed refusal restores the previous wrap; an
uncertain Auth response keeps the new wrap and returns `secret_change_unknown`, exactly as Web.

The envelope/key ID stays the same. The app constructs and opens the new wrap before sending it.
On success the app clears the typed fields, shows the Web's success sentence and offers
`ログインし直す`; pressing it clears this device's session, keys and loaded data before login.
`secret_change_unknown` also clears the fields and offers that button, alongside the Web's
recovery instructions. Definite refusals keep the fields/session and show the Web's fixed wording.

Body errors are 400 `invalid_input`, authentication errors are 401 `unauthorized` or 503
`unavailable`. Known change outcomes are 200 `{ok:true}` or `{ok:false,code:<ChangeSecretFailure>}`.
An unexpected throw is 500 `network`. No cookies are written and no tokens are returned.
