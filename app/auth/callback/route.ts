import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// مسار الـ callback لرابط الدخول السحري: يبادل الكود بجلسة ثم يوجّه للتطبيق.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/capture";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // فشل التبادل أو لا يوجد كود
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
