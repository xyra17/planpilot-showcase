"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  BookOpen, CalendarDays, ChevronDown, Plus,
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
  card: { label: "知识卡片", icon: <BookOpen size={14} /> },
  log: { label: "学习日志", icon: <CalendarDays size={14} /> },
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
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [createSignals, setCreateSignals] = useState<Record<Tab, number>>({
    card: 0,
    log: 0,
  });

  const raw = searchParams.get("tab");
  const tab: Tab = raw && VALID_TABS.has(raw as Tab) ? raw as Tab : "card";

  function setTab(nextTab: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", nextTab);
    router.replace(`/dashboard/notes?${params.toString()}`);
  }

  function createNote(type: Tab) {
    setTab(type);
    setCreateSignals((current) => ({ ...current, [type]: current[type] + 1 }));
    setNewMenuOpen(false);
  }

  function clearCreateSignal(type: Tab) {
    setCreateSignals((current) => ({ ...current, [type]: 0 }));
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <header
        className="flex flex-shrink-0 items-end justify-between gap-4 border-b-2 border-gray-200 bg-white px-6 pt-4"
        style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}
      >
        <div className="flex min-w-0 items-center gap-1">
          {(Object.keys(TAB_META) as Tab[]).map((item) => {
            const meta = TAB_META[item];
            return (
              <button
                key={item}
                onClick={() => setTab(item)}
                className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                  tab === item
                    ? "border-blue-500 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {meta.icon}{meta.label}
              </button>
            );
          })}
        </div>
        <div className="relative mb-2 flex-shrink-0">
          <button
            onClick={() => setNewMenuOpen((open) => !open)}
            className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
            style={{ background: "var(--accent)" }}
          >
            <Plus size={14} />新建笔记<ChevronDown size={13} />
          </button>
          {newMenuOpen && (
            <div className="absolute right-0 top-11 z-40 w-48 overflow-hidden rounded-xl border border-gray-100 bg-white p-1.5 shadow-xl">
              {(["card", "log"] as Tab[]).map((type) => (
                <button
                  key={type}
                  onClick={() => createNote(type)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-600 transition hover:bg-gray-50"
                >
                  {TAB_META[type].icon}
                  <span>{TAB_META[type].label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden p-6">
        {tab === "log" && (
          <DailyJournal
            createSignal={createSignals.log}
            onCreateHandled={() => clearCreateSignal("log")}
          />
        )}
        {tab === "card" && (
          <NotesLibrary
            createSignal={createSignals.card}
            onCreateHandled={() => clearCreateSignal("card")}
          />
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
