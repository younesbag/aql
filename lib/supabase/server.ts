import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// عميل الخادم (Server Components / Route Handlers / Server Actions).
// ملاحظة: cookies() غير متزامنة في Next 16 — لذا الدالة async.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // تُستدعى من Server Component — تحديث الجلسة يتكفّل به middleware.
          }
        },
      },
    },
  );
}
