/**
 * Cloudflare Turnstile on the login form. Supabase Auth checks the token itself when CAPTCHA
 * protection is on (Authentication > Bot and Abuse Protection); this app only passes it along.
 *
 * The sitekey is public by design (it is sent to every browser), so it lives here rather than in
 * an env var. Widget "Otodoke", Managed mode, hostnames: otodoke.app, the dev branch Preview URL
 * and localhost. The secret key is entered only in the Supabase dashboard.
 */
export const TURNSTILE_SITEKEY = "0x4AAAAAAF1bMWXBw0RF-dvv";

/**
 * Whether Supabase Auth refuses a request without a Turnstile token (Authentication > Bot and Abuse
 * Protection > CAPTCHA, provider Turnstile). The requests the web sends with one: the sign-in with
 * the password (/login, and 設定's 「鍵を作る」 and 「パスワードを変える」, which signs in with the
 * current password), the sign-up and its 「送り直す」, and the reset mail.
 *
 * Supabase's CAPTCHA is switched in the dashboard. Its current state, and the order in which to
 * turn it on or off, are written in one place only: the CAPTCHA section of CLAUDE.md.
 *
 * It decides what the forms say and how long a press waits when the check gives no token: while it
 * is true, a press waits as long as Turnstile is still working on a token (at most
 * TURNSTILE_ENFORCED_WAIT_MS, the clock stopped while the checkbox waits for its tick), and the
 * notice asks to reload or try another browser when no token will come. Turning CAPTCHA off in the
 * dashboard again needs a commit that sets this back to false, released with it (not an env var:
 * a code change, reviewed like one).
 */
export const CAPTCHA_ENFORCED = true;

/**
 * Cloudflare requires this exact URL (no proxying or caching). `render=explicit`: the widget is
 * drawn by the login form's client component, not by scanning the page for `.cf-turnstile`.
 */
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * Turnstile's own default field name. No form has it: the widget is drawn with `response-field`
 * off, and the token is kept off the form (TokenField).
 */
export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";

/** Cloudflare's documented maximum token length. Anything longer is not a token. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

/**
 * How long a press of the login button waits for the token before sending without one, while
 * CAPTCHA is not enforced (Supabase takes the request without a token anyway).
 */
export const TURNSTILE_WAIT_MS = 10_000;

/**
 * The same once CAPTCHA is enforced: a press without a token can only fail then, so the button
 * waits as long as Turnstile is still working on a token (no token, no error it does not retry).
 * A slow phone can need more than 10 s for the challenge, and a failed send draws the form anew,
 * which starts the challenge over: waiting 10 s from the press sent it round in circles. Counting
 * from the widget's start would not help (it is shorter still). One minute bounds a widget that
 * never answers; then the press is sent without one, and the form tells Supabase's refusal.
 */
export const TURNSTILE_ENFORCED_WAIT_MS = 60_000;

/**
 * What the screen says when Supabase refused a press with its captcha code and the press had sent
 * no token (the check could not load, or never answered within TURNSTILE_ENFORCED_WAIT_MS): trying
 * again would meet the same refusal. Web only, so it is not in LOGIN_MESSAGES (shared with iOS).
 */
export const CAPTCHA_NOT_FINISHED_MESSAGE = "確認が終わりませんでした。ページを読み込み直すか、別のブラウザでお試しください。";

/**
 * The words for a press's answer: `text` as it is, except a captcha refusal of a press that sent
 * no token, which gets CAPTCHA_NOT_FINISHED_MESSAGE. A refusal of a token (expired, used) keeps
 * the shared words, where trying again does help.
 */
export function pressText(code: string, captchaToken: string | undefined, text: string): string {
  return code === "captcha" && !captchaToken ? CAPTCHA_NOT_FINISHED_MESSAGE : text;
}

/** How long a press waits for the token, by whether Supabase enforces the check. */
export function tokenWaitMs(captchaEnforced: boolean): number {
  return captchaEnforced ? TURNSTILE_ENFORCED_WAIT_MS : TURNSTILE_WAIT_MS;
}

/**
 * The token field's `data-turnstile` when no token will come: the check's script could not load,
 * Turnstile does not support the browser, or it stopped with an error it does not retry. The
 * login button then sends at once instead of waiting.
 */
export const TURNSTILE_UNAVAILABLE = "unavailable";

/**
 * Turnstile's client-side error codes after which it does not retry, so no token will come
 * (Cloudflare's error code table, the rows marked "Retry: No"): 110100 invalid sitekey, 110110
 * sitekey not found, 110200 domain not authorized, 200100 clock or cache problem, 400020 invalid
 * sitekey, 400021 sitekey domain mismatch, 400070 sitekey disabled.
 *
 * Every other code (300xxx/600xxx challenge failures, 110600/110620 timeouts, 200500 iframe load
 * error, and any code not in the table) is retried by Turnstile itself (retry: auto, every 8 s),
 * so a token can still come and the button keeps waiting for it.
 */
export const TURNSTILE_FATAL_ERRORS: readonly string[] = ["110100", "110110", "110200", "200100", "400020", "400021", "400070"];

/** Whether the error-callback's code (its first argument) is one Turnstile does not retry. */
export function turnstileErrorIsFatal(code: unknown): boolean {
  return (typeof code === "string" || typeof code === "number") && TURNSTILE_FATAL_ERRORS.includes(String(code));
}

/**
 * The token field's `data-turnstile` while Turnstile waits for the visitor to tick its checkbox:
 * Managed mode shows one to some visitors, between before-interactive-callback and
 * after-interactive-callback. No token comes until it is ticked.
 */
export const TURNSTILE_INTERACTIVE = "interactive";

/**
 * Where the widget keeps the token for the next press (src/app/login/turnstile-widget.tsx): a
 * plain object, never a form field (the forms that take a password have no named field at all).
 * `dataset.turnstile` says when no token will come (TURNSTILE_UNAVAILABLE) or the checkbox waits
 * for its tick (TURNSTILE_INTERACTIVE).
 */
export type TokenField = { value: string; dataset: Record<string, string | undefined> };

/** Nothing more to wait for: the token is there, or none will come (the script could not load). */
export function tokenSettled(field: TokenField): boolean {
  return field.value !== "" || field.dataset.turnstile === TURNSTILE_UNAVAILABLE;
}

/** Turnstile is waiting for the visitor to tick its checkbox. */
export function tokenNeedsTick(field: TokenField): boolean {
  return field.dataset.turnstile === TURNSTILE_INTERACTIVE;
}

/**
 * Holds a press until the token field is settled: resolves true when it is, false once `limitMs`
 * of waiting have passed. `onNeedsTick` hears whenever the checkbox appears or goes, so the button
 * can ask for the tick. With `pauseForTick` (CAPTCHA enforced) the clock stops while the checkbox
 * waits: no token comes without the tick, and a send without one would fail. Without it (CAPTCHA
 * off) the press is sent at the limit anyway, and Supabase takes it.
 *
 * The clock is the wall clock between polls, not the number of polls: a browser runs the timers of
 * a page it does not show about once a second (or less), and counting polls stretched 10 s to 100.
 */
export function waitForToken(
  field: TokenField,
  { limitMs, pauseForTick, onNeedsTick, intervalMs = 100 }: { limitMs: number; pauseForTick: boolean; onNeedsTick?: (needsTick: boolean) => void; intervalMs?: number },
): Promise<boolean> {
  return new Promise((resolve) => {
    if (tokenSettled(field)) {
      resolve(true);
      return;
    }
    let needsTick = tokenNeedsTick(field);
    onNeedsTick?.(needsTick);
    let waited = 0;
    let last = Date.now();
    const poll = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.max(0, now - last);
      last = now;
      if (tokenSettled(field)) {
        clearInterval(poll);
        resolve(true);
        return;
      }
      // The time since the last poll counts as it was before this poll looked: waiting for the
      // tick (paused) or Turnstile working on its own.
      if (!(pauseForTick && needsTick)) waited += elapsed;
      if (tokenNeedsTick(field) !== needsTick) {
        needsTick = !needsTick;
        onNeedsTick?.(needsTick);
      }
      if (waited >= limitMs) {
        clearInterval(poll);
        resolve(false);
      }
    }, intervalMs);
  });
}

/**
 * The token a press sends, once the field is settled (waitForToken, as long as tokenWaitMs), or
 * undefined when none came: Supabase decides then, as with a form sent without one. The caller
 * moves the widget on to a new token afterwards (each token is checked once).
 */
export async function tokenForPress(field: TokenField, { captchaEnforced = CAPTCHA_ENFORCED, onNeedsTick }: { captchaEnforced?: boolean; onNeedsTick?: (needsTick: boolean) => void } = {}): Promise<string | undefined> {
  await waitForToken(field, { limitMs: tokenWaitMs(captchaEnforced), pauseForTick: captchaEnforced, onNeedsTick });
  const token = field.value.trim();
  return token && token.length <= TURNSTILE_TOKEN_MAX_LENGTH ? token : undefined;
}


/**
 * How long a sign-in the screen tries by itself waits for its token. Nobody pressed, so nothing
 * shows the wait, and a slow phone can need more than TURNSTILE_WAIT_MS for the challenge.
 */
export const TURNSTILE_AUTO_WAIT_MS = 30_000;

/**
 * A token older than this is taken as gone. Cloudflare's tokens last 300 s; a tab the browser froze
 * in the background (iOS Safari) can be shown again before the widget's expired-callback has run,
 * with the old token still in the field.
 */
export const TURNSTILE_TOKEN_STALE_MS = 280_000;

/** `dataset.tokenAt` of the token field: when the widget put the token there (ms since the epoch). */
export function tokenIsStale(field: TokenField, { staleMs = TURNSTILE_TOKEN_STALE_MS, now = Date.now() }: { staleMs?: number; now?: number } = {}): boolean {
  const at = Number(field.dataset.tokenAt);
  return field.value !== "" && Number.isFinite(at) && at > 0 && now - at > staleMs;
}

/**
 * The token for a sign-in the screen tries by itself (/signup's waiting screen, when its tab is
 * shown again), never one a person pressed for: `send: false` when it is not to be tried now, and
 * the screen waits for its next trigger (the tab shown again, or 「確認しました」). No loop.
 *
 * - The checkbox waits for its tick: nobody is asked to tick for a try they did not press for.
 * - A token past TURNSTILE_TOKEN_STALE_MS is emptied and `onStale` called (the screen moves the
 *   widget on, which makes a new one).
 * - Otherwise a token being made is waited for (at most `limitMs`, TURNSTILE_AUTO_WAIT_MS): the
 *   widget makes a new one after each try, and Turnstile renews an expired one.
 * - No token came: with CAPTCHA enforced a send without one can only be refused, so nothing is sent
 *   (the widget shows its own notice when none will come); with it off, the send goes without one.
 */
export async function tokenForAutoAttempt(
  field: TokenField,
  { captchaEnforced = CAPTCHA_ENFORCED, limitMs = TURNSTILE_AUTO_WAIT_MS, staleMs = TURNSTILE_TOKEN_STALE_MS, onStale }: { captchaEnforced?: boolean; limitMs?: number; staleMs?: number; onStale?: () => void } = {},
): Promise<{ send: true; token: string | undefined } | { send: false }> {
  if (tokenNeedsTick(field)) return { send: false };
  if (tokenIsStale(field, { staleMs })) {
    field.value = "";
    delete field.dataset.tokenAt;
    onStale?.();
  }
  await waitForToken(field, { limitMs, pauseForTick: false });
  const token = field.value.trim();
  if (token && token.length <= TURNSTILE_TOKEN_MAX_LENGTH) return { send: true, token };
  return captchaEnforced ? { send: false } : { send: true, token: undefined };
}
