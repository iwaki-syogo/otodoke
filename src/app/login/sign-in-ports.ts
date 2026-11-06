"use client";

import type { SignInPorts } from "@/lib/crypto/password-flows";
import { activateMailKey, readMailKey, registerMailKey, rewrapMailKey } from "@/app/app/settings/key-actions";
import { signInWithAuthSecret } from "./actions";
import { readSignedInAddress } from "./session-actions";

/**
 * The Actions a sign-in with the password calls (signInAndOpenKey), read when a press needs them:
 * /login's form and /signup's waiting screen sign in the same way, and make the first key the same way.
 */
export const signInPorts = (): SignInPorts => ({ signInWithAuthSecret, readSignedInAddress, readMailKey, registerMailKey, activateMailKey, rewrapMailKey });
