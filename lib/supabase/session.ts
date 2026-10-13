import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// يحدّث جلسة Supabase على كل طلب ويحمي المسارات.
// المسارات العامة: /login و /auth (callback). كل ما عداها يتطلّب تسجيل دخول.
// يُستدعى من proxy.ts (المسمّى middleware سابقاً قبل Next.js 16).
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // مهم: لا تُدخل أي كود بين إنشاء العميل و getUser (يكسر تحديث الجلسة).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = pathname.startsWith("/login") || pathname.startsWith("/auth");

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && pathname.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/capture";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
