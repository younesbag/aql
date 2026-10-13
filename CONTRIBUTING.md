# المساهمة — Contributing

شكراً لاهتمامك. المشروع قالب لنظام ذكاء شخصي لمستخدم واحد؛ نرحّب بالإصلاحات والتحسينات التي تحترم قراراته المعمارية.

## قبل أن تبدأ

1. اقرأ [`CLAUDE.md`](CLAUDE.md) كاملاً — هو الدستور الهندسي (الأعراف، الأخطاء المسمّاة، فحوص الجودة). يسري على المساهمين البشر ووكلاء الذكاء الاصطناعي معاً.
2. للتركيب المحلي: [`docs/SETUP.md`](docs/SETUP.md).
3. تغيير يمسّ قراراً معمارياً محسوماً (CLAUDE.md §٢: أبعاد التضمين، أطر الوكلاء، SDKs، طابور التوليد) يبدأ بـissue للنقاش، لا بـPR.

## سير العمل

- فرع لكل تغيير، ثم pull request إلى `main`. نطاق واحد لكل PR.
- قبل فتح الـPR: `npm run build` و`npm run lint` بلا أخطاء. أي تعديل يمسّ نداءات الذكاء أو البرومبتات يمرّ بفحص `/smoke-ai` (انظر `.claude/skills/smoke-ai/SKILL.md`) ويُسجَّل رقمه في وصف الـPR.
- الهجرات: ملف جديد مرقّم دائماً (`00xx_اسم.sql`)، لا تعديل هجرة منشورة، مع RLS وCHECK، وتحديث `schema.sql`.
- الواجهة عربية بالكامل وRTL، بلا أحرف لاتينية ظاهرة.
- لا تُرفق مفاتيح ولا ملفات `.env*` ولا بياناتك الشخصية في `data/`.

## الإبلاغ عن مشكلة

افتح issue بخطوات إعادة الإنتاج والرسالة الكاملة للخطأ. لمشاكل الهجرة الأولى `0001_init.sql` ألصق رقم السطر ونص الخطأ كاملاً — الهجرة مجمّعة من هجرات تاريخية ولم تُختبر على نطاق واسع بعد.

---

## English

Thanks for your interest. This is a template for a single-owner personal intelligence system; fixes and improvements that respect its architectural decisions are welcome.

1. Read [`CLAUDE.md`](CLAUDE.md) in full — it is the engineering constitution (conventions, named mistakes, quality checklists) for human and AI contributors alike.
2. Local setup: [`docs/SETUP.md`](docs/SETUP.md).
3. Changes that touch a settled architectural decision (CLAUDE.md section 2: embedding dimensions, agent frameworks, SDKs, the generation queue) start with an issue, not a PR.
4. Workflow: one branch per change, PR into `main`, one scope per PR. Before opening it, `npm run build` and `npm run lint` must be clean; any change touching AI calls or prompts goes through the `/smoke-ai` check with its numbers in the PR description.
5. Migrations: always a new numbered file, never edit a published one, include RLS and CHECK constraints, and update `schema.sql`.
6. The UI is fully Arabic and RTL with no visible Latin text.
7. Never include keys, `.env*` files or your personal data in `data/`.
8. Bug reports: steps to reproduce plus the full error message. For failures of the first migration `0001_init.sql`, include the line number and the complete error — it was assembled from historical migrations and has not been widely tested yet.
