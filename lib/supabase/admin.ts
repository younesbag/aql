import "server-only";
import { createClient } from "@supabase/supabase-js";

// عميل الإدارة (service_role) — يتجاوز RLS. للخادم فقط، لا يُستورد في كود المتصفح إطلاقاً.
// "server-only" يكسر البناء فوراً لو تسرّب لحزمة العميل — حماية للمفتاح السرّي.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}
