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
 * Whether Supabase refuses a login mail without a Turnstile token (Authentication > Bot and Abuse
 * Protection > CAPTCHA). Off on 2026-11-06: a press without a token still sends the mail.
 *
 * It decides what the login form says and how long it waits when the check gives no token: while
 * it is false, nobody is told to reload or try another browser (the mail goes out anyway), and a
 * press waits at most TURNSTILE_WAIT_MS. Turning CAPTCHA on in the dashboard needs a commit that
 * sets this to true, released with it (not an env var: a code change, reviewed like one).
 */
export const CAPTCHA_ENFORCED = false;

/**
 * Cloudflare requires this exact URL (no proxying or caching). `render=explicit`: the widget is
 * drawn by the login form's client component, not by scanning the page for `.cf-turnstile`.
 */
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Turnstile's own default field name; the form carries the token under it. */
export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";

/** Cloudflare's documented maximum token length. Anything longer is not a token. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

/**
 * How long a press of the login button waits for the token before sending without one, while
 * CAPTCHA is not enforced (the mail goes out without a token anyway).
 */
export const TURNSTILE_WAIT_MS = 10_000;

/**
 * The same once CAPTCHA is enforced: a press without a token can only fail then, so the button
 * waits as long as Turnstile is still working on a token (no token, no error it does not retry).
 * A slow phone can need more than 10 s for the challenge, and a failed send draws the form anew,
 * which starts the challenge over: waiting 10 s from the press sent it round in circles. Counting
 * from the widget's start would not help (it is shorter still). One minute bounds a widget that
 * never answers; then the press is sent and Supabase's answer (captcha_missing) says what to do.
 */
export const TURNSTILE_ENFORCED_WAIT_MS = 60_000;

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

/** The token field as the login button reads it. */
type TokenField = { value: string; dataset: Record<string, string | undefined> };

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
 * off) the press is sent at the limit anyway, and the mail goes out.
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
    const poll = setInterval(() => {
      if (tokenSettled(field)) {
        clearInterval(poll);
        resolve(true);
        return;
      }
      if (tokenNeedsTick(field) !== needsTick) {
        needsTick = !needsTick;
        onNeedsTick?.(needsTick);
      }
      if (!(pauseForTick && needsTick)) waited += intervalMs;
      if (waited >= limitMs) {
        clearInterval(poll);
        resolve(false);
      }
    }, intervalMs);
  });
}

/**
 * The token from a submitted form, or undefined when there is none (script blocked, not solved
 * yet, no JavaScript). Undefined is passed on as "no token": Supabase ignores it while CAPTCHA
 * is off and answers `captcha_failed` once it is on.
 */
export function turnstileToken(formData: FormData): string | undefined {
  const value = formData.get(TURNSTILE_RESPONSE_FIELD);
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  if (!token || token.length > TURNSTILE_TOKEN_MAX_LENGTH) return undefined;
  return token;
}
