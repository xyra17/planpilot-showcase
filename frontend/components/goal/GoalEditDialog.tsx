"use client";

import { Target } from "lucide-react";
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
  const { status: authStatus } = useAuth();
  const { goals, fetchGoals, updateGoal } = useGoalStore();
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

  useEffect(() => {
    if (authStatus !== "loading" && goals.length === 0) void fetchGoals();
  }, [authStatus, fetchGoals, goals.length]);

  useEffect(() => {
    if (authStatus === "loading" || loaded) return;
    if (authStatus === "unauthenticated") {
      const stored = readProductArray<Record<string, unknown>>(PRODUCT_STORAGE_KEYS.goals, [])
        .find((item) => String(item.id) === goalId);
      if (stored) {
        setType(LOCAL_TYPES[String(stored.type)] ?? "skill");
        setTitle(String(stored.name ?? ""));
        setDeadline(String(stored.deadlineDate ?? ""));
        const minutes = Number.parseFloat(String(stored.daily ?? "120")) || 120;
        setDailyHours(Math.max(.5, minutes / 60));
        setCurrentLevel((stored.currentLevel as GoalLevel) ?? "beginner");
        setWorkSchedule((stored.workSchedule as WorkSchedule) ?? "all");
        setStatus(stored.status === "已暂停" ? "paused" : stored.status === "已完成" ? "completed" : "active");
        setLoaded(true);
        return;
      }
    }
    const goal = goals.find((item) => item.id === goalId);
    if (!goal) return;
    setType(goal.type);
    setTitle(goal.title);
    setDeadline(goal.deadline);
    setDailyHours(goal.daily_hours);
    setCurrentLevel((goal.current_level as GoalLevel) ?? "beginner");
    setWorkSchedule((goal.work_schedule as WorkSchedule) ?? "all");
    setStatus(goal.status);
    setLoaded(true);
  }, [authStatus, goalId, goals, loaded]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) { setError("请先填写目标名称。"); return; }
    if (!deadline) { setError("请设置目标截止日期。"); return; }
    setIsSubmitting(true);
    setError(null);
    try {
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
          type: TYPE_LABELS[type],
          deadlineDate: deadline,
          deadline: new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${deadline}T00:00:00`)),
          daily: `${Math.round(dailyHours * 60)} 分钟`,
          currentLevel,
          workSchedule,
          status: status === "paused" || status === "abandoned" ? "已暂停" : status === "completed" ? "已完成" : "进行中",
        } : item), { notifyPilo: true });
      }
      onGoalChanged?.();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败，请重试。");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!loaded) {
    return (
      <div className="tech-goal-form-page is-dialog" onMouseDown={onClose}>
        <div className={`tech-goal-form-state ${goals.length ? "is-error" : ""}`} role={goals.length ? "alert" : "status"} onMouseDown={(event) => event.stopPropagation()}>
          <Target size={20} />
          <strong>{goals.length ? "没有找到这个目标" : "正在载入目标"}</strong>
          <span>{goals.length ? "它可能已被删除，或当前账号没有访问权限。" : "稍等一下，正在准备可编辑信息。"}</span>
          {goals.length > 0 && <button type="button" onClick={onClose}>关闭</button>}
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
