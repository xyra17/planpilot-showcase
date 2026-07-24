"use client";

import { useState, useEffect, useCallback } from "react";
import { Sparkles, Check, X, Loader2, Brain, Clock } from "lucide-react";
import { api } from "@/lib/api";
import { useTasks } from "@/lib/tasks-context";
import { cn } from "@/lib/utils";

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = localDate(new Date());

type DailyTaskSuggestion = {
  title: string;
  estimated_mins: number;
  type: "study" | "review" | "practice";
  source_task_id: string | null;
  reason: string;
};

type GoalDailyPlan = {
  goal_id: string;
  goal_title: string;
  daily_hours: number;
  tasks: DailyTaskSuggestion[];
};

const TYPE_LABEL: Record<string, string> = { study: "学习", review: "复习", practice: "练习" };
const TYPE_COLOR: Record<string, string> = {
  study: "bg-blue-50 text-blue-600",
  review: "bg-amber-50 text-amber-600",
  practice: "bg-green-50 text-green-600",
};

function nextQuarterHour(): string {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Props {
  onClose: () => void;
}

export function DailyPlanModal({ onClose }: Props) {
  const { addTask, refresh } = useTasks();
  const [plans, setPlans] = useState<GoalDailyPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [startStr, setStartStr] = useState(nextQuarterHour);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.post<GoalDailyPlan[]>("/api/v1/agent/daily-tasks", {})
      .then((data) => {
        setPlans(data);
        const keys = new Set<string>();
        data.forEach((plan, pi) =>
          plan.tasks.forEach((_, ti) => keys.add(`${pi}-${ti}`))
        );
        setSelected(keys);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const handleSkip = useCallback(() => {
    localStorage.setItem("lastPlanDate", TODAY);
    onClose();
  }, [onClose]);

  const handleConfirm = useCallback(async () => {
    setSubmitting(true);
    setConfirmError(null);
    try {
      const [startH, startM] = startStr.split(":").map(Number);
      let curMins = (startH ?? 9) * 60 + (startM ?? 0);

      for (let pi = 0; pi < plans.length; pi++) {
        const plan = plans[pi];
        for (let ti = 0; ti < plan.tasks.length; ti++) {
          if (!selected.has(`${pi}-${ti}`)) continue;
          const task = plan.tasks[ti];

          if (task.source_task_id) {
            await api.patch(`/api/v1/tasks/${task.source_task_id}`, { date: TODAY });
          } else {
            await addTask({
              title: task.title,
              goalId: plan.goal_id,
              goalTitle: plan.goal_title,
              estimatedMinutes: task.estimated_mins,
              date: TODAY,
              done: false,
              priority: "medium",
            });
          }
          curMins += task.estimated_mins + 10;
        }
      }
      refresh();
      onClose();
    } catch {
      setConfirmError("任务创建失败，请重试");
    } finally {
      // 无论成功或失败，都记录今日已展示，防止刷新后重复弹窗
      localStorage.setItem("lastPlanDate", TODAY);
      setSubmitting(false);
    }
  }, [plans, selected, startStr, addTask, refresh, onClose]);

  const totalSelected = selected.size;
  const totalMins = plans.flatMap((p, pi) =>
    p.tasks.filter((_, ti) => selected.has(`${pi}-${ti}`)).map((t) => t.estimated_mins)
  ).reduce((s, v) => s + v, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
      <div className="bg-white rounded-3xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* 头部 */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "var(--accent-light)" }}>
                <Brain size={16} style={{ color: "var(--accent)" }} />
              </div>
              <span className="text-base font-semibold text-gray-900">今日学习计划</span>
            </div>
            <button onClick={handleSkip} className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:bg-gray-100 transition">
              <X size={14} />
            </button>
          </div>
          <p className="text-xs text-gray-400 ml-10">AI 根据你的目标和历史进度为今日推荐任务</p>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 size={28} className="animate-spin" style={{ color: "var(--accent)" }} />
              <p className="text-sm text-gray-400">AI 正在分析你的进度...</p>
            </div>
          ) : plans.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <Sparkles size={28} className="text-gray-300" />
              <p className="text-sm text-gray-400">暂无活跃目标，前往目标页添加计划</p>
            </div>
          ) : (
            plans.map((plan, pi) => (
              <div key={plan.goal_id}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-gray-700">{plan.goal_title}</span>
                  <span className="text-xs text-gray-400">每日 {plan.daily_hours}h</span>
                </div>
                <div className="space-y-2">
                  {plan.tasks.map((task, ti) => {
                    const key = `${pi}-${ti}`;
                    const checked = selected.has(key);
                    return (
                      <button
                        key={key}
                        onClick={() => toggle(key)}
                        className={cn(
                          "w-full text-left rounded-xl px-3 py-2.5 border transition flex items-start gap-3",
                          checked ? "border-transparent bg-blue-50/60" : "border-gray-100 bg-gray-50 opacity-60"
                        )}
                      >
                        <div className={cn(
                          "w-4 h-4 rounded flex items-center justify-center flex-shrink-0 mt-0.5 border transition",
                          checked ? "border-transparent" : "border-gray-300 bg-white"
                        )} style={checked ? { background: "var(--accent)" } : {}}>
                          {checked && <Check size={10} className="text-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs font-medium text-gray-800 leading-snug">{task.title}</span>
                            <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", TYPE_COLOR[task.type] ?? "bg-gray-100 text-gray-500")}>
                              {TYPE_LABEL[task.type] ?? task.type}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[11px] text-gray-400">{task.estimated_mins} 分钟</span>
                            <span className="text-[11px] text-gray-400 truncate">{task.reason}</span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 底部操作 */}
        {!loading && plans.length > 0 && (
          <div className="px-6 py-4 border-t border-gray-100 flex-shrink-0 space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 flex-1">
                <Clock size={13} className="text-gray-400 flex-shrink-0" />
                <span className="text-xs text-gray-500">从</span>
                <input
                  type="time"
                  value={startStr}
                  onChange={(e) => setStartStr(e.target.value)}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:ring-1"
                  style={{ "--ring-color": "var(--accent)" } as React.CSSProperties}
                />
                <span className="text-xs text-gray-500">开始</span>
              </div>
              <span className="text-xs text-gray-400">
                {totalSelected} 个任务 · {totalMins >= 60 ? `${(totalMins / 60).toFixed(1)}h` : `${totalMins}min`}
              </span>
            </div>
            {confirmError && (
              <p className="text-xs text-red-500 text-center -mb-1">{confirmError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleSkip}
                className="flex-1 py-2.5 rounded-xl text-sm text-gray-500 bg-gray-100 hover:bg-gray-200 transition font-medium"
              >
                跳过
              </button>
              <button
                onClick={handleConfirm}
                disabled={submitting || totalSelected === 0}
                className="flex-[2] py-2.5 rounded-xl text-sm text-white font-medium transition disabled:opacity-50 flex items-center justify-center gap-1.5"
                style={{ background: "var(--accent)" }}
              >
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {submitting ? "生成中..." : "确认并开始学习"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
