"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Pencil, Target, Trash2 } from "lucide-react";
import { useGoalStore } from "@/lib/stores/goalStore";
import { useTasks } from "@/lib/tasks-context";
import { api } from "@/lib/api";
import WorkspaceHeader from "@/components/ui/WorkspaceHeader";
import EmptyState from "@/components/ui/EmptyState";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineNotice } from "@/components/ui/InlineNotice";
import { StatusBadge } from "@/components/ui/StatusBadge";

const TYPE_LABEL: Record<string, string> = {
  exam: "考试",
  certification: "认证",
  skill: "技能",
};

const STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  paused: "暂停",
  abandoned: "已放弃",
};

export default function GoalsPage() {
  const { confirmAction } = useConfirmDialog();
  const router = useRouter();
  const { goals, isLoading, fetchGoals, deleteGoal } = useGoalStore();
  const { refresh: refreshTasks } = useTasks();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    fetchGoals();
  }, [fetchGoals]);

  useEffect(() => {
    const active = goals.filter((g) => g.status === "active");
    if (active.length === 0) return;
    Promise.all(
      active.map((g) =>
        api
          .get<{ plan: { total_tasks: number; completed_tasks: number } | null }>(`/api/v1/goals/${g.id}/plan`)
          .then((res) => ({
            id: g.id,
            pct: res.plan && res.plan.total_tasks > 0
              ? Math.round((res.plan.completed_tasks / res.plan.total_tasks) * 100)
              : 0,
          }))
          .catch(() => ({ id: g.id, pct: 0 }))
      )
    ).then((results) => {
      const map: Record<string, number> = {};
      results.forEach((r) => { map[r.id] = r.pct; });
      setProgressMap(map);
    });
  }, [goals]);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    setDeleteError(null);

    const goal = goals.find((g) => g.id === id);
    if (!goal) return;

    const shouldDelete = await confirmAction({
      title: "删除学习目标",
      description: "相关任务和打卡记录将一并删除，此操作不可恢复。",
      confirmLabel: "继续删除",
      tone: "danger",
    });
    if (!shouldDelete) return;

    let deleteKb = false;
    if (goal.kb_id) {
      deleteKb = await confirmAction({
        title: "处理关联知识库",
        description: "该目标关联了知识库。是否同时删除关联知识库及其中的所有内容？",
        confirmLabel: "同时删除",
        cancelLabel: "保留知识库",
        tone: "danger",
      });
    }

    setDeletingId(id);
    try {
      await deleteGoal(id, deleteKb);
      refreshTasks();
    } catch (err) {
      setDeleteError((err as Error).message ?? "删除失败，请重试");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="goals-page flex h-full flex-col">
      <WorkspaceHeader
        tabs={[{ key: "goals", label: "我的目标", icon: Target }]}
        activeKey="goals"
        actions={(
          <Link
            href="/work/goals/new"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-xl transition hover:opacity-90"
            style={{ backgroundColor: "var(--accent)" }}
          >
            <Plus size={16} />新建目标
          </Link>
        )}
      />

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        {deleteError && (
          <InlineNotice tone="danger" className="mb-4">{deleteError}</InlineNotice>
        )}

        {isLoading && (
          <div className="text-sm text-gray-400 py-12 text-center">加载中...</div>
        )}

        {!isLoading && goals.length === 0 && (
          <EmptyState
            icon={Target}
            title="还没有学习目标"
            description="创建目标后，PlanPilot 会帮助你拆解任务并追踪进度。"
            action={(
              <Link href="/work/goals/new" className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-white" style={{ backgroundColor: "var(--accent)" }}>
                <Plus size={14} />新建目标
              </Link>
            )}
          />
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {goals.map((goal) => (
          <div
            key={goal.id}
            onClick={() => router.push(`/work/goals/${goal.id}`)}
            className="goal-card bg-gray-50 rounded-2xl shadow-sm border border-gray-100 p-6 hover:shadow-md hover:scale-[1.02] transition-all duration-200 cursor-pointer"
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-semibold text-gray-900 leading-snug">
                    {goal.title}
                  </h3>
                  {goal.status === "active" ? (
                    <StatusBadge tone="info" compact>
                      {progressMap[goal.id] ?? 0}%
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone={goal.status === "completed" ? "success" : goal.status === "paused" ? "warning" : "neutral"} compact>
                      {STATUS_LABEL[goal.status] ?? goal.status}
                    </StatusBadge>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {TYPE_LABEL[goal.type] ?? goal.type} · 每日 {goal.daily_hours}h
                </p>
              </div>

              {/* 操作按钮 — 常显 */}
              <div className="flex items-center gap-0.5 ml-3 flex-shrink-0">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    router.push(`/work/goals/${goal.id}/edit`);
                  }}
                  className="goal-card-action goal-card-edit flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 transition hover:bg-accent-light hover:text-accent"
                  title="编辑"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={(e) => handleDelete(e, goal.id)}
                  disabled={deletingId === goal.id}
                  className="goal-card-action goal-card-delete flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 transition hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
                  title="删除"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-gray-100 space-y-2">
              {goal.status === "active" && (
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-400">计划完成度</span>
                    <span className="font-semibold tabular-nums" style={{ color: "var(--accent)" }}>
                      {progressMap[goal.id] ?? 0}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${progressMap[goal.id] ?? 0}%`, backgroundColor: "var(--accent)" }}
                    />
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>截止 {goal.deadline}</span>
                {goal.status === "active" && (() => {
                  const days = Math.max(0, Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / 86400000));
                  return days > 0
                    ? <span>{days} 天后到期</span>
                    : <span className="text-red-400">已过期</span>;
                })()}
              </div>
            </div>
          </div>
          ))}
        </div>
      </main>
    </div>
  );
}
