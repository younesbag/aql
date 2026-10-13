import Link from "next/link";
import { redirect } from "next/navigation";
import { Inbox, Brain, PenLine, BarChart3, LogOut, Sparkles, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

const NAV = [
  { href: "/chat", label: "العقل", icon: Sparkles },
  { href: "/capture", label: "الالتقاط", icon: Inbox },
  { href: "/memory", label: "الذاكرة", icon: Brain },
  { href: "/content", label: "المحتوى", icon: PenLine },
  { href: "/newsletter", label: "النشرة", icon: Mail },
  { href: "/insights", label: "الرؤى", icon: BarChart3 },
];

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 flex-col border-l border-foreground/10 p-4">
        <div className="px-2 py-3">
          <p className="text-lg font-bold">العقل الثاني</p>
          <p className="mt-1 truncate text-xs text-foreground/50" dir="ltr">
            {user?.email}
          </p>
        </div>

        <nav className="mt-4 flex flex-1 flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition hover:bg-foreground/5"
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{label}</span>
            </Link>
          ))}
        </nav>

        <form action={signOut}>
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground/70 transition hover:bg-foreground/5"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span>تسجيل الخروج</span>
          </button>
        </form>
      </aside>

      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
