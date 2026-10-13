"use client";

// حدّ أخطاء عربي RTL لمجموعة التطبيق — يحلّ محلّ شاشة Next الإنجليزية الافتراضية
// عند أي خطأ غير متوقّع في صفحة (مثلاً فشل استعلام Supabase)، مع زر إعادة محاولة.
export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h2 className="text-lg font-bold">حدث خطأ غير متوقّع</h2>
      <p className="mt-2 text-sm text-foreground/60">
        تعذّر تحميل هذا القسم. حاول مجدداً، وإن تكرّر أعد تحميل الصفحة.
      </p>
      <button
        onClick={reset}
        className="mt-4 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90"
      >
        إعادة المحاولة
      </button>
    </div>
  );
}
