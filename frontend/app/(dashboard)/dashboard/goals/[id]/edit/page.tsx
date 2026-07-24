"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useGoalStore } from "@/lib/stores/goalStore";

const GOAL_TYPES = [
  { value: "exam",          label: "备考",     desc: "高考、考研、公务员等" },
  { value: "certification", label: "认证",     desc: "CPA、CFA、PMP 等" },
  { value: "skill",         label: "技能",     desc: "编程、设计、工具等" },
  { value: "reading",       label: "阅读",     desc: "读书、精读论文等" },
  { value: "language",      label: "语言学习", desc: "英语、日语等" },
  { value: "habit",         label: "习惯养成", desc: "运动、冥想、写作等" },
] as const;

const LEVELS = [
  { value: "beginner", label: "入门" },
  { value: "intermediate", label: "中级" },
  { value: "advanced", label: "高级" },
] as const;

const SCHEDULES = [
  { value: "weekday", label: "仅工作日" },
  { value: "weekend", label: "仅周末" },
  { value: "all", label: "每天" },
] as const;

const STATUS_OPTIONS = [
  { value: "active", label: "进行中" },
  { value: "paused", label: "暂停" },
  { value: "completed", label: "已完成" },
  { value: "abandoned", label: "已放弃" },
] as const;

export default function EditGoalPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { goals, fetchGoals, updateGoal } = useGoalStore();

  const [type, setType] = useState<"exam" | "certification" | "skill" | "reading" | "language" | "habit">("skill");
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [dailyHours, setDailyHours] = useState(2);
  const [currentLevel, setCurrentLevel] = useState("beginner");
  const [workSchedule, setWorkSchedule] = useState<"weekday" | "weekend" | "all">("all");
  const [status, setStatus] = useState<"active" | "completed" | "paused" | "abandoned">("active");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (goals.length === 0) {
      fetchGoals();
    }
  }, [fetchGoals, goals.length]);

  useEffect(() => {
    const goal = goals.find((g) => g.id === params.id);
    if (goal && !loaded) {
      setType(goal.type);
      setTitle(goal.title);
      setDeadline(goal.deadline);
      setDailyHours(goal.daily_hours);
      setCurrentLevel(goal.current_level);
      setWorkSchedule((goal.work_schedule as "weekday" | "weekend" | "all") ?? "all");
      setStatus(goal.status);
      setLoaded(true);
    }
  }, [goals, params.id, loaded]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !deadline) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await updateGoal(params.id, {
        type,
        title: title.trim(),
        deadline,
        daily_hours: dailyHours,
        current_level: currentLevel,
        work_schedule: workSchedule,
        status,
      });
      router.push(`/dashboard/goals/${params.id}`);
    } catch (err) {
      setError((err as Error).message ?? "保存失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!loaded && goals.length === 0) {
    return <div className="p-8 text-sm text-gray-400">加载中...</div>;
  }

  if (loaded === false && goals.length > 0) {
    return <div className="p-8 text-sm text-gray-400">目标不存在</div>;
  }

  return (
    <div className="p-8 max-w-xl">
      <div className="flex items-center gap-3 mb-8">
        <Link href={`/dashboard/goals/${params.id}`} className="text-gray-400 hover:text-gray-600 transition">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">编辑目标</h1>
          <p className="text-sm text-gray-500 mt-0.5">修改目标信息</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* 目标类型 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">目标类型</label>
          <div className="grid grid-cols-3 gap-3">
            {GOAL_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setType(t.value)}
                className={`text-left p-3 rounded-xl border-2 transition ${
                  type === t.value
                    ? "border-blue-600 bg-blue-50"
                    : "border-gray-200 bg-white hover:border-gray-300"
                }`}
              >
                <span className={`block text-sm font-medium ${type === t.value ? "text-blue-600" : "text-gray-800"}`}>
                  {t.label}
                </span>
                <span className="block text-xs text-gray-400 mt-0.5 leading-tight">{t.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 目标名称 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">目标名称</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            placeholder="例如：2026 年 CPA 会计科目"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition"
          />
        </div>

        {/* 截止日期 + 每日投入 */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">截止日期</label>
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">每日投入（小时）</label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0.5}
                max={8}
                step={0.5}
                value={dailyHours}
                onChange={(e) => setDailyHours(Number(e.target.value))}
                className="flex-1 accent-blue-600"
              />
              <span className="text-sm font-semibold text-gray-700 w-8 text-right">{dailyHours}h</span>
            </div>
          </div>
        </div>

        {/* 学习安排 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">学习安排</label>
          <div className="flex gap-3">
            {SCHEDULES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setWorkSchedule(s.value)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${
                  workSchedule === s.value
                    ? "border-blue-600 bg-blue-50 text-blue-600"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* 当前水平 */}
        {type !== "reading" && type !== "habit" && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">当前水平</label>
          <div className="flex gap-3">
            {LEVELS.map((l) => (
              <button
                key={l.value}
                type="button"
                onClick={() => setCurrentLevel(l.value)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${
                  currentLevel === l.value
                    ? "border-blue-600 bg-blue-50 text-blue-600"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        )}

        {/* 目标状态 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">目标状态</label>
          <div className="grid grid-cols-4 gap-2">
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setStatus(s.value)}
                className={`py-2 rounded-lg text-sm font-medium border transition ${
                  status === s.value
                    ? "border-blue-600 bg-blue-50 text-blue-600"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
        )}

        <div className="flex gap-3">
          <Link
            href={`/dashboard/goals/${params.id}`}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition text-center"
          >
            取消
          </Link>
          <button
            type="submit"
            disabled={isSubmitting || !title.trim() || !deadline}
            className="flex-[2] bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition flex items-center justify-center gap-2"
          >
            {isSubmitting ? <><Loader2 size={14} className="animate-spin" /> 保存中…</> : "保存修改"}
          </button>
        </div>
      </form>
    </div>
  );
}
