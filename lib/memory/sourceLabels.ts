// وسوم عربية لأنواع مصادر الذاكرة — تُستخدم في عرض المُستجوِب والبحث الدلالي.
// يشمل أنواع items وكذلك القرارات والمذكرة بعد دمجها في الاسترجاع.
export const SOURCE_AR: Record<string, string> = {
  idea: "فكرة",
  signal: "إشارة",
  voice: "ملاحظة صوتية",
  tweet: "تغريدة",
  email: "بريد",
  message: "رسالة",
  decision: "قرار",
  journal: "مذكرة",
};

export const sourceAr = (s: string): string => SOURCE_AR[s] ?? s;
