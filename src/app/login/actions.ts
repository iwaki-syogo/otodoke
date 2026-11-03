"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/env";

/** Send a magic link. The link lands on /auth/confirm with a token_hash (works in any browser). */
export async function sendMagicLink(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = String(formData.get("next") ?? "/app");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    redirect(`/login?error=${encodeURIComponent("メールアドレスの形式を確認してください")}`);
  }
  let origin: string;
  try {
    origin = appUrl();
  } catch (error) {
    // Do not send a link that points somewhere the user cannot open (e.g. localhost on a preview).
    console.error("[login] app URL is not configured", error);
    redirect(`/login?error=${encodeURIComponent("ログインの設定に問題があり、メールを送れませんでした")}`);
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/confirm?next=${encodeURIComponent(next)}`,
    },
  });
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  redirect(`/login?sent=${encodeURIComponent(email)}`);
}
