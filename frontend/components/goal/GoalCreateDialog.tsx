"use client";

import { CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import PlanModeSelector, { type KbMode, type PacingMode } from "@/components/goal/PlanModeSelector";
import { useAuth } from "@/components/technology/AuthProvider";
import {
  GoalFormSurface,
  type GoalLevel,
  type WorkSchedule,
} from "@/components/technology/GoalFormSurface";
import { api } from "@/lib/api";
import { useGoalStore, type GoalType } from "@/lib/stores/goalStore";
import {
  PRODUCT_STORAGE_KEYS,
  readProductArray,
  writeProductArray,
} from "@/lib/technology/productData";

const TYPE_LABELS: Record<GoalType, string> = {
  exam: "考试备考",
  certification: "认证学习",
  skill: "技能提升",
  reading: "阅读计划",
  language: "语言学习",
  habit: "习惯养成",
};

function formatGoalDeadline(value: string) {
  if (!value) return "待设置";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date);
}

export function GoalCreateDialog({ onClose, onGoalChanged }: { onClose: () => void; onGoalChanged?: () => void }) {
  const router = useRouter();
  const { status: authStatus } = useAuth();
  const createGoal = useGoalStore((state) => state.createGoal);
  const [type, setType] = useState<GoalType>("exam");
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [dailyHours, setDailyHours] = useState(2);
  const [workSchedule, setWorkSchedule] = useState<WorkSchedule>("weekday");
  const [currentLevel, setCurrentLevel] = useState<GoalLevel>("beginner");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [createdGoalId, setCreatedGoalId] = useState<string | null>(null);
  const [showCreatedDialog, setShowCreatedDialog] = useState(false);
  const [showPlanMode, setShowPlanMode] = useState(false);
  const [planGenerating, setPlanGenerating] = useState(false);
  const [planError, setPlanError] = useState("");

  function createLocalGoal() {
    const id = `local-goal-${Date.now()}`;
    const localGoal = {
      id,
      name: title.trim(),
      title: title.trim(),
      type: TYPE_LABELS[type],
      apiType: type,
      progress: 0,
      deadline: formatGoalDeadline(deadline),
      deadlineDate: deadline,
      daily: `${Math.round(dailyHours * 60)} 分钟`,
      daily_hours: dailyHours,
      current_level: currentLevel,
      work_schedule: workSchedule,
      status: "active",
      next: "等待生成学习计划",
      taskSummary: "0 / 0 个任务",
      rhythmSummary: "尚未开始",
      currentLevel,
      workSchedule,
    };
    const current = readProductArray<typeof localGoal>(PRODUCT_STORAGE_KEYS.goals, []);
    writeProductArray(PRODUCT_STORAGE_KEYS.goals, [localGoal, ...current], { notifyPilo: true });
    return id;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) { setFormError("请先填写目标名称。"); return; }
    if (!deadline) { setFormError("请设置目标截止日期。"); return; }
    if (authStatus === "loading") { setFormError("正在确认登录状态，请稍后再试。"); return; }
    setFormError("");
    setIsSubmitting(true);
    try {
      const goalId = authStatus === "authenticated"
        ? (await createGoal({
            type,
            title: trimmedTitle,
            deadline,
            daily_hours: dailyHours,
            current_level: currentLevel,
            work_schedule: workSchedule,
            kb_id: null,
            meta: {},
          })).id
        : authStatus === "unauthenticated" ? createLocalGoal() : null;
      if (!goalId) throw new Error("正在确认登录状态，请稍后再试。");
      setCreatedGoalId(goalId);
      setShowCreatedDialog(true);
      onGoalChanged?.();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "目标创建失败，请稍后重试。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleGeneratePlan(mode: KbMode, intentSupplement: string, pacingMode: PacingMode) {
    if (!createdGoalId) return;
    setPlanError("");
    if (authStatus !== "authenticated") {
      router.replace(`/studio/work/goals/${createdGoalId}`);
      return;
    }
    setPlanGenerating(true);
    try {
      await api.post(`/api/v1/agent/macro-plan/${createdGoalId}`, {
        kb_mode: mode,
        user_intent_supplement: intentSupplement,
        pacing_mode: pacingMode,
      });
      localStorage.setItem("tasksNeedRefresh", "1");
      router.replace(`/studio/work/goals/${createdGoalId}`);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "学习计划生成失败，请重试。");
    } finally {
      setPlanGenerating(false);
    }
  }

  return (
    <>
      {!showCreatedDialog && !showPlanMode && (
        <GoalFormSurface
          presentation="dialog"
          mode="create"
          type={type}
          title={title}
          deadline={deadline}
          dailyHours={dailyHours}
          workSchedule={workSchedule}
          currentLevel={currentLevel}
          isSubmitting={isSubmitting || planGenerating}
          authPending={authStatus === "loading"}
          error={formError}
          cancelHref="/studio/work/goals"
          onCancel={onClose}
          onTypeChange={setType}
          onTitleChange={setTitle}
          onDeadlineChange={setDeadline}
          onDailyHoursChange={setDailyHours}
          onWorkScheduleChange={setWorkSchedule}
          onCurrentLevelChange={setCurrentLevel}
          onSubmit={handleSubmit}
        />
      )}

      {showCreatedDialog && createdGoalId && (
        <div className="tech-goal-create-dialog-backdrop">
          <section className="tech-goal-create-success-dialog" role="dialog" aria-modal="true" aria-label="目标创建结果">
            <div className="tech-goal-success-icon"><CheckCircle2 size={19} /></div>
            <div><small>GOAL CREATED</small><h2>目标已创建</h2><p>目标已经保存。接下来可以关联参考资料、选择资料使用边界，再生成阶段计划。</p></div>
            <footer>
              <button type="button" onClick={() => router.replace(`/studio/work/goals/${createdGoalId}`)}>稍后规划</button>
              <button type="button" onClick={() => { setShowCreatedDialog(false); setShowPlanMode(true); }}>设置资料并生成</button>
            </footer>
          </section>
        </div>
      )}

      <PlanModeSelector
        open={showPlanMode}
        hasKb={false}
        goalId={createdGoalId ?? ""}
        goalType={type}
        goalTitle={title}
        onClose={() => { setShowPlanMode(false); setShowCreatedDialog(true); }}
        error={planError}
        onConfirm={(mode, intent, pacing) => void handleGeneratePlan(mode, intent, pacing)}
      />
    </>
  );
}
