"use client";

import { useState, type ReactNode } from "react";

type Tab = { key: string; label: string; content: ReactNode };

// مبدّل تبويبات بسيط — يستقبل محتوى كل تبويب مُولّداً من الخادم ويعرض المُفعّل فقط.
export function InsightsTabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(tabs[0]?.key ?? "");
  const current = tabs.find((t) => t.key === active) ?? tabs[0];

  return (
    <div>
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-foreground/10">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            className={
              "-mb-px rounded-t-lg px-3 py-2 text-sm transition " +
              (active === t.key
                ? "border-b-2 border-foreground font-medium"
                : "text-foreground/60 hover:text-foreground")
            }
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div>{current?.content}</div>
    </div>
  );
}
