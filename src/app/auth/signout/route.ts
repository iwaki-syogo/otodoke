import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { forgetLogin } from "@/lib/login-email-cookie";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // And the address the login form kept for this browser (never throws).
  await forgetLogin();
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
