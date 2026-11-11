/**
 * What the login, reset and change Actions take, and nothing else. Every schema is strict: an
 * unknown field (the password, say) is refused, never ignored. The secrets are login secrets of
 * password-v1 (64 lowercase hex characters, AUTH_SECRET_PATTERN): a password typed by a person is
 * not one, so it cannot be sent in their place either.
 *
 * The screens import the types only (`import type`); the schemas are for the server and the guard
 * test (src/lib/__tests__/auth-secret-stays-in-browser.test.ts).
 */
import { z } from "zod";
import { KeyActivationSchema, KeyRewrapSchema } from "@/lib/mail-keys";
import { AUTH_SECRET_PATTERN } from "@/lib/login-form";

export const authSecretField = z.string().regex(AUTH_SECRET_PATTERN);

/** The address as typed; normalized and checked by the step (normalizeLoginAddress, isLoginAddress). */
const emailField = z.string().max(1024);

/** The Turnstile token, when the form has one. Empty or too long counts as none (login-auth.ts). */
const captchaField = z.string().max(4096).nullish();

export const SignInInputSchema = z.object({ email: emailField, authSecret: authSecretField, captchaToken: captchaField }).strict();
export type SignInInput = z.infer<typeof SignInInputSchema>;

export const SignUpInputSchema = z.object({ email: emailField, authSecret: authSecretField, captchaToken: captchaField }).strict();
export type SignUpInput = z.infer<typeof SignUpInputSchema>;

/** Sending the confirmation again, or the reset mail. */
export const MailRequestInputSchema = z.object({ email: emailField, captchaToken: captchaField }).strict();
export type MailRequestInput = z.infer<typeof MailRequestInputSchema>;

/**
 * The end of a reset: the new login secret, and the answer to the challenge of the key the browser
 * registered for it (registerMailKey), to put that key in use.
 */
export const FinishResetInputSchema = z
  .object({
    authSecret: authSecretField,
    expectedUserId: z.string().min(1).max(128),
    expectedEmailNorm: emailField,
    keyId: KeyActivationSchema.shape.keyId,
    challenge: KeyActivationSchema.shape.challenge,
    expectedCurrentKeyId: KeyActivationSchema.shape.expectedCurrentKeyId,
    expectedWrappedPrivateKey: KeyRewrapSchema.shape.previousWrappedPrivateKey.optional(),
  })
  .strict();
export type FinishResetInput = z.infer<typeof FinishResetInputSchema>;

/**
 * Changing the password while the current one is known: the current and the new login secret, and
 * the key in use wrapped again for the new password (null when there is no key in use).
 */
export const ChangeSecretInputSchema = z
  .object({
    currentAuthSecret: authSecretField,
    newAuthSecret: authSecretField,
    rewrap: KeyRewrapSchema.nullable(),
    captchaToken: captchaField,
  })
  .strict();
export type ChangeSecretInput = z.infer<typeof ChangeSecretInputSchema>;
