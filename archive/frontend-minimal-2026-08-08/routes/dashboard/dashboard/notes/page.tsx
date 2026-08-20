"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { NotebookPen, Plus, Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

const DailyJournal = dynamic(
  () => import("@/components/notes/DailyJournal"),
  { ssr: false, loading: () => <NotesWorkspaceLoading /> }
);

function NotesWorkspaceLoading() {
  return (
    <div className="notes-loading-grid" aria-label="正在加载笔记工作区">
      <span /><span /><span />
    </div>
  );
}

function NotesContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [createSignal, setCreateSignal] = useState(0);
  const [isEditing, setIsEditing] = useState(false);

  const initialGoalId = searchParams.get("goalId") || undefined;
  const createRequested = searchParams.get("create") === "1";

  function clearCreateRequest() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("create");
    router.replace(`/work/notes?${params.toString()}`);
  }

  function clearGoalFilter() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("goalId");
    params.delete("create");
    router.replace(`/work/notes?${params.toString()}`);
  }

  return (
    <div className="notes-page h-full flex flex-col">
      <header className="notes-hero">
        <div className="notes-hero-main">
          <motion.div
            className="notes-hero-icon"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            aria-hidden="true"
          >
            <NotebookPen size={22} />
          </motion.div>
          <div className="min-w-0 flex-1">
            <div className="notes-hero-kicker"><Sparkles size={12} /> KNOWLEDGE LOG</div>
            <h1>笔记</h1>
            <p>记录学习脉络，让每一次思考都能回到目标与行动。</p>
          </div>
          <button
            type="button"
            className="notes-primary-button"
            disabled={isEditing}
            title={isEditing ? "请先保存或退出当前笔记" : "新建笔记"}
            onClick={() => setCreateSignal((signal) => signal + 1)}
          >
            <Plus size={16} />新建笔记
          </button>
        </div>
      </header>

      <main className="notes-main flex flex-1 min-h-0 flex-col overflow-hidden">
        {initialGoalId && (
          <div className="notes-filter-banner">
            <span>正在查看当前目标关联的学习笔记</span>
            <button type="button" onClick={clearGoalFilter}>
              查看全部
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <DailyJournal
            initialGoalId={initialGoalId}
            createSignal={createRequested ? createSignal + 1 : createSignal}
            onCreateHandled={createRequested ? clearCreateRequest : undefined}
            onEditingChange={setIsEditing}
          />
        </div>
      </main>
    </div>
  );
}

export default function NotesPage() {
  return (
    <Suspense fallback={<div className="notes-page min-h-screen" />}>
      <NotesContent />
    </Suspense>
  );
}
