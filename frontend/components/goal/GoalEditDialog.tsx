"use client";

import { Target } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import {
  GoalFormSurface,
  type GoalLevel,
  type WorkSchedule,
} from "@/components/technology/GoalFormSurface";
import { useAuth } from "@/components/technology/AuthProvider";
import {
  useGoalStore,
  type GoalStatus,
  type GoalType,
} from "@/lib/stores/goalStore";
import { productApi } from "@/lib/technology/productApi";
import { PRODUCT_STORAGE_KEYS, readProductArray, writeProductArray } from "@/lib/technology/productData";

const LOCAL_TYPES: Record<string, GoalType> = {
  "考试备考": "exam",
  "认证学习": "certification",
  "技能提升": "skill",
  "阅读计划": "reading",
  "语言学习": "language",
  "习惯养成": "habit",
};

const TYPE_LABELS: Record<GoalType, string> = {
  exam: "考试备考",
  certification: "认证学习",
  skill: "技能提升",
  reading: "阅读计划",
  language: "语言学习",
  habit: "习惯养成",
};

export function GoalEditDialog({
  goalId,
  onClose,
  onGoalChanged,
}: {
  goalId: string;
  onClose: () => void;
  onGoalChanged?: () => void;
}) {
  const router = useRouter();
  const { status: authStatus } = useAuth();
  const { fetchGoal, updateGoal } = useGoalStore();
  const [type, setType] = useState<GoalType>("skill");
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [dailyHours, setDailyHours] = useState(2);
  const [currentLevel, setCurrentLevel] = useState<GoalLevel>("beginner");
  const [workSchedule, setWorkSchedule] = useState<WorkSchedule>("all");
  const [status, setStatus] = useState<GoalStatus>("active");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [hasPlan, setHasPlan] = useState(false);
  const [planCheckFailed, setPlanCheckFailed] = useState(false);
  const [planReviewRequired, setPlanReviewRequired] = useState(false);
  const [initialBasis, setInitialBasis] = useState("");

  useEffect(() => {
    if (authStatus === "loading") return;
    let active = true;
    setLoaded(false);
    setLoadError(null);
    setPlanCheckFailed(false);
    if (authStatus === "unauthenticated") {
      const stored = readProductArray<Record<string, unknown>>(PRODUCT_STORAGE_KEYS.goals, [])
        .find((item) => String(item.id) === goalId);
      if (stored) {
        const nextType = (typeof stored.apiType === "string" ? stored.apiType : LOCAL_TYPES[String(stored.type)]) as GoalType ?? "skill";
        const nextTitle = String(stored.name ?? stored.title ?? "");
        const nextDeadline = String(stored.deadlineDate ?? "");
        const minutes = typeof stored.daily_hours === "number" ? stored.daily_hours * 60 : Number.parseFloat(String(stored.daily ?? "120")) || 120;
        const nextHours = Math.max(.5, minutes / 60);
        const nextLevel = (stored.currentLevel as GoalLevel) ?? (stored.current_level as GoalLevel) ?? "beginner";
        const nextSchedule = (stored.workSchedule as WorkSchedule) ?? (stored.work_schedule as WorkSchedule) ?? "all";
        const nextStatus = stored.status === "paused" || stored.status === "已暂停" ? "paused" : stored.status === "abandoned" || stored.status === "已归档" || stored.status === "已放弃" ? "abandoned" : stored.status === "completed" || stored.status === "已完成" ? "completed" : "active";
        setType(nextType);
        setTitle(nextTitle);
        setDeadline(nextDeadline);
        setDailyHours(nextHours);
        setCurrentLevel(nextLevel);
        setWorkSchedule(nextSchedule);
        setStatus(nextStatus);
        setInitialBasis(JSON.stringify({ type: nextType, deadline: nextDeadline, dailyHours: nextHours, workSchedule: nextSchedule, currentLevel: nextLevel }));
        setHasPlan(Boolean(stored.hasPlan));
        setLoaded(true);
        return;
      }
      setLoadError("没有找到这个目标。它可能已被删除，或当前浏览器没有这份本地数据。");
      return;
    }
    void Promise.all([
      fetchGoal(goalId),
      productApi.getGoalPlan(goalId)
        .then((result) => ({ result, failed: false }))
        .catch(() => ({ result: { plan: null }, failed: true })),
    ]).then(([goal, planResult]) => {
      if (!active) return;
      const nextLevel = (goal.current_level as GoalLevel) ?? "beginner";
      const nextSchedule = (goal.work_schedule as WorkSchedule) ?? "all";
      setType(goal.type);
      setTitle(goal.title);
      setDeadline(goal.deadline);
      setDailyHours(goal.daily_hours);
      setCurrentLevel(nextLevel);
      setWorkSchedule(nextSchedule);
      setStatus(goal.status);
      setInitialBasis(JSON.stringify({ type: goal.type, deadline: goal.deadline, dailyHours: goal.daily_hours, workSchedule: nextSchedule, currentLevel: nextLevel }));
      setHasPlan(Boolean(planResult.result.plan));
      setPlanCheckFailed(planResult.failed);
      setLoaded(true);
    }).catch((reason) => {
      if (active) setLoadError(reason instanceof Error ? reason.message : "目标加载失败，请重试。");
    });
    return () => { active = false; };
  }, [authStatus, fetchGoal, goalId, retryKey]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) { setError("请先填写目标名称。"); return; }
    if (!deadline) { setError("请设置目标截止日期。"); return; }
    setIsSubmitting(true);
    setError(null);
    try {
      const basisChanged = initialBasis !== JSON.stringify({ type, deadline, dailyHours, workSchedule, currentLevel });
      if (authStatus === "authenticated") {
        await updateGoal(goalId, {
          type,
          title: title.trim(),
          deadline,
          daily_hours: dailyHours,
          current_level: currentLevel,
          work_schedule: workSchedule,
          status,
        });
      } else {
        const stored = readProductArray<Record<string, unknown>>(PRODUCT_STORAGE_KEYS.goals, []);
        writeProductArray(PRODUCT_STORAGE_KEYS.goals, stored.map((item) => String(item.id) === goalId ? {
          ...item,
          name: title.trim(),
          title: title.trim(),
          type: TYPE_LABELS[type],
          apiType: type,
          deadlineDate: deadline,
          deadline: new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${deadline}T00:00:00`)),
          daily: `${Math.round(dailyHours * 60)} 分钟`,
          daily_hours: dailyHours,
          currentLevel,
          current_level: currentLevel,
          workSchedule,
          work_schedule: workSchedule,
          status,
        } : item), { notifyPilo: true });
      }
      onGoalChanged?.();
      if ((hasPlan || planCheckFailed) && basisChanged) setPlanReviewRequired(true);
      else onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败，请重试。");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (planReviewRequired) {
    return (
      <div className="tech-goal-form-page is-dialog">
        <div className="tech-goal-form-state" role="status">
          <Target size={20} />
          <strong>目标已保存</strong>
          <span>计划依据已变化，建议检查并按需调整现有计划。</span>
          <div>
            <button type="button" onClick={onClose}>稍后检查</button>
            <button type="button" onClick={() => router.replace(`/studio/work/goals/${goalId}?tab=plan`)}>检查计划</button>
          </div>
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="tech-goal-form-page is-dialog" onMouseDown={onClose}>
        <div className={`tech-goal-form-state ${loadError ? "is-error" : ""}`} role={loadError ? "alert" : "status"} onMouseDown={(event) => event.stopPropagation()}>
          <Target size={20} />
          <strong>{loadError ? "目标加载失败" : "正在载入目标"}</strong>
          <span>{loadError ?? "稍等一下，正在准备可编辑信息。"}</span>
          {loadError && <div><button type="button" onClick={() => setRetryKey((key) => key + 1)}>重试</button><button type="button" onClick={onClose}>关闭</button></div>}
        </div>
      </div>
    );
  }

  return (
    <GoalFormSurface
      presentation="dialog"
      mode="edit"
      type={type}
      title={title}
      deadline={deadline}
      dailyHours={dailyHours}
      workSchedule={workSchedule}
      currentLevel={currentLevel}
      status={status}
      isSubmitting={isSubmitting}
      authPending={authStatus === "loading"}
      error={error}
      cancelHref={`/studio/work/goals/${goalId}`}
      onCancel={onClose}
      onTypeChange={setType}
      onTitleChange={setTitle}
      onDeadlineChange={setDeadline}
      onDailyHoursChange={setDailyHours}
      onWorkScheduleChange={setWorkSchedule}
      onCurrentLevelChange={setCurrentLevel}
      onStatusChange={setStatus}
      onSubmit={handleSubmit}
    />
  );
}
