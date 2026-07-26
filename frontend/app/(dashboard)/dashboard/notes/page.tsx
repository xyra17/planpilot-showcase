"use client";

import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  BookOpen, CalendarDays,
} from "lucide-react";
import WorkspaceHeader from "@/components/ui/WorkspaceHeader";

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
  const initialGoalId = searchParams.get("goalId") || undefined;
  const createRequested = searchParams.get("create") === "1";

  function setTab(nextTab: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", nextTab);
    router.replace(`/dashboard/notes?${params.toString()}`);
  }

  function clearCreateRequest() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("create");
    router.replace(`/dashboard/notes?${params.toString()}`);
  }

  function clearGoalFilter() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("goalId");
    params.delete("create");
    router.replace(`/dashboard/notes?${params.toString()}`);
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <WorkspaceHeader
        tabs={[
          { key: "log", label: "学习笔记", icon: CalendarDays },
          { key: "card", label: "学习日志", icon: BookOpen },
        ]}
        activeKey={tab}
        onChange={(key) => setTab(key as Tab)}
      />

      <main className="flex flex-1 min-h-0 flex-col overflow-hidden p-6">
        {initialGoalId && (
          <div className="mb-3 flex flex-shrink-0 items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-500">
            <span>仅显示当前目标关联的内容</span>
            <button onClick={clearGoalFilter} className="font-medium hover:underline" style={{ color: "var(--accent)" }}>
              查看全部
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {tab === "log" && (
            <DailyJournal
              initialGoalId={initialGoalId}
              createSignal={createRequested ? 1 : 0}
              onCreateHandled={clearCreateRequest}
            />
          )}
          {tab === "card" && (
            <NotesLibrary
              initialGoalId={initialGoalId}
              createSignal={createRequested ? 1 : 0}
              onCreateHandled={clearCreateRequest}
            />
          )}
        </div>
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
