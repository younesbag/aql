import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // يضمن تضمين ملفات data/ (context.md و voice-and-tone.md) في دوال الخادم على
  // Vercel — تُقرأ وقت التشغيل عبر fs (التصنيف والتوليد)؛ بدونها قد لا تُتتبَّع.
  outputFileTracingIncludes: {
    "/**": ["./data/**"],
  },
};

export default nextConfig;
