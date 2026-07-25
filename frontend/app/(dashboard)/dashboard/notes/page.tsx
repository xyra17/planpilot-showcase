"use client";

import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { StickyNote, CalendarDays } from "lucide-react";
import DailyJournal from "@/components/notes/DailyJournal";
import FlashCardsWall from "@/components/notes/FlashCard";

type Tab = "card" | "log";

const VALID_TABS = new Set<Tab>(["card", "log"]);

const TAB_META: Record<Tab, { label: string; icon: React.ReactNode }> = {
  card: { label: "知识笔记", icon: <StickyNote size={14} /> },
  log:  { label: "学习记录", icon: <CalendarDays size={14} /> },
};

function NotesContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const raw = searchParams.get("tab");
  const tab: Tab = (raw && VALID_TABS.has(raw as Tab)) ? (raw as Tab) : "card";

  function setTab(t: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", t);
    router.replace(`/dashboard/notes?${params.toString()}`);
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex items-center gap-1 px-6 pt-5 pb-0 border-b-2 border-gray-200 bg-white flex-shrink-0"
        style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
        {(["card", "log"] as Tab[]).map((t) => {
          const { label, icon } = TAB_META[t];
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
                tab === t
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {icon}{label}
            </button>
          );
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "log" && <DailyJournal />}
        {tab === "card" && <FlashCardsWall />}
      </div>
    </div>
  );
}

export default function NotesPage() {
  return (
    <Suspense fallback={<div className="h-full bg-white" />}>
      <NotesContent />
    </Suspense>
  );
}
