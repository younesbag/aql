import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// دمج أصناف Tailwind بأمان (يحلّ التعارضات). تُستخدم في كل المكوّنات.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
