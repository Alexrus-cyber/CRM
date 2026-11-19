"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Подвкладки страницы «Чат с ИИ»: чат, агент и лимиты.
 *
 * Вкладки не размонтируются (`hidden`), поэтому история переписки и
 * введённый текст не теряются при переключении.
 */
export type AiTab = {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  content: ReactNode;
};

export function AiTabs({ tabs }: { tabs: AiTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? "chat");

  return (
    <div>
      <div
        role="tablist"
        aria-label="Разделы блока ИИ"
        className="mb-4 flex gap-1 overflow-x-auto rounded-2xl border border-border bg-card p-1"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(tab.id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition",
                selected
                  ? "bg-gradient-to-r from-[#7c5cff]/25 to-transparent text-text ring-1 ring-[#7c5cff]/30"
                  : "text-muted hover:bg-card2 hover:text-text",
              )}
              title={tab.hint}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div key={tab.id} role="tabpanel" hidden={tab.id !== active}>
          {tab.content}
        </div>
      ))}
    </div>
  );
}
