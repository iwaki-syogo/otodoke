import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Magic-link landing. Verifies the token_hash server-side so the link works even
 * when opened in a different browser than the one that requested it.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = sanitizeNext(searchParams.get("next"));

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(`リンクを確認できませんでした（${error.message}）。もう一度リンクを送ってください。`)}`, request.url),
    );
  }
  return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent("リンクが不完全です。もう一度リンクを送ってください。")}`, request.url));
}

function sanitizeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/app";
  return value;
}
