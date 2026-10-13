"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { processIncomingItem } from "@/lib/capture/process";

// حصن القناة: واجهة النظام تتحقّق من جلسة المستخدم قبل استدعاء العقل المشترك.
async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("غير مصرّح — سجّل الدخول.");
}

export async function captureText(text: string) {
  await requireUser();
  await processIncomingItem(text, "idea");
  revalidatePath("/capture");
}

export async function captureSignal(content: string, note: string) {
  await requireUser();
  const c = content.trim();
  const isUrl = /^https?:\/\//i.test(c);
  const text = note.trim() ? `${note.trim()}\n\n${c}` : c;
  await processIncomingItem(text, "signal", isUrl ? c : undefined);
  revalidatePath("/capture");
}
