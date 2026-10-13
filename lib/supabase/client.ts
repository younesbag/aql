import { createBrowserClient } from "@supabase/ssr";

// عميل المتصفح (Client Components). يستخدم المفتاح العام anon.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
