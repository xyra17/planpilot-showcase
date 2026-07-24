"use client";
import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

type Mastery = "L1" | "L2" | "L3";

interface Task {
  id: string;
  title: string;
  estimated_mins: number;
  status: string;
}

interface CheckinStats {
  total: number;
  completed: number;
  partial: number;
  skipped: number;
  completion_rate: number;
  estimated_mins: number;
}

interface CheckinResult {
  stats: CheckinStats;
  feedback: string;
  replan_triggered?: boolean;
  debt_added?: number;
}

interface CheckinFormProps {
  goalId: string;
  goalTitle?: string;
  tasks?: Task[];
  onSuccess?: (result: CheckinResult) => void;
  onRateChange?: (rate: number) => void;
}

const MASTERY: { value: Mastery; label: string }[] = [
  { value: "L1", label: "待加强" },
  { value: "L2", label: "基本了解" },
  { value: "L3", label: "完全掌握" },
];

export function CheckinForm({ goalId, tasks = [], onSuccess, onRateChange }: CheckinFormProps) {
  const [taskMastery, setTaskMastery] = useState<Record<string, Mastery>>({});
  const [taskNotes, setTaskNotes]   = useState<Record<string, string>>({});
  const [expandedNote, setExpandedNote] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult]         = useState<CheckinResult | null>(null);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);

  const computedRate = tasks.length === 0 ? 0 : (() => {
    const score = tasks.reduce((sum, t) => {
      const m = taskMastery[t.id];
      return sum + (m === "L3" ? 1 : m === "L2" ? 0.5 : 0);
    }, 0);
    return Math.round((score / tasks.length) * 100);
  })();

  useEffect(() => { onRateChange?.(computedRate); }, [computedRate, onRateChange]);

  const submit = async () => {
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const payload = {
        mode: "daily",
        completion_rate: computedRate / 100,
        tasks: tasks.map((t) => ({
          task_id: t.id,
          mastery: taskMastery[t.id] ?? "L1",
          note: taskNotes[t.id] ?? "",
        })),
      };
      const res = await api.post<CheckinResult>(`/api/v1/checkin/${goalId}`, payload);
      setResult(res);
      onSuccess?.(res);
    } catch {
      setErrorMsg("打卡提交失败，请检查网络连接后重试。");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (result) {
    const rate = Math.round(result.stats.completion_rate * 100);
    return (
      <div className="space-y-3">
        <div className="p-3 rounded-xl border border-gray-100 bg-gray-50 text-center">
          <p className="text-2xl font-bold mb-0.5" style={{ color: "var(--accent)" }}>{rate}%</p>
          <p className="text-xs text-gray-400">今日完成率</p>
        </div>
        {result.stats.total > 0 && (
          <div className="flex gap-2 text-center text-xs">
            {[
              { label: "完全掌握", value: result.stats.completed, color: "var(--accent)" },
              { label: "基本了解", value: result.stats.partial,   color: "var(--accent)", opacity: 0.5 },
              { label: "待加强",   value: result.stats.skipped,   color: "#f87171" },
            ].map((s) => (
              <div key={s.label} className="flex-1 py-1.5 rounded-lg bg-gray-50 border border-gray-100">
                <p className="font-bold text-sm" style={{ color: s.color, opacity: s.opacity }}>{s.value}</p>
                <p className="text-gray-400 text-xs">{s.label}</p>
              </div>
            ))}
          </div>
        )}
        {result.feedback && (
          <div className="p-2.5 rounded-lg border border-gray-100 bg-white text-xs text-gray-600 leading-relaxed">
            {result.feedback}
          </div>
        )}
        {!!result.debt_added && result.debt_added > 0 && (
          <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
            新增 {result.debt_added} 条学习债务，请尽快补上。
          </div>
        )}
        {result.replan_triggered && (
          <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
            检测到连续偏差，AI 正在生成重规划方案...
          </div>
        )}
        <button onClick={() => setResult(null)}
          className="w-full py-1.5 text-xs text-gray-400 hover:text-gray-600 transition">
          重新提交
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {errorMsg && (
        <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600">
          {errorMsg}
        </div>
      )}

      {tasks.length > 0 ? (
        <div className="space-y-2">
          {tasks.map((task) => {
            const mastery = taskMastery[task.id];
            const isExpanded = expandedNote === task.id;
            return (
              <div key={task.id} className="bg-gray-50 rounded-xl border border-gray-100 p-3">
                <p className="text-xs text-gray-700 font-medium mb-2 leading-snug">{task.title}</p>
                <div className="flex gap-1.5 mb-1.5">
                  {MASTERY.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setTaskMastery((p) => ({ ...p, [task.id]: opt.value }))}
                      className={cn(
                        "flex-1 py-1 text-xs rounded-lg border transition-all font-medium",
                        mastery === opt.value
                          ? opt.value === "L3"
                            ? "border-transparent text-white"
                            : opt.value === "L2"
                            ? "bg-blue-50 border-blue-200 text-blue-600"
                            : "bg-red-50 border-red-200 text-red-500"
                          : "bg-white border-gray-200 text-gray-400 hover:bg-gray-100"
                      )}
                      style={mastery === opt.value && opt.value === "L3" ? { backgroundColor: "var(--accent)", borderColor: "var(--accent)" } : {}}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setExpandedNote(isExpanded ? null : task.id)}
                  className="text-xs text-gray-400 hover:text-gray-600 transition">
                  {isExpanded ? "收起备注" : "+ 添加备注"}
                </button>
                {isExpanded && (
                  <input
                    type="text"
                    value={taskNotes[task.id] ?? ""}
                    onChange={(e) => setTaskNotes((p) => ({ ...p, [task.id]: e.target.value }))}
                    placeholder="例：背了 40 个，10 个还需复习"
                    className="mt-1.5 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-200"
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-center text-xs text-gray-400 py-2">今日暂无计划任务</p>
      )}

      <button
        onClick={submit}
        disabled={isSubmitting}
        className="w-full py-2 text-white text-xs font-medium rounded-lg transition disabled:opacity-50 flex items-center justify-center gap-1.5"
        style={{ backgroundColor: "var(--accent)" }}>
        {isSubmitting && <Loader2 size={12} className="animate-spin" />}
        提交今日打卡
      </button>
    </div>
  );
}
