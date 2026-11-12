import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { accountChangedPath, displayedUserMatches } from "@/lib/action-identity";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const formData = await request.formData();
  // Route redirects must use 303 too: the recovery page accepts GET, never the old POST body.
  if (!user) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  if (!displayedUserMatches(user, formData.get("expectedUserId"))) return NextResponse.redirect(new URL(accountChangedPath("/app/settings"), request.url), { status: 303 });
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
