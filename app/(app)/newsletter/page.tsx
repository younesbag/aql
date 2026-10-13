import { NewsletterWorkspace } from "./NewsletterWorkspace";
import { fetchNewsletters } from "@/lib/newsletter/list";

// خطة Vercel الحالية (Hobby) تحدّ maxDuration بـ300 ثانية كحدّ أقصى — هذا هو السقف الفعلي، لا رفع حقيقياً هنا.
// لا يحلّ هذا مهلة xhigh + حلقة النقد (قد تتجاوز 300 ثانية فعلياً) — يتطلّب ترقية الخطة أو تعديل معماري.
export const maxDuration = 300;

// محرّك النشرة البريدية (العمود الثاني) — المعالج المرحليّ + قائمة الاستئناف (المرحلة ٤).
export default async function NewsletterPage() {
  const list = await fetchNewsletters();
  return <NewsletterWorkspace initialList={list} />;
}
