"use client";

import {
  BadgeCheck,
  BarChart3,
  BookOpen,
  CalendarCheck2,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  GraduationCap,
  Leaf,
  Loader2,
  MessageCircle,
  Minus,
  ListChecks,
  Plus,
  Target,
  TextCursorInput,
  TimerReset,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { GoalStatus, GoalType } from "@/lib/stores/goalStore";

export type WorkSchedule = "weekday" | "weekend" | "all";
export type GoalLevel = "beginner" | "intermediate" | "advanced";

const GOAL_TYPES = [
  { value: "exam", label: "备考", description: "考试、考研、公务员", icon: GraduationCap },
  { value: "certification", label: "认证", description: "CPA、CFA、PMP 等", icon: BadgeCheck },
  { value: "skill", label: "技能", description: "编程、设计、工具", icon: Code2 },
  { value: "reading", label: "阅读", description: "书籍、论文、主题", icon: BookOpen },
  { value: "language", label: "语言学习", description: "英语、日语等", icon: MessageCircle },
  { value: "habit", label: "习惯养成", description: "运动、冥想、写作", icon: Leaf },
] as const satisfies ReadonlyArray<{
  value: GoalType;
  label: string;
  description: string;
  icon: typeof Target;
}>;

const LEVELS: ReadonlyArray<{ value: GoalLevel; label: string }> = [
  { value: "beginner", label: "入门" },
  { value: "intermediate", label: "进阶" },
  { value: "advanced", label: "高阶" },
];

const SCHEDULES: ReadonlyArray<{ value: WorkSchedule; label: string }> = [
  { value: "weekday", label: "仅工作日" },
  { value: "weekend", label: "仅周末" },
  { value: "all", label: "每天" },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: GoalStatus; label: string }> = [
  { value: "active", label: "进行中" },
  { value: "paused", label: "暂停" },
  { value: "completed", label: "已完成" },
  { value: "abandoned", label: "已放弃" },
];

const GOAL_NAME_PLACEHOLDERS: Record<GoalType, string> = {
  exam: "例如：完成研究生入学考试数学复习",
  certification: "例如：通过 PMP 认证考试",
  skill: "例如：掌握 Python 数据分析",
  reading: "例如：读完并整理《设计心理学》",
  language: "例如：达到日语 N2 水平",
  habit: "例如：连续 30 天保持晨间写作",
};

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function toIsoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function GoalDatePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => value ? new Date(`${value}T00:00:00`) : new Date());
  const rootRef = useRef<HTMLDivElement>(null);
  const today = todayIsoDate();

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    if (value) setViewDate(new Date(`${value}T00:00:00`));
  }, [value]);

  const calendarDays = useMemo(() => {
    const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    const mondayOffset = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(first.getDate() - mondayOffset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, [viewDate]);

  return (
    <div ref={rootRef} className="tech-goal-date-picker">
      <button
        type="button"
        className={`tech-goal-date-trigger ${value ? "has-value" : ""}`}
        aria-label="截止日期"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(`${value}T00:00:00`)) : "选择截止日期"}</span>
        <CalendarDays size={17} />
      </button>
      {open && (
        <section className="tech-goal-calendar-popover" role="dialog" aria-label="选择目标截止日期">
          <header>
            <div><strong>{viewDate.getFullYear()} 年 {viewDate.getMonth() + 1} 月</strong><small>选择计划完成的日期</small></div>
            <div>
              <button type="button" aria-label="上个月" onClick={() => setViewDate((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
              <button type="button" aria-label="下个月" onClick={() => setViewDate((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
            </div>
          </header>
          <div className="tech-goal-calendar-weekdays">{WEEKDAY_LABELS.map((day) => <span key={day}>{day}</span>)}</div>
          <div className="tech-goal-calendar-days">
            {calendarDays.map((date) => {
              const iso = toIsoDate(date);
              const outside = date.getMonth() !== viewDate.getMonth();
              const disabled = iso < today;
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={disabled}
                  className={`${outside ? "is-outside" : ""} ${iso === value ? "is-selected" : ""} ${iso === today ? "is-today" : ""}`}
                  aria-label={new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date)}
                  aria-pressed={iso === value}
                  onClick={() => { onChange(iso); setOpen(false); }}
                >{date.getDate()}</button>
              );
            })}
          </div>
          <footer>
            <button type="button" onClick={() => setViewDate(new Date())}>回到本月</button>
            {value && <button type="button" onClick={() => { onChange(""); setOpen(false); }}>清除日期</button>}
          </footer>
        </section>
      )}
    </div>
  );
}

type GoalFormSurfaceProps = {
  mode: "create" | "edit";
  type: GoalType;
  title: string;
  deadline: string;
  dailyHours: number;
  workSchedule: WorkSchedule;
  currentLevel: GoalLevel;
  status?: GoalStatus;
  isSubmitting: boolean;
  authPending?: boolean;
  error?: string | null;
  cancelHref: string;
  presentation?: "page" | "dialog";
  onCancel?: () => void;
  onTypeChange: (value: GoalType) => void;
  onTitleChange: (value: string) => void;
  onDeadlineChange: (value: string) => void;
  onDailyHoursChange: (value: number) => void;
  onWorkScheduleChange: (value: WorkSchedule) => void;
  onCurrentLevelChange: (value: GoalLevel) => void;
  onStatusChange?: (value: GoalStatus) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
};

export function GoalFormSurface({
  mode,
  type,
  title,
  deadline,
  dailyHours,
  workSchedule,
  currentLevel,
  status,
  isSubmitting,
  authPending = false,
  error,
  cancelHref,
  presentation = "page",
  onCancel,
  onTypeChange,
  onTitleChange,
  onDeadlineChange,
  onDailyHoursChange,
  onWorkScheduleChange,
  onCurrentLevelChange,
  onStatusChange,
  onSubmit,
}: GoalFormSurfaceProps) {
  const { confirmAction } = useConfirmDialog();
  const selectedType = GOAL_TYPES.find((item) => item.value === type) ?? GOAL_TYPES[2];
  const usesCurrentLevel = type !== "reading" && type !== "habit";
  const isEdit = mode === "edit";
  const isDialog = presentation === "dialog";
  const selectedTypeIndex = Math.max(0, GOAL_TYPES.findIndex((item) => item.value === type));
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const initialValueRef = useRef(JSON.stringify({ type, title, deadline, dailyHours, workSchedule, currentLevel, status }));
  const isDirty = initialValueRef.current !== JSON.stringify({ type, title, deadline, dailyHours, workSchedule, currentLevel, status });
  const isDirtyRef = useRef(isDirty);
  const popstateConfirmingRef = useRef(false);
  const allowNextPopstateRef = useRef(false);
  isDirtyRef.current = isDirty;

  const confirmDiscard = useCallback(() => confirmAction({
    kicker: "修改未保存",
    title: "放弃当前目标设置？",
    description: "离开后，本次尚未保存的目标名称、日期和学习安排将无法恢复。",
    cancelLabel: "继续编辑",
    confirmLabel: "放弃修改",
    tone: "warning",
  }), [confirmAction]);

  const requestCancel = useCallback(async () => {
    if (isDirtyRef.current && !(await confirmDiscard())) return;
    onCancel?.();
  }, [confirmDiscard, onCancel]);

  useEffect(() => {
    if (!isDialog || !onCancel) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, [isDialog, onCancel, requestCancel]);

  useEffect(() => {
    if (!isDirty) return;
    const handlePopState = () => {
      if (allowNextPopstateRef.current) {
        allowNextPopstateRef.current = false;
        return;
      }
      if (popstateConfirmingRef.current) return;

      // popstate fires after history has moved. Restore the form first, then
      // use the product dialog to decide whether to repeat the navigation.
      popstateConfirmingRef.current = true;
      window.history.forward();
      void confirmDiscard().then((discard) => {
        if (discard) {
          allowNextPopstateRef.current = true;
          window.history.back();
        }
      }).finally(() => {
        popstateConfirmingRef.current = false;
      });
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [confirmDiscard, isDirty]);

  return (
    <div
      className={`tech-goal-create-page tech-goal-form-page ${isEdit ? "is-editing" : "is-creating"} ${isDialog ? "is-dialog" : ""}`}
      onMouseDown={isDialog ? requestCancel : undefined}
    >
      <main
        className="tech-goal-create-main"
        ref={dialogRef}
        tabIndex={isDialog ? -1 : undefined}
        role={isDialog ? "dialog" : undefined}
        aria-modal={isDialog || undefined}
        aria-label={isDialog ? (isEdit ? "编辑目标" : "创建新目标") : undefined}
        onMouseDown={isDialog ? (event) => event.stopPropagation() : undefined}
      >
        {isDialog && onCancel && (
          <button type="button" className="tech-goal-form-dialog-close" aria-label="关闭目标设置" onClick={requestCancel}>
            <X size={17} />
          </button>
        )}
        <header className="tech-goal-create-header">
          <span className="tech-goal-create-heading-mark" aria-hidden="true"><Target size={22} /></span>
          <div className="tech-goal-create-heading-copy">
            <h1>{isEdit ? "编辑目标" : "创建新目标"}</h1>
            <p>{isEdit ? "调整目标方向与学习节奏，保存后同步更新计划依据" : "清晰定义目标，让每一步都有方向"}</p>
          </div>
        </header>

        <form onSubmit={onSubmit}>
          <section className="tech-goal-form-step" aria-labelledby="goal-form-step-one">
            <header className="tech-goal-form-step-heading">
              <span aria-hidden="true">1</span>
              <div><h2 id="goal-form-step-one">目标类型</h2><p>{selectedType.description}</p></div>
            </header>

            <fieldset className="tech-goal-create-section" aria-label="目标类型选项">
              <div
                className="tech-goal-type-grid"
                style={{ "--goal-type-index": selectedTypeIndex } as CSSProperties}
                role="group"
                aria-label="目标类型"
              >
                <span className="tech-goal-type-selection" aria-hidden="true" />
                {GOAL_TYPES.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      className={`tech-goal-type-option ${type === item.value ? "is-selected" : ""}`}
                      data-goal-type={item.value}
                      aria-pressed={type === item.value}
                      aria-label={item.label}
                      title={item.description}
                      onClick={() => onTypeChange(item.value)}
                    >
                      <Icon size={17} />
                      <strong>{item.label}</strong>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          </section>

          <section className="tech-goal-form-step" aria-labelledby="goal-form-step-two">
            <header className="tech-goal-form-step-heading">
              <span aria-hidden="true">2</span>
              <div><h2 id="goal-form-step-two">目标名称</h2><p>定义一个清晰、可执行的目标</p></div>
            </header>

            <label className="tech-goal-field tech-goal-name-field">
              <span className="visually-hidden"><TextCursorInput size={17} />目标名称</span>
              <input
                value={title}
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder={GOAL_NAME_PLACEHOLDERS[type]}
                required
              />
            </label>
          </section>

          <section className="tech-goal-form-step" aria-labelledby="goal-form-step-three">
            <header className="tech-goal-form-step-heading">
              <span aria-hidden="true">3</span>
              <div><h2 id="goal-form-step-three">学习计划</h2><p>设定节奏、周期与每日投入</p></div>
            </header>

            {isEdit && status && onStatusChange && (
              <fieldset className="tech-goal-create-section tech-goal-status-section">
                <legend><ListChecks size={17} />目标状态</legend>
                <div className="tech-goal-status-control">
                  {STATUS_OPTIONS.map((item) => (
                    <button key={item.value} type="button" className={status === item.value ? "is-selected" : ""} aria-pressed={status === item.value} onClick={() => onStatusChange(item.value)}>{item.label}</button>
                  ))}
                </div>
              </fieldset>
            )}

            <div className={`tech-goal-plan-grid ${usesCurrentLevel ? "has-current-level" : ""}`}>
              <fieldset className="tech-goal-create-section tech-goal-segment-section">
                <legend><CalendarDays size={17} />学习安排</legend>
                <div className="tech-goal-segmented-control">
                  {SCHEDULES.map((item) => (
                    <button key={item.value} type="button" className={workSchedule === item.value ? "is-selected" : ""} aria-pressed={workSchedule === item.value} onClick={() => onWorkScheduleChange(item.value)}>{item.label}</button>
                  ))}
                </div>
              </fieldset>

              {usesCurrentLevel && isEdit && (
                <fieldset className="tech-goal-create-section tech-goal-segment-section">
                  <legend><BarChart3 size={17} />当前水平</legend>
                  <div className="tech-goal-segmented-control">
                    {LEVELS.map((item) => (
                      <button key={item.value} type="button" className={currentLevel === item.value ? "is-selected" : ""} aria-pressed={currentLevel === item.value} onClick={() => onCurrentLevelChange(item.value)}>{item.label}</button>
                    ))}
                  </div>
                </fieldset>
              )}

              <div className="tech-goal-field tech-goal-date-field">
                <span><CalendarCheck2 size={17} />截止日期</span>
                <GoalDatePicker value={deadline} onChange={onDeadlineChange} />
              </div>
              <div className="tech-goal-field tech-goal-duration-field">
                <span><TimerReset size={17} />目标投入</span>
                <div className="tech-goal-duration-stepper" role="group" aria-label="每日投入时长">
                  <button type="button" aria-label="减少每日投入" onClick={() => onDailyHoursChange(Math.max(.5, dailyHours - .5))} disabled={dailyHours <= .5}><Minus size={17} /></button>
                  <label><input type="number" min="0.5" max="8" step="0.5" value={dailyHours} onChange={(event) => onDailyHoursChange(Math.min(8, Math.max(.5, Number(event.target.value) || .5)))} aria-label="每日投入小时数" /><span>小时/天</span></label>
                  <button type="button" aria-label="增加每日投入" onClick={() => onDailyHoursChange(Math.min(8, dailyHours + .5))} disabled={dailyHours >= 8}><Plus size={17} /></button>
                </div>
              </div>
            </div>
          </section>

          {error && <p className="tech-goal-form-error" role="alert">{error}</p>}

          <footer className="tech-goal-create-actions">
            {onCancel
              ? <button type="button" onClick={requestCancel} className="tech-goal-secondary-action">取消</button>
              : <Link href={cancelHref} className="tech-goal-secondary-action">取消</Link>}
            <button type="submit" className="tech-goal-primary-action" disabled={authPending || isSubmitting || !title.trim() || !deadline}>
              {authPending
                ? <><Loader2 size={17} className="is-spinning" />正在确认身份…</>
                : isSubmitting
                ? <><Loader2 size={17} className="is-spinning" />{isEdit ? "保存中…" : "创建中…"}</>
                : <><Check size={17} />{isEdit ? "保存修改" : "创建目标"}</>}
            </button>
          </footer>
        </form>
      </main>
    </div>
  );
}
