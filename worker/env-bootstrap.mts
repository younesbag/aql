// ════════════════════════════════════════════════════════════
// تحميل worker/.env.worker متزامناً عند الاستيراد (قبل أي وحدة أخرى).
// لماذا ملف مستقل: وحدات lib (مثل config/owner) تقرأ process.env وقت التقييم،
// والاستيرادات الساكنة في ESM تُقيَّم قبل أي دالة async في ملف العامل نفسه —
// فلو حُمّل الملف داخل دالة لضاع OWNER_NAME في برومبتات العامل.
// بلا تبعية dotenv — سطور KEY=VALUE بسيطة، والمتغيرات المضبوطة خارجياً تتقدّم.
// ════════════════════════════════════════════════════════════
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".env.worker");
try {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // لا ملف env — نعتمد على متغيرات البيئة المضبوطة خارجياً (systemd مثلاً)
}
