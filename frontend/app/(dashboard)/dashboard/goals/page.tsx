"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Pencil, Target, Trash2 } from "lucide-react";
import { useGoalStore } from "@/lib/stores/goalStore";
import { useTasks } from "@/lib/tasks-context";
import { api } from "@/lib/api";

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

    if (!window.confirm("确认删除该目标？相关任务和打卡记录将一并删除，此操作不可恢复。")) return;

    let deleteKb = false;
    if (goal.kb_id) {
      deleteKb = window.confirm("该目标关联了知识库，是否同时删除关联的知识库及其所有内容？\n\n点击「确定」同时删除，点击「取消」仅删除目标。");
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
    <div className="flex h-full flex-col bg-white">
      <header
        className="flex flex-shrink-0 items-end justify-between gap-4 border-b-2 border-gray-200 bg-white px-6 pt-4"
        style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}
      >
        <div
          className="-mb-px flex items-center gap-2 whitespace-nowrap border-b-[3px] px-5 py-3 text-base font-semibold"
          style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
        >
          <Target size={17} />
          我的目标
        </div>
        <Link
          href="/dashboard/goals/new"
          className="mb-2 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-xl transition hover:opacity-90"
          style={{ backgroundColor: "var(--accent)" }}
        >
          <Plus size={16} />
          新建目标
        </Link>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-gray-900">目标总览</h1>
          <p className="mt-1 text-sm text-gray-500">管理和追踪你的学习目标</p>
        </div>

        {deleteError && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 px-4 py-2 rounded-lg">
            {deleteError}
          </div>
        )}

        {isLoading && (
          <div className="text-sm text-gray-400 py-12 text-center">加载中...</div>
        )}

        {!isLoading && goals.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <p className="text-sm">还没有目标，点击右上角新建一个吧</p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {goals.map((goal) => (
          <div
            key={goal.id}
            onClick={() => router.push(`/dashboard/goals/${goal.id}`)}
            className="bg-gray-50 rounded-2xl shadow-sm border border-gray-100 p-6 hover:shadow-md hover:scale-[1.02] transition-all duration-200 cursor-pointer"
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-semibold text-gray-900 leading-snug">
                    {goal.title}
                  </h3>
                  {goal.status === "active" ? (
                    <span className="flex-shrink-0 text-xs font-semibold bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">
                      {progressMap[goal.id] ?? 0}%
                    </span>
                  ) : (
                    <span className="flex-shrink-0 text-xs font-medium bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                      {STATUS_LABEL[goal.status] ?? goal.status}
                    </span>
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
                    router.push(`/dashboard/goals/${goal.id}/edit`);
                  }}
                  className="p-1.5 rounded-lg text-gray-300 hover:text-blue-600 hover:bg-blue-50 transition"
                  title="编辑"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={(e) => handleDelete(e, goal.id)}
                  disabled={deletingId === goal.id}
                  className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition disabled:opacity-50"
                  title="删除"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-gray-50">
              <span className="text-xs text-gray-400">截止 {goal.deadline}</span>
            </div>
          </div>
          ))}
        </div>
      </main>
    </div>
  );
}
