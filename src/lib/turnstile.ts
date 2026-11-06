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
 * Cloudflare requires this exact URL (no proxying or caching). `render=explicit`: the widget is
 * drawn by the login form's client component, not by scanning the page for `.cf-turnstile`.
 */
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Turnstile's own default field name; the form carries the token under it. */
export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";

/** Cloudflare's documented maximum token length. Anything longer is not a token. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

/** How long a press of the login button waits for the token before sending without one. */
export const TURNSTILE_WAIT_MS = 10_000;

/**
 * The token field's `data-turnstile` when the check's script could not load: no token will come,
 * so the login button sends at once instead of waiting.
 */
export const TURNSTILE_UNAVAILABLE = "unavailable";

/** The token field as the login button reads it. */
type TokenField = { value: string; dataset: Record<string, string | undefined> };

/** Nothing more to wait for: the token is there, or none will come (the script could not load). */
export function tokenSettled(field: TokenField): boolean {
  return field.value !== "" || field.dataset.turnstile === TURNSTILE_UNAVAILABLE;
}

/**
 * Resolves true as soon as `done()` holds, or false once `timeoutMs` has passed without it.
 * The login button holds a press on this until the token field is settled.
 */
export function waitUntil(done: () => boolean, timeoutMs = TURNSTILE_WAIT_MS, intervalMs = 100): Promise<boolean> {
  return new Promise((resolve) => {
    if (done()) {
      resolve(true);
      return;
    }
    const finish = (ok: boolean) => {
      clearInterval(poll);
      clearTimeout(limit);
      resolve(ok);
    };
    const poll = setInterval(() => {
      if (done()) finish(true);
    }, intervalMs);
    const limit = setTimeout(() => finish(done()), timeoutMs);
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
