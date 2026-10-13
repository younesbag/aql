"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg("");
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) {
        setStatus("error");
        setErrorMsg(error.message);
      } else {
        setStatus("sent");
      }
    } catch (err) {
      // يلتقط أي استثناء (مثل عدم تحميل متغيّرات البيئة في حزمة المتصفح)
      setStatus("error");
      setErrorMsg(
        err instanceof Error ? err.message : "خطأ غير متوقّع أثناء الإرسال",
      );
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-foreground/10 p-8 shadow-sm">
        <h1 className="text-2xl font-bold">العقل الثاني</h1>
        <p className="mt-2 text-sm text-foreground/60">
          نظام ذاكرتك ومحتواك وقراراتك. سجّل دخولك برابط سحري.
        </p>

        {status === "sent" ? (
          <div className="mt-6 rounded-lg bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-400">
            أرسلنا رابط الدخول إلى{" "}
            <span dir="ltr" className="font-medium">
              {email}
            </span>
            . افتح بريدك واضغط الرابط لتسجيل الدخول.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium">
                البريد الإلكتروني
              </label>
              <input
                id="email"
                type="email"
                required
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-left outline-none focus:border-foreground/40"
              />
            </div>
            {status === "error" && (
              <p className="text-sm text-red-600 dark:text-red-400">
                تعذّر الإرسال: {errorMsg}
              </p>
            )}
            <button
              type="submit"
              disabled={status === "sending" || email.length === 0}
              className="w-full rounded-lg bg-foreground px-4 py-2 font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            >
              {status === "sending" ? "جارٍ الإرسال…" : "أرسل رابط الدخول"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
