"use client";

import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  BookOpen, CalendarDays,
} from "lucide-react";

const DailyJournal = dynamic(
  () => import("@/components/notes/DailyJournal"),
  { ssr: false, loading: () => <NotesWorkspaceLoading /> }
);

const NotesLibrary = dynamic(
  () => import("@/components/notes/NotesLibrary"),
  { ssr: false, loading: () => <NotesWorkspaceLoading /> }
);

type Tab = "card" | "log";

const VALID_TABS = new Set<Tab>(["card", "log"]);

const TAB_META: Record<Tab, { label: string; icon: React.ReactNode }> = {
  log: { label: "学习笔记", icon: <CalendarDays size={17} /> },
  card: { label: "学习日志", icon: <BookOpen size={17} /> },
};

function NotesWorkspaceLoading() {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-gray-400">
      正在加载笔记工作区…
    </div>
  );
}

function NotesContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const raw = searchParams.get("tab");
  const tab: Tab = raw && VALID_TABS.has(raw as Tab) ? raw as Tab : "log";

  function setTab(nextTab: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", nextTab);
    router.replace(`/dashboard/notes?${params.toString()}`);
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <header
        className="flex flex-shrink-0 items-end justify-between gap-4 border-b-2 border-gray-200 bg-white px-6 pt-4"
        style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}
      >
        <div className="flex min-w-0 items-center gap-1">
          {(["log", "card"] as Tab[]).map((item) => {
            const meta = TAB_META[item];
            return (
              <button
                key={item}
                onClick={() => setTab(item)}
                className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-[3px] px-5 py-3 text-base font-semibold transition ${
                  tab === item
                    ? ""
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
                style={tab === item ? {
                  borderColor: "var(--accent)",
                  color: "var(--accent)",
                } : undefined}
              >
                {meta.icon}{meta.label}
              </button>
            );
          })}
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden p-6">
        {tab === "log" && (
          <DailyJournal />
        )}
        {tab === "card" && (
          <NotesLibrary />
        )}
      </main>
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
