/**
 * Error words the server and the browser share for the key steps. Plain strings only: this file is
 * imported by client modules (tab-key.ts) and by server code (mail-keys.ts) alike.
 */

/**
 * The key in use is not the one the screen was drawn with (another tab or device made one since).
 * Making a key from such a stale screen would retire a key the user did not mean to replace.
 */
export const KEY_IN_USE_CHANGED = "the key in use changed";

/** The stored wrap is not the one the browser started from (changed meanwhile in another tab). */
export const KEY_WRAP_CHANGED = "the stored wrap changed";

/**
 * The input of a key step cannot be taken as sent: a value of the wrong form (not base64, the wrong
 * size, a public key that is not a P-256 point, an unknown field), a rewrap whose new wrap is the
 * one it replaces, or a key registered already. The app's mistake: sending it again does not help
 * (invalid_input; 400 on the iOS key API).
 */
export const KEY_INPUT_INVALID = "the key input is not valid";
