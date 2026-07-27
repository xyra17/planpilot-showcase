"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarCheck, ChevronDown, Flame, Clock, CheckCircle2, Circle } from "lucide-react";
import { CheckinForm } from "@/components/agent/CheckinForm";
import { DebtCard } from "@/components/agent/DebtCard";
import { useGoalStore } from "@/lib/stores/goalStore";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function formatDate(d: Date) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

interface StreakData { streak_days: number; avg_completion_rate: number }

function CheckinContent() {
  const searchParams = useSearchParams();
  const paramGoalId = searchParams.get("goalId");
  const { goals, currentGoalId, fetchGoals, fetchTodayTasks, todayTasks, setCurrentGoal } = useGoalStore();
  const [isGoalOpen, setIsGoalOpen] = useState(false);
  const [streak, setStreak] = useState<StreakData | null>(null);

  const activeGoalId = paramGoalId ?? currentGoalId ?? goals.find((g) => g.status === "active")?.id ?? null;
  const activeGoal = goals.find((g) => g.id === activeGoalId);
  const activeGoals = goals.filter((g) => g.status === "active");

  useEffect(() => { fetchGoals(); }, [fetchGoals]);

  useEffect(() => {
    if (activeGoalId) {
      fetchTodayTasks(activeGoalId);
      api.get<StreakData>(`/api/v1/goals/${activeGoalId}/progress`)
        .then((d) => setStreak({ streak_days: d.streak_days, avg_completion_rate: d.avg_completion_rate }))
        .catch(() => null);
    }
  }, [activeGoalId, fetchTodayTasks]);

  const done = todayTasks.filter((t) => t.status === "completed").length;
  const today = new Date();

  return (
    <div className="max-w-xl mx-auto px-4 py-8 space-y-5">
      {/* 日期 + 连续打卡 */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ backgroundColor: "var(--accent-light)" }}>
              <CalendarCheck size={18} style={{ color: "var(--accent)" }} />
            </div>
            <h1 className="text-xl font-bold text-gray-900">每日打卡</h1>
          </div>
          <p className="text-sm text-gray-400 pl-10">{formatDate(today)}</p>
        </div>
        {streak && streak.streak_days > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-2xl bg-orange-50 border border-orange-100">
            <Flame size={15} className="text-orange-500" />
            <span className="text-sm font-semibold text-orange-600">{streak.streak_days} 天</span>
          </div>
        )}
      </div>

      {/* 目标选择 */}
      {activeGoals.length > 0 && (
        <div className="relative">
          <button
            onClick={() => setIsGoalOpen((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 bg-white border border-gray-200 rounded-2xl text-sm hover:border-gray-300 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: "var(--accent)" }} />
              <div className="min-w-0">
                <p className="font-medium text-gray-800 truncate">{activeGoal?.title ?? "选择目标"}</p>
                {activeGoal && (
                  <p className="text-xs text-gray-400">截止 {activeGoal.deadline} · 每日 {activeGoal.daily_hours}h</p>
                )}
              </div>
            </div>
            <ChevronDown size={16} className={cn("text-gray-400 transition-transform flex-shrink-0 ml-2", isGoalOpen && "rotate-180")} />
          </button>
          {isGoalOpen && activeGoals.length > 1 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-2xl shadow-lg z-10 overflow-hidden">
              {activeGoals.map((g) => (
                <button key={g.id}
                  onClick={() => { setCurrentGoal(g.id); setIsGoalOpen(false); }}
                  className={cn("w-full px-4 py-3 text-sm text-left hover:bg-gray-50 transition flex items-center gap-3")}
                >
                  <div className={cn("w-2 h-2 rounded-full flex-shrink-0", g.id === activeGoalId ? "bg-blue-500" : "bg-gray-300")} />
                  <div>
                    <p className={cn("font-medium", g.id === activeGoalId ? "text-blue-600" : "text-gray-700")}>{g.title}</p>
                    <p className="text-xs text-gray-400">截止 {g.deadline}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {activeGoalId ? (
        <>
          {/* 今日任务摘要 */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500">今日计划</span>
              <span className="text-xs font-medium" style={{ color: "var(--accent)" }}>
                {done}/{todayTasks.length} 完成
              </span>
            </div>
            {todayTasks.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-5">
                暂无计划任务 — AI 生成计划后将在此显示
              </p>
            ) : (
              <div className="px-4 py-3 space-y-2">
                {todayTasks.slice(0, 5).map((t) => (
                  <div key={t.id} className="flex items-center gap-2.5 text-sm">
                    {t.status === "completed"
                      ? <CheckCircle2 size={14} style={{ color: "var(--accent)" }} className="flex-shrink-0" />
                      : <Circle size={14} className="text-gray-200 flex-shrink-0" />}
                    <span className={cn("flex-1 truncate", t.status === "completed" ? "text-gray-400 line-through" : "text-gray-700")}>
                      {t.title}
                    </span>
                    <span className="text-xs text-gray-400 flex items-center gap-0.5 flex-shrink-0">
                      <Clock size={10} />{t.estimated_mins}m
                    </span>
                  </div>
                ))}
                {todayTasks.length > 5 && (
                  <p className="text-xs text-gray-400 pl-6">+ {todayTasks.length - 5} 项</p>
                )}
              </div>
            )}
          </div>

          {/* 学习债务 */}
          <DebtCard goalId={activeGoalId} />

          {/* 打卡表单 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <p className="text-xs font-semibold text-gray-500 mb-4">今日完成情况</p>
            <CheckinForm
              goalId={activeGoalId}
              goalTitle={activeGoal?.title}
              tasks={todayTasks}
              onSuccess={() => fetchTodayTasks(activeGoalId)}
              onReplanRequest={async () => {
                if (!activeGoalId) return;
                try {
                  await api.post(`/api/v1/agent/reschedule/${activeGoalId}`, {});
                  await fetchTodayTasks(activeGoalId);
                } catch {}
              }}
            />
          </div>
        </>
      ) : (
        <div className="py-20 text-center">
          <div className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center bg-gray-100">
            <CalendarCheck size={24} className="text-gray-300" />
          </div>
          <p className="text-sm text-gray-500 mb-1">还没有进行中的目标</p>
          <a href="/dashboard/goals/new" className="text-sm font-medium hover:underline" style={{ color: "var(--accent)" }}>
            去创建第一个目标 →
          </a>
        </div>
      )}
    </div>
  );
}

export default function CheckinPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-gray-400 text-center">加载中...</div>}>
      <CheckinContent />
    </Suspense>
  );
}
