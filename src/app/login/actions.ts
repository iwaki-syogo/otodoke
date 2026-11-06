"use server";

import { requestResetMail, resendSignupMail, signIn, signUp } from "@/lib/login-auth";
import type { ResendResult, ResetMailResult, SignInResult, SignUpResult } from "@/lib/login-errors";
import type { MailRequestInput, SignInInput, SignUpInput } from "@/lib/login-input";

/*
 * The login screens' Actions. Each takes the login secret the browser derived (never what was
 * typed: src/lib/login-input.ts refuses any other field) and answers a result code
 * (src/lib/login-errors.ts). None redirects: after a sign-in the browser opens the key, then moves on.
 * The steps themselves are in src/lib/login-auth.ts.
 */

/** Sign in on this browser. `{ ok: true, userId }`: the session cookies are set. */
export async function signInWithAuthSecret(input: SignInInput): Promise<SignInResult> {
  return signIn(input);
}

/** Make an account; Supabase mails the confirmation link. The same answer for an address that has one. */
export async function signUpWithAuthSecret(input: SignUpInput): Promise<SignUpResult> {
  return signUp(input);
}

/** The confirmation mail again. The same answer for every address. */
export async function resendConfirmation(input: MailRequestInput): Promise<ResendResult> {
  return resendSignupMail(input);
}

/** The reset mail. The same answer for every address. */
export async function sendResetMail(input: MailRequestInput): Promise<ResetMailResult> {
  return requestResetMail(input);
}
