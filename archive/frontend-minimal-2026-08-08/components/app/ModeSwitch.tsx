"use client";

import Link from "next/link";
import { Bot, LayoutDashboard } from "lucide-react";

import { cn } from "@/lib/utils";

export function ModeSwitch({ mode, compact = false }: { mode: "work" | "coach"; compact?: boolean }) {
  return (
    <div className={cn("pp-mode-switch", compact && "pp-mode-switch-compact")} role="navigation" aria-label="产品模式">
      <Link href="/work" aria-current={mode === "work" ? "page" : undefined} className={cn(mode === "work" && "is-active")}>
        <LayoutDashboard size={15} />
        {!compact && <span>学习空间</span>}
      </Link>
      <Link href="/coach" aria-current={mode === "coach" ? "page" : undefined} className={cn(mode === "coach" && "is-active")}>
        <Bot size={15} />
        {!compact && <span>学习伙伴</span>}
      </Link>
    </div>
  );
}
