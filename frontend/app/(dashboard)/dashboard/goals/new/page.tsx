"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Plus, Loader2, CheckCircle2, Clock, ChevronDown, ChevronRight } from "lucide-react";
import { useGoalStore } from "@/lib/stores/goalStore";
import { api } from "@/lib/api";
import KBCreateDrawer, { type PendingKb } from "@/components/goal/KBCreateDrawer";
import PlanModeSelector, { type KbMode, type PacingMode } from "@/components/goal/PlanModeSelector";

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

const TYPE_COLORS: Record<string, string> = {
  study: "bg-blue-100 text-blue-700",
  review: "bg-amber-100 text-amber-700",
  practice: "bg-green-100 text-green-700",
};
const TYPE_LABELS: Record<string, string> = { study: "学习", review: "复习", practice: "练习" };

function fmtDate(iso: string) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function buildDayMap(phases: PlanPhase[]): Map<string, number> {
  const dates = new Set<string>();
  for (const p of phases) for (const t of p.tasks) if (t.scheduled_date) dates.add(t.scheduled_date);
  const sorted = Array.from(dates).sort();
  const map = new Map<string, number>();
  sorted.forEach((d, i) => map.set(d, i + 1));
  return map;
}
function dayLabel(n: number) { return `day${String(n).padStart(2, "0")}`; }

interface KbItem { id: string; name: string; description: string; item_count: number; created_at: string; }

interface PlanTask { title: string; objective: string; estimated_mins: number; type: string; scheduled_date?: string; }
interface PlanPhase { name: string; focus: string; days: number; start_date?: string; end_date?: string; tasks: PlanTask[]; }
interface PlanPreviewData {
  goalId: string;
  plan_id: string;
  phases: PlanPhase[];
  total_tasks: number;
  start_date?: string;
  estimated_completion_date: string;
}

export default function NewGoalPage() {
  const router = useRouter();
  const { createGoal } = useGoalStore();

  const [type, setType] = useState<"exam" | "certification" | "skill" | "reading" | "language" | "habit">("skill");
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [dailyHours, setDailyHours] = useState(2);
  const [currentLevel, setCurrentLevel] = useState("beginner");
  const [workSchedule, setWorkSchedule] = useState<"weekday" | "weekend" | "all">("all");
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null);
  const [kbList, setKbList] = useState<KbItem[]>([]);
  const [showKbDrawer, setShowKbDrawer] = useState(false);
  const [pendingKb, setPendingKb] = useState<PendingKb | null>(null);
  const [showModeSelector, setShowModeSelector] = useState(false);
  const [createdGoalHasKb, setCreatedGoalHasKb] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [planGenerating, setPlanGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 计划预览状态
  const [planPreview, setPlanPreview] = useState<PlanPreviewData | null>(null);
  const [expandedPhase, setExpandedPhase] = useState<number | null>(0);
  const [isRegenerating, setIsRegenerating] = useState(false);

  // 创建后确认弹窗
  const [showPlanConfirm, setShowPlanConfirm] = useState(false);
  const [createdGoalId, setCreatedGoalId] = useState<string | null>(null);

  // 计划确认后同步今日任务弹窗
  const [showSyncDialog, setShowSyncDialog] = useState(false);

  useEffect(() => {
    api.get<{ items: KbItem[] }>("/api/v1/knowledge/kbs")
      .then((res) => setKbList(res.items))
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !deadline) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const goal = await createGoal({
        type,
        title: title.trim(),
        deadline,
        daily_hours: dailyHours,
        current_level: currentLevel,
        work_schedule: workSchedule,
        kb_id: selectedKbId,
        meta: {},
        pending_kb: pendingKb ? { name: pendingKb.name, description: pendingKb.description } : undefined,
      });

      setCreatedGoalHasKb(!!(pendingKb || (selectedKbId && selectedKbId !== "__new__")));
      setCreatedGoalId(goal.id);

      // 知识库内容上传：fire-and-forget，不阻塞弹窗
      if (pendingKb && goal.id) {
        const goalId = goal.id;
        void (async () => {
          for (const file of pendingKb.files) {
            const form = new FormData();
            form.append("file", file);
            form.append("goal_ids", goalId);
            try {
              await api.upload("/api/v1/knowledge/upload", form);
            } catch (e) {
              console.error("文件上传失败:", file.name, e);
            }
          }
          for (const url of pendingKb.urls) {
            try {
              await api.post("/api/v1/knowledge/url", { url, goal_id: goalId });
            } catch (e) {
              console.error("URL 导入失败:", url, e);
            }
          }
          if (pendingKb.note.trim()) {
            try {
              await api.post("/api/v1/knowledge/notes", {
                goalId,
                content: pendingKb.note.trim(),
              });
            } catch (e) {
              console.error("笔记保存失败:", e);
            }
          }
        })();
      }

      setShowPlanConfirm(true);
    } catch (err) {
      setError((err as Error).message ?? "创建失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleGeneratePlan(kbMode: KbMode, intentSupplement: string, pacingMode: PacingMode) {
    if (!createdGoalId) return;
    setShowModeSelector(false);
    setPlanGenerating(true);
    try {
      const planData = await api.post<Omit<PlanPreviewData, "goalId">>(`/api/v1/agent/macro-plan/${createdGoalId}`, {
        kb_mode: kbMode,
        user_intent_supplement: intentSupplement,
        pacing_mode: pacingMode,
      });
      setPlanPreview({ goalId: createdGoalId, ...planData });
      setExpandedPhase(0);
      setShowPlanConfirm(false);
      localStorage.setItem("tasksNeedRefresh", "1");
    } catch {
      router.push(`/dashboard/goals/${createdGoalId}`);
    } finally {
      setPlanGenerating(false);
    }
  }

  async function handleRegenerate(kbMode: KbMode, intentSupplement: string, pacingMode: PacingMode) {
    if (!planPreview) return;
    setShowModeSelector(false);
    setIsRegenerating(true);
    try {
      const planData = await api.post<Omit<PlanPreviewData, "goalId">>(`/api/v1/agent/macro-plan/${planPreview.goalId}`, {
        kb_mode: kbMode,
        user_intent_supplement: intentSupplement,
        pacing_mode: pacingMode,
      });
      setPlanPreview({ goalId: planPreview.goalId, ...planData });
      setExpandedPhase(0);
    } catch {
      // ignore
    } finally {
      setIsRegenerating(false);
    }
  }

  // ── 计划预览视图 ──────────────────────────────────────────────
  if (planPreview) {
    const dayMap = buildDayMap(planPreview.phases);
    const totalDays = dayMap.size;
    const startFmt = planPreview.start_date ? fmtDate(planPreview.start_date) : "";
    const endFmt = fmtDate(planPreview.estimated_completion_date);

    return (
      <div className="p-8 max-w-2xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
            <CheckCircle2 size={18} className="text-green-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">计划已生成，请确认</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              共 {planPreview.total_tasks} 项任务 · 预计 {totalDays} 天
              {startFmt && endFmt && `（${startFmt} - ${endFmt}）`}
            </p>
          </div>
        </div>

        {/* 阶段列表 */}
        <div className="space-y-3 mb-6">
          {planPreview.phases.map((phase, pi) => {
            const startDay = phase.start_date ? dayMap.get(phase.start_date) : undefined;
            const endDay = phase.end_date ? dayMap.get(phase.end_date) : undefined;
            const phaseRange = startDay != null && endDay != null
              ? (startDay === endDay ? dayLabel(startDay) : `${dayLabel(startDay)}-${dayLabel(endDay)}`)
              : `${phase.days} 天`;
            const phaseRangeTitle = phase.start_date && phase.end_date
              ? `${fmtDate(phase.start_date)} - ${fmtDate(phase.end_date)}`
              : "";

            return (
              <div key={pi} className="rounded-xl border border-gray-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpandedPhase(expandedPhase === pi ? null : pi)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 transition text-left"
                >
                  <div>
                    <span className="text-sm font-semibold text-gray-800">{phase.name}</span>
                    {phase.focus && (
                      <span className="ml-2 text-xs text-gray-400">{phase.focus}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs text-gray-400 font-mono cursor-default"
                      title={phaseRangeTitle}
                    >
                      {phaseRange}
                    </span>
                    <span className="text-xs text-gray-300">·</span>
                    <span className="text-xs text-gray-400">{phase.tasks.length} 项任务</span>
                    {expandedPhase === pi
                      ? <ChevronDown size={14} className="text-gray-400" />
                      : <ChevronRight size={14} className="text-gray-400" />
                    }
                  </div>
                </button>

                {expandedPhase === pi && (
                  <div className="border-t border-gray-100 bg-gray-50">
                    {phase.tasks.map((task, ti) => {
                      const dn = task.scheduled_date ? dayMap.get(task.scheduled_date) : undefined;
                      return (
                        <div key={ti} className="flex items-start gap-3 px-4 py-2.5 border-b border-gray-100 last:border-0">
                          {dn != null && (
                            <span
                              className="mt-0.5 text-xs font-mono text-gray-400 flex-shrink-0 w-12 cursor-default"
                              title={task.scheduled_date ? fmtDate(task.scheduled_date) : ""}
                            >
                              {dayLabel(dn)}
                            </span>
                          )}
                          <span className={`mt-0.5 text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${TYPE_COLORS[task.type] ?? "bg-gray-100 text-gray-600"}`}>
                            {TYPE_LABELS[task.type] ?? task.type}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-gray-800 font-medium leading-snug">{task.title}</p>
                            {task.objective && (
                              <p className="text-xs text-gray-500 mt-0.5 leading-snug">{task.objective}</p>
                            )}
                          </div>
                          <span className="flex items-center gap-0.5 text-xs text-gray-400 flex-shrink-0 mt-0.5">
                            <Clock size={10} />{task.estimated_mins} 分钟
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setShowModeSelector(true)}
            disabled={isRegenerating}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition flex items-center justify-center gap-2"
          >
            {isRegenerating ? <><Loader2 size={13} className="animate-spin" />重新生成中…</> : "重新生成"}
          </button>
          <button
            type="button"
            onClick={() => {
              const todayStr = new Date().toISOString().split("T")[0];
              const hasTodayTasks = planPreview.phases.some(p => p.tasks.some(t => t.scheduled_date === todayStr));
              if (hasTodayTasks) {
                setShowSyncDialog(true);
              } else {
                router.push(`/dashboard/goals/${planPreview.goalId}`);
              }
            }}
            className="flex-2 flex-[2] py-2.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition flex items-center justify-center gap-2"
          >
            <CheckCircle2 size={14} /> 确认启用计划
          </button>
        </div>

        {/* 同步今日任务弹窗 */}
        {showSyncDialog && (() => {
          const todayStr = new Date().toISOString().split("T")[0];
          const todayTasks = planPreview.phases.flatMap(p => p.tasks).filter(t => t.scheduled_date === todayStr);
          return (
            <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
              <div role="dialog" aria-modal="true" aria-label="确认创建学习目标" className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                    <CheckCircle2 size={18} className="text-blue-600" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-gray-900">同步今日任务</h2>
                    <p className="text-sm text-gray-500 mt-0.5">
                      今日有 {todayTasks.length} 项计划任务，是否加入今日待办？
                    </p>
                  </div>
                </div>
                <div className="mb-4 space-y-1.5 max-h-44 overflow-y-auto">
                  {todayTasks.map((t, i) => (
                    <div key={i} className="flex items-center gap-2.5 px-3 py-2 bg-gray-50 rounded-lg">
                      <span className="text-xs text-gray-400 font-mono w-12 flex-shrink-0">{t.estimated_mins}min</span>
                      <span className="text-sm text-gray-800 truncate">{t.title}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboard/goals/${planPreview.goalId}`)}
                    className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition"
                  >
                    稍后再说
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push("/dashboard")}
                    className="flex-[2] py-2.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition"
                  >
                    加入今日待办
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    );
  }

  // ── 创建后确认弹窗 ────────────────────────────────────────────
  if (showPlanConfirm && createdGoalId) {
    return (
      <>
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div role="dialog" aria-modal="true" aria-label="目标创建结果" className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                <CheckCircle2 size={20} className="text-green-600" />
              </div>
              <div>
                <h2 className="text-base font-bold text-gray-900">目标已创建！</h2>
                <p className="text-sm text-gray-500 mt-0.5">是否立即用 AI 生成学习计划？</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => router.push(`/dashboard/goals/${createdGoalId}`)}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition"
              >
                稍后再说
              </button>
              <button
                type="button"
                onClick={() => setShowModeSelector(true)}
                disabled={planGenerating}
                className="flex-[2] py-2.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition flex items-center justify-center gap-2"
              >
                {planGenerating
                  ? <><Loader2 size={13} className="animate-spin" />生成中…</>
                  : "立即生成"}
              </button>
            </div>
          </div>
        </div>
        <PlanModeSelector
          open={showModeSelector}
          hasKb={createdGoalHasKb}
          goalId={createdGoalId}
          goalType={type}
          goalTitle={title}
          onClose={() => setShowModeSelector(false)}
          onConfirm={(mode, intent, pacing) => {
            if (planPreview) {
              handleRegenerate(mode, intent, pacing);
            } else {
              handleGeneratePlan(mode, intent, pacing);
            }
          }}
        />
      </>
    );
  }

  // ── 创建表单视图 ──────────────────────────────────────────────
  return (
    <div className="p-8 max-w-xl">
      <div className="flex items-center gap-3 mb-8">
        <Link href="/dashboard/goals" className="text-gray-400 hover:text-gray-600 transition">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">新建目标</h1>
          <p className="text-sm text-gray-500 mt-0.5">填写目标信息，创建后可选择 AI 生成计划</p>
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
              min={new Date().toISOString().split("T")[0]}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              每日投入（小时）
            </label>
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

        {/* 关联知识库（可选） */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            关联知识库
            <span className="ml-1 text-xs font-normal text-gray-400">（可选，AI 将参考库内资料生成计划）</span>
          </label>
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            {/* 区块一：从已有知识库选择 */}
            <div className="p-3 bg-white">
              <p className="text-xs font-medium text-gray-400 mb-2 uppercase tracking-wide">已有知识库</p>
              {kbList.length > 0 ? (
                <div className="space-y-1 max-h-36 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => { setSelectedKbId(null); setPendingKb(null); }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                      selectedKbId === null
                        ? "bg-blue-50 text-blue-700 font-medium"
                        : "text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    不关联
                  </button>
                  {pendingKb && (
                    <button
                      type="button"
                      onClick={() => setSelectedKbId("__new__")}
                      className="w-full text-left px-3 py-2 rounded-lg transition bg-blue-50"
                    >
                      <span className="block text-sm font-medium text-blue-700">{pendingKb.name}</span>
                      <span className="block text-xs text-blue-400 mt-0.5">待创建</span>
                    </button>
                  )}
                  {kbList.map((kb) => (
                    <button
                      key={kb.id}
                      type="button"
                      onClick={() => setSelectedKbId(kb.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg transition ${
                        selectedKbId === kb.id ? "bg-blue-50" : "hover:bg-gray-50"
                      }`}
                    >
                      <span className={`block text-sm font-medium ${selectedKbId === kb.id ? "text-blue-700" : "text-gray-800"}`}>
                        {kb.name}
                      </span>
                      <span className="block text-xs text-gray-400 mt-0.5">
                        {kb.item_count > 0 ? `${kb.item_count} 个文件` : "暂无文件"}
                        {kb.description ? ` · ${kb.description}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-400 text-center py-3">暂无已有知识库</p>
              )}
            </div>

            {/* 分隔线 */}
            <div className="border-t border-gray-100" />

            {/* 区块二：新建知识库 */}
            <div className="p-3 bg-gray-50">
              {pendingKb ? (
                <div className="flex items-center justify-between px-3 py-2 bg-blue-50 rounded-lg">
                  <div>
                    <span className="text-sm font-medium text-blue-700">{pendingKb.name}</span>
                    <span className="block text-xs text-blue-400 mt-0.5">待创建</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setPendingKb(null); if (selectedKbId === "__new__") setSelectedKbId(null); }}
                    className="text-xs text-gray-400 hover:text-red-500 transition"
                  >
                    移除
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowKbDrawer(true)}
                  className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-500 hover:text-blue-600 py-1 transition"
                >
                  <Plus size={13} /> 新建知识库
                </button>
              )}
            </div>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
        )}

        <button
          type="submit"
          disabled={isSubmitting || !title.trim() || !deadline}
          className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition flex items-center justify-center gap-2"
        >
          {isSubmitting ? (
            <><Loader2 size={14} className="animate-spin" /> 创建中…</>
          ) : (
            "创建目标"
          )}
        </button>
      </form>

      <KBCreateDrawer
        open={showKbDrawer}
        onClose={() => setShowKbDrawer(false)}
        onConfirm={(kb) => {
          setPendingKb(kb);
          setSelectedKbId("__new__");
          setShowKbDrawer(false);
        }}
      />

      <PlanModeSelector
        open={showModeSelector}
        hasKb={createdGoalHasKb}
        goalId={createdGoalId ?? ""}
        goalType={type}
        goalTitle={title}
        onClose={() => setShowModeSelector(false)}
        onConfirm={(mode, intent, pacing) => {
          if (planPreview) {
            handleRegenerate(mode, intent, pacing);
          } else {
            handleGeneratePlan(mode, intent, pacing);
          }
        }}
      />
    </div>
  );
}
