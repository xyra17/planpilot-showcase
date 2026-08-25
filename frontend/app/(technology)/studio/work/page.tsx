"use client";

import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Clock3,
  Flag,
  Flame,
  Gauge,
  BrainCircuit,
  ListTodo,
  Plus,
  Sparkles,
  Target,
  Timer,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/technology/AuthProvider";
import { ClockTimePicker } from "@/components/technology/ClockTimePicker";
import { GuestModeDialog } from "@/components/technology/GuestModeDialog";
import { QuickTaskSelect, type QuickTaskSelectOption } from "@/components/technology/QuickTaskSelect";
import { ThemeDashboardLead, type DashboardLeadData } from "@/components/technology/ThemeDashboardLead";
import { DataSyncNotice } from "@/components/ui/DataSyncNotice";
import { api, ApiError } from "@/lib/api";
import { learnerApi, type ActivePattern, type KnowledgeGap } from "@/lib/learner-api";
import { productApi, type ApiGoal, type ApiTask, type GoalProgress } from "@/lib/technology/productApi";
import {
  PRODUCT_STORAGE_KEYS,
  readProductArray,
  writeProductArray,
} from "@/lib/technology/productData";
import { signalPiloContext } from "@/lib/technology/piloContext";
import {
  availabilityForDate,
  getCurrentMinute,
  getIsoDateForTimezone,
  getWeekDatesForIsoDate,
  parseTimeToMinute,
  planDaySchedule,
  weeklyAvailabilityFromPreferences,
  type DayScheduleBlock,
  type ScheduleStrategy,
  type WeeklyAvailability,
} from "@/lib/technology/dayScheduler";
import { readScopedJson, writeScopedJson } from "@/lib/technology/scopedStorage";
import { ensureGuestDatasetSeeded, guestTasks } from "@/lib/technology/guestData";

type DashboardTask = {
  id: string | number;
  goalId?: string;
  date?: string;
  title: string;
  goal: string;
  duration: string;
  time: string;
  done: boolean;
  status?: ApiTask["status"];
  actualMinutes?: number | null;
  priority: string;
};

type WeekDayAggregate = {
  isoDate: string;
  dateLabel: string;
  day: string;
  short: string;
  load: number;
  capacityMinutes: number | null;
  completedMinutes: number;
  actualMinutes: number;
  remainingMinutes: number;
  plan: string;
  status: "已完成" | "有遗留" | "进行中" | "已安排" | "待安排" | "无记录" | "负荷偏高";
  tasks: DashboardTask[];
};

function effectiveCompletedMinutes(task: Pick<DashboardTask, "done" | "actualMinutes" | "duration">) {
  if (!task.done) return 0;
  return task.actualMinutes ?? (Number.parseInt(task.duration, 10) || 0);
}

const WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WEEKDAY_EN = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

const TASK_PRIORITY_OPTIONS = [
  { label: "核心", shortLabel: "核心", value: "核心", apiValue: "high", description: "优先完成" },
  { label: "普通优先级", shortLabel: "普通", value: "普通优先级", apiValue: "medium", description: "按计划推进" },
  { label: "低优先级", shortLabel: "低", value: "低优先级", apiValue: "low", description: "可灵活调整" },
] as const;

function priorityToApi(priority: string): ApiTask["priority"] {
  return TASK_PRIORITY_OPTIONS.find((option) => option.value === priority)?.apiValue ?? "medium";
}

function isNestedAddTaskOverlayTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(
    target.closest(".quick-task-select-content, .availability-time-popover"),
  );
}

function TaskPriorityPicker({
  taskTitle,
  value,
  onChange,
}: {
  taskTitle: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const normalizedValue = value === "普通" ? "普通优先级" : value;
  const current = TASK_PRIORITY_OPTIONS.find((option) => option.value === normalizedValue)
    ?? TASK_PRIORITY_OPTIONS[1];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = 204;
      const menuHeight = 204;
      const spaceBelow = window.innerHeight - rect.bottom;
      setMenuPosition({
        left: Math.min(window.innerWidth - menuWidth - 12, Math.max(12, rect.right - menuWidth)),
        top: spaceBelow >= menuHeight + 12 ? rect.bottom + 7 : Math.max(12, rect.top - menuHeight - 7),
      });
    }
    setOpen(true);
  }

  return (
    <div
      ref={rootRef}
      className={`task-priority-picker is-${current.apiValue} ${open ? "is-open" : ""}`}
      data-priority={current.apiValue}
    >
      <button
        type="button"
        className="task-priority-trigger"
        aria-label={`${taskTitle}优先级`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggleMenu}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span className="task-priority-dot" aria-hidden="true" />
        <span className="task-priority-label">{current.shortLabel}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="task-priority-menu"
          role="listbox"
          aria-label={`选择${taskTitle}的优先级`}
          style={{ left: menuPosition.left, top: menuPosition.top }}
        >
          <div className="task-priority-menu-label">
            <span className="task-priority-menu-icon" aria-hidden="true"><Flag size={14} /></span>
            <span>
              <strong>任务优先级</strong>
              <span className="task-priority-menu-description">设置今天的推进顺序</span>
            </span>
          </div>
          {TASK_PRIORITY_OPTIONS.map((option) => {
            const selected = option.value === current.value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`task-priority-option is-${option.apiValue} ${selected ? "is-selected" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="task-priority-option-dot" aria-hidden="true" />
                <span className="task-priority-option-copy">
                  <strong>{option.label}</strong>
                  <span className="task-priority-option-description">{option.description}</span>
                </span>
                {selected && <Check size={13} aria-hidden="true" />}
              </button>
            );
          })}
        </div>,
        rootRef.current?.closest(".app-shell") ?? document.body,
      )}
    </div>
  );
}

type ScheduleBlock = DayScheduleBlock;

const SCHEDULE_COLORS = [
  "var(--workspace-accent)",
  "#806bed",
  "#6688e0",
  "#b178df",
];

function formatScheduleHour(hour: number) {
  const rounded = Math.round(hour * 60);
  const normalized = ((rounded % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatTaskTimeRange(time: string, duration: string) {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return time;

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const durationMinutes = Math.max(0, Number.parseInt(duration, 10) || 0);
  if (hours > 23 || minutes > 59 || durationMinutes === 0) return time;

  const startMinutes = hours * 60 + minutes;
  return `${formatScheduleHour(startMinutes / 60)}–${formatScheduleHour((startMinutes + durationMinutes) / 60)}`;
}

const EMPTY_TASKS: DashboardTask[] = [];

function guestDemoTasks(todayIso: string): DashboardTask[] {
  return guestTasks().map((task) => ({ ...task, date: task.date || todayIso }));
}

function getIsoWeek(date: Date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

function getWeekRangeLabel(weekDates: string[]) {
  const shortDate = (value: string) => {
    const [, month, day] = value.split("-").map(Number);
    return `${month}.${day}`;
  };
  const weekStart = weekDates[0] ?? "";
  const weekEnd = weekDates[6] ?? weekStart;
  const weekNumber = weekStart ? getIsoWeek(new Date(`${weekStart}T00:00:00Z`)) : 0;
  return `WEEK ${weekNumber} · ${shortDate(weekStart)}—${shortDate(weekEnd)}`;
}

const HABIT_PATTERN_PRIORITY = [
  "preferred_learning_time",
  "preferred_session_length",
  "weekly_learning_frequency",
  "plan_adherence",
  "completion_rate_trend",
  "estimation_accuracy",
  "delay_pattern",
  "mastery_velocity",
];

function patternNumber(pattern: ActivePattern, key: string) {
  const value = pattern.pattern_value[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function habitPatternTitle(pattern: ActivePattern) {
  if (pattern.pattern_type === "preferred_learning_time") {
    const hours = Array.isArray(pattern.pattern_value.peak_hours)
      ? pattern.pattern_value.peak_hours.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];
    if (hours.length) {
      const sortedHours = [...new Set(hours)].sort((first, second) => first - second);
      const isContinuous = sortedHours.every((hour, index) => index === 0 || hour === sortedHours[index - 1] + 1);
      if (isContinuous && sortedHours.length > 1) {
        const start = sortedHours[0];
        const end = sortedHours[sortedHours.length - 1] + 1;
        return `你更常在 ${String(start).padStart(2, "0")}:00–${String(end).padStart(2, "0")}:00 进入学习状态`;
      }
      const labels = sortedHours.map((hour) => `${String(hour).padStart(2, "0")}:00`).join("、");
      return `你更常在 ${labels} 左右进入学习状态`;
    }
  }
  if (pattern.pattern_type === "preferred_session_length") {
    const minutes = patternNumber(pattern, "median_mins") ?? patternNumber(pattern, "minutes");
    if (minutes !== null) return `你稳定的一次学习约 ${Math.round(minutes)} 分钟`;
  }
  if (pattern.pattern_type === "weekly_learning_frequency") {
    const days = patternNumber(pattern, "avg_days_per_week");
    if (days !== null) return `你平均每周学习约 ${Math.round(days)} 天`;
  }
  if (pattern.pattern_type === "completion_rate_trend") {
    const trend = pattern.pattern_value.trend;
    if (trend === "improving") return "你的近期任务完成率正在提升";
    if (trend === "stable") return "你的近期任务完成率保持稳定";
    if (trend === "declining") return "你的近期任务完成率有所下降";
  }
  return pattern.explanation || "Pilo 已识别出一项长期学习习惯";
}

function habitInsightFromPattern(pattern: ActivePattern): DashboardLeadData["habitInsight"] {
  const impacts: Record<string, string> = {
    preferred_learning_time: "安排高认知任务时，可优先使用这段时间。",
    preferred_session_length: "拆分任务时，可优先沿用这个专注时长。",
    weekly_learning_frequency: "安排本周任务时，应避免把学习集中在少数几天。",
    completion_rate_trend: "调整计划强度时，应参考近期完成趋势。",
    mastery_velocity: "安排新内容与复习比例时，可参考近期掌握节奏。",
    delay_pattern: "安排临近截止任务时，应为延期风险预留恢复空间。",
    plan_adherence: "计划偏离后，应优先恢复连续性，而不是一次补完。",
    estimation_accuracy: "估算任务时长时，应为容易低估的任务预留余量。",
  };
  const impact = impacts[pattern.pattern_type] ?? "生成学习建议时，会把它作为一条可校正的参考信号。";
  const explanation = pattern.explanation?.trim()
    || `这项判断由 ${pattern.evidence_count} 条跨天行为记录支持。`;
  return {
    eyebrow: `LEARNING SIGNAL · CONFIDENCE ${Math.round(pattern.confidence * 100)}%`,
    title: habitPatternTitle(pattern),
    description: `${explanation} ${impact}`,
    href: `/studio/coach/memory?pattern=${encodeURIComponent(pattern.id)}`,
    actionLabel: "查看判断依据",
  };
}

export default function WorkPage() {
  const router = useRouter();
  const { status: authStatus, user } = useAuth();
  const [guestIntroOpen, setGuestIntroOpen] = useState(false);
  const userTimezone = user?.timezone ?? (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC");
  const [todayIso, setTodayIso] = useState(() => getIsoDateForTimezone(userTimezone));
  const [executionClockMinute, setExecutionClockMinute] = useState(() => getCurrentMinute(userTimezone));
  const weekDates = useMemo(() => getWeekDatesForIsoDate(todayIso), [todayIso]);
  const previousTodayIsoRef = useRef(todayIso);
  const closeGuestIntro = useCallback(() => {
    window.sessionStorage.setItem("planpilot:guest-home-intro-seen:v1", "1");
    setGuestIntroOpen(false);
  }, []);

  useEffect(() => {
    if (authStatus !== "unauthenticated") {
      setGuestIntroOpen(false);
      return;
    }
    ensureGuestDatasetSeeded();
    setGuestIntroOpen(window.sessionStorage.getItem("planpilot:guest-home-intro-seen:v1") !== "1");
  }, [authStatus]);

  useEffect(() => {
    let active = true;
    const refreshLocalDate = () => {
      if (!active) return;
      setTodayIso(getIsoDateForTimezone(userTimezone));
      setExecutionClockMinute(getCurrentMinute(userTimezone));
    };
    refreshLocalDate();
    const timer = window.setInterval(refreshLocalDate, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [userTimezone]);
  const [tasks, setTasks] = useState<DashboardTask[]>(EMPTY_TASKS);
  const [weekTasks, setWeekTasks] = useState<DashboardTask[]>(EMPTY_TASKS);
  const weekTasksRef = useRef<DashboardTask[]>(EMPTY_TASKS);
  weekTasksRef.current = weekTasks;
  const [storageReady, setStorageReady] = useState(false);
  const [goalOptions, setGoalOptions] = useState<ApiGoal[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState("");
  const [goalsLoaded, setGoalsLoaded] = useState(false);
  const [habitInsight, setHabitInsight] = useState<DashboardLeadData["habitInsight"]>({
    eyebrow: "LEARNING SIGNAL · LOADING",
    title: "正在读取与你有关的学习观察",
    description: "这里只展示有具体记录支持、可由你纠正的观察。",
    href: "/studio/coach",
    actionLabel: "询问学习伙伴",
  });
  const [goalProgressRows, setGoalProgressRows] = useState<GoalProgress[]>([]);
  const [goalProgressStatus, setGoalProgressStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [knowledgeGaps, setKnowledgeGaps] = useState<KnowledgeGap[]>([]);
  const [learnerContextStatus, setLearnerContextStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [undoTask, setUndoTask] = useState<{
    id: string | number;
    title: string;
    previousDone: boolean;
  } | null>(null);
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"today" | "week">("today");
  const [todayPlanMode, setTodayPlanMode] = useState<"tasks" | "schedule">("tasks");
  // Legacy schedule-result view (the former image-1 state) is intentionally
  // disabled in the current flow, but its branch remains below for future use.
  const legacyScheduleViewEnabled = false && todayPlanMode === "schedule";
  const [scheduleBlocks, setScheduleBlocks] = useState<ScheduleBlock[]>([]);
  const [scheduleConfirmed, setScheduleConfirmed] = useState(false);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [scheduleNotice, setScheduleNotice] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const [scheduleSyncState, setScheduleSyncState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [scheduleRetryNonce, setScheduleRetryNonce] = useState(0);
  const observedScheduleStartsRef = useRef(new Set<string>());
  const [schedulePlannerOpen, setSchedulePlannerOpen] = useState(false);
  const [plannerStrategy, setPlannerStrategy] = useState<ScheduleStrategy>("balanced");
  const [plannerNowMinute, setPlannerNowMinute] = useState(0);
  const [activeScheduleScroll, setActiveScheduleScroll] = useState<"preview" | "availability" | "schedule" | null>(null);
  const [localWeeklyAvailability, setLocalWeeklyAvailability] = useState<WeeklyAvailability | null>(null);
  const [selectedWeekDay, setSelectedWeekDay] = useState("");
  const [weekLoadDetailOpen, setWeekLoadDetailOpen] = useState(false);
  const [weekActionPending, setWeekActionPending] = useState(false);
  const [weekActionNotice, setWeekActionNotice] = useState("");
  const [weekActionError, setWeekActionError] = useState("");
  const [weekAdjustmentPreview, setWeekAdjustmentPreview] = useState<{
    task: DashboardTask;
    from: WeekDayAggregate;
    to: WeekDayAggregate;
  } | null>(null);
  const [taskSubmitState, setTaskSubmitState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [taskSubmitError, setTaskSubmitError] = useState("");
  const [taskSuccessNotice, setTaskSuccessNotice] = useState("");
  const [newTaskTimeError, setNewTaskTimeError] = useState("");
  const [actualEntryTask, setActualEntryTask] = useState<{ id: string | number; value: string } | null>(null);
  const [actualEntrySaving, setActualEntrySaving] = useState(false);
  const taskSubmitLockRef = useRef(false);
  const addTaskButtonRef = useRef<HTMLButtonElement>(null);
  const actualEditorRef = useRef<HTMLFormElement>(null);
  const scheduleScrollTimerRef = useRef<number | null>(null);
  const [newTask, setNewTask] = useState({
    title: "",
    goal: "",
    time: "20:30",
    endTime: "21:00",
    priority: "普通优先级",
  });
  useEffect(() => {
    if (authStatus === "loading") return;
    if (authStatus === "unauthenticated") {
      setKnowledgeGaps([]);
      setLearnerContextStatus("idle");
      setHabitInsight({
        eyebrow: "LEARNING SIGNAL · GUEST MODE",
        title: "登录后启用个性化学习建议",
        description: "当前是访客模式；登录后可选择是否让 Pilo 根据跨天记录形成可纠正的学习观察。",
        href: "/login?returnTo=%2Fstudio%2Fwork",
        actionLabel: "登录并查看选择",
      });
      return;
    }

    let active = true;
    setLearnerContextStatus("loading");
    setHabitInsight({
      eyebrow: "LEARNING SIGNAL · LOADING",
      title: "正在读取与你有关的学习观察",
      description: "这里只展示有具体记录支持、可由你纠正的观察。",
      href: "/studio/coach",
      actionLabel: "询问学习伙伴",
    });
    void learnerApi.getDecisionContext(null)
      .then((context) => {
        if (!active) return;
        setKnowledgeGaps(context.knowledge_gaps ?? []);
        setLearnerContextStatus("ready");
        const pattern = [...context.active_patterns].sort((first, second) => {
          const firstPriority = HABIT_PATTERN_PRIORITY.indexOf(first.pattern_type);
          const secondPriority = HABIT_PATTERN_PRIORITY.indexOf(second.pattern_type);
          return (firstPriority === -1 ? HABIT_PATTERN_PRIORITY.length : firstPriority)
            - (secondPriority === -1 ? HABIT_PATTERN_PRIORITY.length : secondPriority)
            || second.confidence - first.confidence
            || second.evidence_count - first.evidence_count;
        })[0];
        setHabitInsight(pattern ? habitInsightFromPattern(pattern) : {
          eyebrow: "LEARNING SIGNAL · OBSERVING",
          title: "还没有需要你核对的学习观察",
          description: "继续完成任务并记录实际投入后，具体观察会连同判断依据一起出现。",
          href: "/studio/coach",
          actionLabel: "询问学习伙伴",
        });
      })
      .catch(() => {
        if (!active) return;
        setKnowledgeGaps([]);
        setLearnerContextStatus("error");
        setHabitInsight({
          eyebrow: "LEARNING SIGNAL · UNAVAILABLE",
          title: "个性化观察暂时无法读取",
          description: "今日计划仍可正常使用；稍后可以向学习伙伴询问具体建议依据。",
          href: "/studio/coach",
          actionLabel: "询问学习伙伴",
        });
      });
    return () => { active = false; };
  }, [authStatus]);
  const pageDate = selectedWeekDay || todayIso;
  const pageDateLabel = pageDate === todayIso
    ? "今天"
    : `${Number(pageDate.slice(5, 7))}月${Number(pageDate.slice(8, 10))}日`;
  const scheduleTimezone = user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scheduleNoticeDateRef = useRef(pageDate);
  useEffect(() => {
    const previous = previousTodayIsoRef.current;
    if (selectedWeekDay === previous || selectedWeekDay === "") setSelectedWeekDay(todayIso);
    previousTodayIsoRef.current = todayIso;
  }, [selectedWeekDay, todayIso]);
  useEffect(() => {
    if (!actualEntryTask) return;
    const closeEditor = (event: PointerEvent) => {
      if (!actualEditorRef.current?.contains(event.target as Node)) setActualEntryTask(null);
    };
    document.addEventListener("pointerdown", closeEditor);
    return () => document.removeEventListener("pointerdown", closeEditor);
  }, [actualEntryTask]);
  const effectiveWeeklyAvailability = useMemo(
    () => user?.weekly_availability
      ?? localWeeklyAvailability
      ?? weeklyAvailabilityFromPreferences(user?.availability_windows, user?.study_days),
    [localWeeklyAvailability, user?.availability_windows, user?.study_days, user?.weekly_availability],
  );
  const capacityForDate = useCallback((isoDate: string): number | null => {
    const ranges = availabilityForDate(effectiveWeeklyAvailability, isoDate);
    return ranges.length
      ? ranges.reduce((total, range) => total + Math.max(0, range.endMinute - range.startMinute), 0)
      : null;
  }, [effectiveWeeklyAvailability]);
  const quickTaskGoalOptions = useMemo<QuickTaskSelectOption[]>(() => {
    if (authStatus === "authenticated") {
      return goalOptions.filter((goal) => goal.status === "active").map((goal) => ({
        value: goal.id,
        label: goal.title,
        description: "进行中的学习目标",
      }));
    }
    return ["算法基础", "面试准备", "英语阅读"].map((goal) => ({
      value: goal,
      label: goal,
      description: "示例学习目标",
    }));
  }, [authStatus, goalOptions]);
  const quickTaskPriorityOptions = useMemo<QuickTaskSelectOption[]>(
    () => TASK_PRIORITY_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      tone: option.apiValue,
    })),
    [],
  );

  function taskFromApi(task: ApiTask): DashboardTask {
    const priority = task.priority === "high" ? "核心" : task.priority === "low" ? "低优先级" : "普通优先级";
    return { id: task.id, goalId: task.goalId, date: task.date, title: task.title, goal: task.goalTitle, duration: `${task.estimatedMinutes} 分钟`, time: "待安排", done: task.done, status: task.status, priority, actualMinutes: task.actualMinutes };
  }

  function resolveTaskGoalId(task: DashboardTask) {
    return task.goalId ?? goalOptions.find((goal) => goal.title === task.goal)?.id;
  }

  function openTask(task: DashboardTask) {
    const goalId = resolveTaskGoalId(task);
    if (!goalId) {
      setDataError(`“${task.title}”暂未关联目标，无法打开任务详情。`);
      return;
    }
    const selectedId = String(task.id);
    setSelectedTaskId(selectedId);
    const returnTo = typeof window === "undefined"
      ? `/studio/work?selected=${encodeURIComponent(selectedId)}`
      : (() => {
        const params = new URLSearchParams(window.location.search);
        params.set("selected", selectedId);
        return `${window.location.pathname}?${params.toString()}`;
      })();
    router.push(`/studio/work/goals/${goalId}?taskId=${encodeURIComponent(String(task.id))}&returnTo=${encodeURIComponent(returnTo)}`);
  }

  function updatePageUrl(updates: Record<string, string | null | undefined>) {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    Object.entries(updates).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "") params.delete(key);
      else params.set(key, value);
    });
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) window.history.pushState(window.history.state, "", nextUrl);
  }

  function changeWorkspaceView(view: "today" | "week") {
    setWorkspaceView(view);
    updatePageUrl({ view: view === "today" ? null : view });
  }

  function changeWeekDay(isoDate: string) {
    setSelectedWeekDay(isoDate);
    setWeekLoadDetailOpen(true);
    updatePageUrl({ date: isoDate });
  }
  const completed = tasks.filter((task) => task.done).length;
  const progress = tasks.length
    ? Math.round((completed / tasks.length) * 100)
    : 0;

  useEffect(() => {
    signalPiloContext({
      kind: "scope",
      surface: "today",
      itemCount: tasks.length,
      completedCount: completed,
      progress,
    });
  }, [completed, progress, tasks.length]);

  useEffect(() => {
    const selected = tasks.find((task) => String(task.id) === selectedTaskId);
    if (!selected) return;
    signalPiloContext({
      kind: "object-opened",
      surface: "today",
      objectId: String(selected.id),
      objectTitle: selected.title,
      goalIds: selected.goalId ? [selected.goalId] : [],
    });
  }, [selectedTaskId, tasks]);
  const actualTodayMinutes = tasks.reduce(
    (sum, task) => sum + effectiveCompletedMinutes(task),
    0,
  );
  const hasActualTodayMinutes = tasks.some(
    (task) => task.done,
  );
  const completedTodayMinutes = hasActualTodayMinutes ? actualTodayMinutes : null;
  const taskPlannedTodayMinutes = tasks.reduce(
    (sum, task) => sum + (Number.parseInt(task.duration, 10) || 0),
    0,
  );
  const scheduledTodayMinutes = scheduleBlocks.reduce(
    (sum, block) => sum + block.durationMinutes,
    0,
  );
  const plannedTodayMinutes = Math.max(taskPlannedTodayMinutes, scheduledTodayMinutes);
  const weekPlan = useMemo<WeekDayAggregate[]>(() => {
    return weekDates.map((isoDate, index) => {
      const dayTasks = weekTasks.filter((task) => task.date === isoDate);
      const load = dayTasks.reduce((sum, task) => sum + (Number.parseInt(task.duration, 10) || 0), 0);
      const capacityMinutes = capacityForDate(isoDate);
      const completedMinutes = dayTasks
        .filter((task) => task.done)
        .reduce((sum, task) => sum + (Number.parseInt(task.duration, 10) || 0), 0);
      const actualMinutes = dayTasks.reduce(
        (sum, task) => sum + effectiveCompletedMinutes(task),
        0,
      );
      const isPast = isoDate < todayIso;
      const isToday = isoDate === todayIso;
      const allDone = dayTasks.length > 0 && dayTasks.every((task) => task.done);
      const status: WeekDayAggregate["status"] = capacityMinutes !== null && load > capacityMinutes
        ? "负荷偏高"
        : dayTasks.length === 0
          ? isPast ? "无记录" : "待安排"
          : allDone
            ? "已完成"
            : isPast
              ? "有遗留"
              : isToday ? "进行中" : "已安排";

      return {
        isoDate,
        dateLabel: `${Number(isoDate.slice(5, 7))}月${Number(isoDate.slice(8, 10))}日`,
        day: isToday ? "今天" : WEEKDAY_CN[index],
        short: WEEKDAY_EN[index],
        load,
        capacityMinutes,
        completedMinutes,
        actualMinutes,
        remainingMinutes: Math.max(0, load - completedMinutes),
        plan: dayTasks.length === 0
          ? isPast ? "没有可用的任务记录" : "尚未安排任务"
          : `${dayTasks.length} 项任务 · ${load} 分钟`,
        status,
        tasks: dayTasks,
      };
    });
  }, [capacityForDate, todayIso, weekDates, weekTasks]);
  const weekPlannedMinutes = weekPlan.reduce((sum, item) => sum + item.load, 0);
  const weekCompletedMinutes = weekPlan.reduce((sum, item) => sum + item.completedMinutes, 0);
  const weekProgress = weekPlannedMinutes
    ? Math.min(100, Math.round((weekCompletedMinutes / weekPlannedMinutes) * 100))
    : 0;
  const maxWeekLoad = Math.max(1, ...weekPlan.flatMap((item) => [item.load, item.capacityMinutes ?? 0]));
  const scheduledWeekDays = weekPlan.filter((item) => item.load > 0);
  const peakLoadDay = weekPlan.reduce((peak, item) => item.load > peak.load ? item : peak, weekPlan[0]);
  const capacityDays = scheduledWeekDays.filter((item) => item.capacityMinutes !== null);
  const balancedWeekDays = capacityDays.filter((item) => item.load <= (item.capacityMinutes ?? 0)).length;
  const hasWeekOverload = capacityDays.some((item) => item.load > (item.capacityMinutes ?? 0));
  const overloadedDay = weekPlan.find((item) => item.load > (item.capacityMinutes ?? 0) && item.capacityMinutes !== null);
  const peakAdjustmentDay = overloadedDay ?? peakLoadDay;
  const peakAdjustMinutes = peakAdjustmentDay.capacityMinutes === null
    ? 0
    : Math.max(0, peakAdjustmentDay.load - peakAdjustmentDay.capacityMinutes);
  const remainingWeekMinutes = Math.max(0, weekPlannedMinutes - weekCompletedMinutes);
  const selectedWeekPlan = weekPlan.find((item) => item.isoDate === selectedWeekDay)
    ?? weekPlan.find((item) => item.isoDate === todayIso)
    ?? weekPlan[0];
  const selectedWeekDetailTasks = selectedWeekPlan.tasks.map((task) => ({
      title: task.title,
      goal: task.goal,
      duration: task.duration,
      time: formatTaskTimeRange(task.time, task.duration),
      state: task.done ? "已完成" : selectedWeekPlan.isoDate < todayIso ? "未完成" : selectedWeekPlan.isoDate === todayIso ? "进行中" : "待开始",
      priority: priorityToApi(task.priority),
      priorityLabel: task.priority === "核心" ? "核心" : task.priority === "低优先级" ? "低优先级" : "普通",
      task,
    }));
  const peakAdjustmentTask = peakAdjustmentDay.tasks.find((task) => !task.done && task.priority === "低优先级")
    ?? peakAdjustmentDay.tasks.find((task) => !task.done);
  const peakAdjustmentMinutes = Number.parseInt(peakAdjustmentTask?.duration ?? "0", 10) || 0;
  const weekAdjustmentDestination = weekPlan
    .filter((item) => item.isoDate !== peakAdjustmentDay.isoDate && item.isoDate >= todayIso)
    .sort((first, second) => first.load - second.load || first.isoDate.localeCompare(second.isoDate))
    .find((item) => item.capacityMinutes !== null && item.load + peakAdjustmentMinutes <= item.capacityMinutes)
    ?? weekPlan
      .filter((item) => item.isoDate !== peakAdjustmentDay.isoDate && item.isoDate >= todayIso)
      .sort((first, second) => first.load - second.load || first.isoDate.localeCompare(second.isoDate))[0];
  const selectedWeekTone = selectedWeekPlan.status === "负荷偏高"
    ? "risk"
    : selectedWeekPlan.status === "已完成"
      ? "complete"
      : "active";
  const todayRhythmIndex = Math.max(0, weekDates.indexOf(todayIso));
  const weekRangeLabel = useMemo(() => getWeekRangeLabel(weekDates), [weekDates]);
  const rhythmDays = useMemo(() => weekPlan.map((item, index) => {
    const phase = index < todayRhythmIndex ? "past" : index === todayRhythmIndex ? "today" : "future";
    const actualMinutes = phase === "future" ? 0 : item.actualMinutes;
    const plannedMinutes = phase === "today" ? Math.max(item.load, plannedTodayMinutes) : item.load;
    return {
      day: item.day,
      short: item.day === "今天" ? "今" : item.day.slice(-1),
      phase,
      actualMinutes,
      plannedMinutes,
      displayMinutes: phase === "future" || (phase === "today" && actualMinutes === 0)
        ? plannedMinutes
        : actualMinutes,
    };
  }), [plannedTodayMinutes, todayRhythmIndex, weekPlan]);
  const rhythmActualDays = rhythmDays.filter((item) => item.phase !== "future" && item.actualMinutes > 0);
  const hasActualWeekMinutes = rhythmActualDays.length > 0;
  const rhythmPeak = rhythmActualDays.reduce<(typeof rhythmDays)[number] | null>(
    (peak, item) => !peak || item.actualMinutes > peak.actualMinutes ? item : peak,
    null,
  );
  const weekActualMinutes = rhythmDays.reduce((sum, item) => sum + item.actualMinutes, 0);
  const elapsedWeekDays = rhythmDays.filter((item) => item.phase !== "future").length;
  const averageActualMinutes = elapsedWeekDays
    ? Math.round(weekActualMinutes / elapsedWeekDays)
    : 0;
  const rhythmJudgment = !hasActualWeekMinutes
    ? "等待记录"
    : hasWeekOverload
      ? "需要减负"
      : rhythmActualDays.length >= 2
        ? "节奏稳定"
        : "初步形成";
  const scheduleAvailability = useMemo(
    () => availabilityForDate(effectiveWeeklyAvailability, pageDate),
    [effectiveWeeklyAvailability, pageDate],
  );
  const remainingAvailability = scheduleAvailability
    .map((range) => ({ ...range, startMinute: pageDate === todayIso ? Math.max(range.startMinute, Math.ceil(plannerNowMinute / 15) * 15) : range.startMinute }))
    .filter((range) => range.endMinute > range.startMinute);
  const remainingAvailabilityLabels = remainingAvailability.map(
    (range) => `${formatScheduleHour(range.startMinute / 60)}–${formatScheduleHour(range.endMinute / 60)}`,
  );
  const schedulePreview = useMemo(() => {
    if (!schedulePlannerOpen) return null;
    return planDaySchedule({
      tasks: tasks.map((task) => ({
        id: String(task.id),
        title: task.title,
        goalTitle: task.goal,
        durationMinutes: Math.max(5, Number.parseInt(task.duration, 10) || 30),
        priority: task.priority,
        preferredStartMinute: parseTimeToMinute(task.time),
        done: task.done,
      })),
      existingBlocks: scheduleBlocks,
      availability: scheduleAvailability,
      operation: scheduleBlocks.length ? "replan_future" : "replan_all",
      strategy: plannerStrategy,
      nowMinute: plannerNowMinute,
      colors: SCHEDULE_COLORS,
    });
  }, [plannerNowMinute, plannerStrategy, scheduleAvailability, scheduleBlocks, schedulePlannerOpen, tasks]);
  const scheduledTimeByTaskId = useMemo(() => {
    if (!scheduleConfirmed) return new Map<string, string>();
    return new Map(
      scheduleBlocks
        .filter((block) => block.taskId)
        .map((block) => [
          String(block.taskId),
          `${formatScheduleHour(block.startHour)}–${formatScheduleHour(block.startHour + block.durationMinutes / 60)}`,
        ]),
    );
  }, [scheduleBlocks, scheduleConfirmed]);
  const scheduledProgressByTaskId = useMemo(() => {
    if (!scheduleConfirmed) return new Map<string, { elapsed: number; color: string; startMinute: number; endMinute: number }>();
    const currentMinute = pageDate === todayIso ? executionClockMinute : 0;
    return new Map(
      scheduleBlocks
        .filter((block) => block.taskId)
        .map((block) => {
          const startMinute = Math.round(block.startHour * 60);
          const endMinute = startMinute + block.durationMinutes;
          const elapsed = currentMinute <= startMinute
            ? 0
            : currentMinute >= endMinute
              ? 100
              : Math.round(((currentMinute - startMinute) / (endMinute - startMinute)) * 100);
          return [String(block.taskId), { elapsed, color: block.color, startMinute, endMinute }];
        }),
    );
  }, [executionClockMinute, pageDate, scheduleBlocks, scheduleConfirmed, todayIso]);
  const displayedTasks = useMemo(() => {
    if (!scheduleConfirmed || scheduleBlocks.length === 0) return tasks;
    const scheduledStartByTaskId = new Map(
      scheduleBlocks
        .filter((block) => block.taskId)
        .map((block) => [String(block.taskId), Math.round(block.startHour * 60)]),
    );
    return tasks
      .map((task, index) => ({ task, index, startMinute: scheduledStartByTaskId.get(String(task.id)) }))
      .sort((left, right) => {
        if (left.startMinute !== undefined && right.startMinute === undefined) return -1;
        if (left.startMinute === undefined && right.startMinute !== undefined) return 1;
        if (left.startMinute !== undefined && right.startMinute !== undefined && left.startMinute !== right.startMinute) {
          return left.startMinute - right.startMinute;
        }
        return left.index - right.index;
      })
      .map(({ task }) => task);
  }, [scheduleBlocks, scheduleConfirmed, tasks]);
  const nextTask = useMemo(() => {
    const pending = tasks.filter((task) => !task.done);
    if (!pending.length) return null;
    const pendingById = new Map(pending.map((task) => [String(task.id), task]));
    const referenceMinute = pageDate === todayIso ? getCurrentMinute(scheduleTimezone) : -1;
    const scheduled = scheduleConfirmed
      ? scheduleBlocks
        .map((block) => {
          const task = block.taskId ? pendingById.get(String(block.taskId)) : undefined;
          return task ? { task, startMinute: Math.round(block.startHour * 60) } : null;
        })
        .filter((item): item is { task: DashboardTask; startMinute: number } => Boolean(item && item.startMinute > referenceMinute))
        .sort((first, second) => first.startMinute - second.startMinute)
      : [];
    if (scheduled[0]) return scheduled[0].task;
    const priorityRank: Record<string, number> = { 核心: 0, 普通优先级: 1, 普通: 1, 低优先级: 2 };
    return pending
      .map((task, index) => ({ task, index }))
      .sort((first, second) =>
        (priorityRank[first.task.priority] ?? 1) - (priorityRank[second.task.priority] ?? 1)
        || (first.task.date ?? pageDate).localeCompare(second.task.date ?? pageDate)
        || first.index - second.index,
      )[0]?.task ?? null;
  }, [pageDate, scheduleBlocks, scheduleConfirmed, scheduleTimezone, tasks, todayIso]);
  const nextTaskId = nextTask?.id;
  const coachContextHref = useMemo(() => {
    const contextTask = nextTask ?? peakAdjustmentTask;
    const peakSummary = scheduledWeekDays.length
      ? `${peakAdjustmentDay.dateLabel}计划 ${peakAdjustmentDay.load} 分钟`
      : "本周暂无已安排任务";
    const capacitySummary = peakAdjustmentDay.capacityMinutes === null
      ? "该日没有配置逐日可用容量"
      : `该日可用容量 ${peakAdjustmentDay.capacityMinutes} 分钟`;
    const reason = hasWeekOverload
      ? `${peakSummary}，${capacitySummary}，超出 ${peakAdjustMinutes} 分钟`
      : `${peakSummary}；${capacitySummary}`;
    const params = new URLSearchParams({
      intent: "review_today_plan",
      surface: "today_plan",
      objectId: contextTask ? String(contextTask.id) : peakAdjustmentDay.isoDate,
      objectTitle: contextTask?.title ?? "本周计划",
      reason,
      prompt: contextTask
        ? `请结合“${contextTask.title}”和${reason}，给出下一步可执行建议。`
        : `请结合${reason}，说明今天计划的判断依据。`,
      returnTo: "/studio/work",
    });
    return `/studio/coach?${params.toString()}`;
  }, [hasWeekOverload, nextTask, peakAdjustMinutes, peakAdjustmentDay, peakAdjustmentTask, scheduledWeekDays.length]);
  const activeGoalCount = goalOptions.filter((goal) => goal.status === "active").length;
  const activeGoalIds = new Set(goalOptions.filter((goal) => goal.status === "active").map((goal) => goal.id));
  const activeGoalProgressRows = goalProgressRows.filter((row) => activeGoalIds.has(row.goal_id));
  const riskyGoalIds = new Set(
    activeGoalProgressRows
      .filter((row) => row.debt_count > 0 || (row.days_ahead_or_behind ?? 0) < 0)
      .map((row) => row.goal_id),
  );
  goalOptions.forEach((goal) => {
    if (goal.status === "active" && goal.deadline && goal.deadline < todayIso) riskyGoalIds.add(goal.id);
  });
  const longestLearningStreak = activeGoalProgressRows.reduce(
    (longest, row) => Math.max(longest, row.streak_days),
    0,
  );
  const lowRetentionGapCount = knowledgeGaps.filter((gap) => gap.retention < 0.5).length;
  const leadData = useMemo<DashboardLeadData>(() => {
    return {
      nextTaskTitle: nextTask?.title ?? null,
      nextTaskTime: nextTask ? (scheduledTimeByTaskId.get(String(nextTask.id)) ?? (nextTask.time === "待安排" ? null : nextTask.time)) : null,
      nextTaskDuration: nextTask?.duration ?? null,
      actualTodayMinutes: hasActualTodayMinutes ? actualTodayMinutes : null,
      plannedTodayMinutes,
      habitInsight,
      metrics: [
        {
          label: "活跃目标",
          value: authStatus === "authenticated" ? String(activeGoalCount) : "—",
          unit: authStatus === "authenticated" ? "个" : undefined,
          detail: authStatus === "authenticated"
            ? riskyGoalIds.size > 0 ? `${riskyGoalIds.size} 个目标本周有风险` : "当前目标节奏正常"
            : "登录后同步真实目标",
          icon: Target,
          tone: "violet",
          href: "/studio/work/goals",
        },
        {
          label: "连续学习",
          value: authStatus === "authenticated" && goalProgressStatus === "ready" ? String(longestLearningStreak) : "—",
          unit: authStatus === "authenticated" && goalProgressStatus === "ready" ? "天" : undefined,
          detail: authStatus !== "authenticated"
            ? "登录后统计真实连续记录"
            : goalProgressStatus === "error" ? "目标进度暂时无法读取" : goalProgressStatus === "ready" ? "当前目标最长连续记录" : "正在读取连续记录",
          icon: Flame,
          tone: "mint",
          href: "/studio/work/goals",
        },
        {
          label: "本周投入",
          value: hasActualWeekMinutes ? (weekActualMinutes / 60).toFixed(1).replace(/\.0$/, "") : "—",
          unit: hasActualWeekMinutes ? "小时" : undefined,
          detail: hasActualWeekMinutes
            ? weekActualMinutes >= weekPlannedMinutes
              ? `已达到本周计划投入`
              : `距离本周计划还有 ${((weekPlannedMinutes - weekActualMinutes) / 60).toFixed(1).replace(/\.0$/, "")} 小时`
            : "尚未形成实际投入记录",
          icon: Clock3,
          tone: "blue",
          href: "/studio/work#weekly-rhythm",
        },
        {
          label: "待复习知识",
          value: authStatus === "authenticated" && learnerContextStatus === "ready" ? String(knowledgeGaps.length) : "—",
          unit: authStatus === "authenticated" && learnerContextStatus === "ready" ? "项" : undefined,
          detail: authStatus !== "authenticated"
            ? "登录后读取真实知识缺口"
            : learnerContextStatus === "error" ? "知识复习状态暂时无法读取" : learnerContextStatus === "ready"
              ? lowRetentionGapCount ? `${lowRetentionGapCount} 项保持率低于 50%` : knowledgeGaps.length ? "当前没有高遗忘风险" : "目前没有识别到知识缺口"
              : "正在分析知识缺口",
          icon: BrainCircuit,
          tone: "amber",
          href: "/studio/work/knowledge",
        },
      ],
    };
  }, [activeGoalCount, actualTodayMinutes, authStatus, goalProgressStatus, habitInsight, hasActualTodayMinutes, hasActualWeekMinutes, knowledgeGaps.length, learnerContextStatus, longestLearningStreak, lowRetentionGapCount, nextTask, plannedTodayMinutes, riskyGoalIds.size, scheduledTimeByTaskId, weekActualMinutes, weekPlannedMinutes]);
  function openAddTask() {
    const currentMinute = getCurrentMinute(scheduleTimezone);
    const endMinute = Math.min(currentMinute + 30, 23 * 60 + 59);
    setNewTask((current) => ({
      ...current,
      time: formatScheduleHour(currentMinute / 60),
      endTime: formatScheduleHour(endMinute / 60),
    }));
    setNewTaskTimeError("");
    setTaskSubmitState("idle");
    setTaskSubmitError("");
    taskSubmitLockRef.current = false;
    setAddTaskOpen(true);
  }

  function closeAddTask() {
    setAddTaskOpen(false);
    window.requestAnimationFrame(() => addTaskButtonRef.current?.focus());
  }

  useEffect(() => {
    if (authStatus === "loading") return;
    if (authStatus === "unauthenticated") {
      if (storageReady && pageDate !== todayIso) {
        setTasks(weekTasksRef.current.filter((task) => task.date === pageDate));
        return;
      }
      const storedTasks = readProductArray(PRODUCT_STORAGE_KEYS.tasks, guestDemoTasks(todayIso)).map((task) => ({
        ...task,
        date: task.date ?? todayIso,
      }));
      const storedGoals = readProductArray<Record<string, unknown>>(PRODUCT_STORAGE_KEYS.goals, [])
        .map((goal): ApiGoal | null => {
          const id = String(goal.id ?? "");
          const title = String(goal.title ?? goal.name ?? "").trim();
          if (!id || !title) return null;
          const dailyHours = typeof goal.daily_hours === "number"
            ? goal.daily_hours
            : Number.parseFloat(String(goal.daily ?? "0")) / 60;
          const rawStatus = String(goal.status ?? "active");
          const status: ApiGoal["status"] = rawStatus === "completed" || rawStatus === "paused" || rawStatus === "abandoned" ? rawStatus : "active";
          const rawType = String(goal.apiType ?? "skill");
          const type: ApiGoal["type"] = rawType === "exam" || rawType === "certification" || rawType === "reading" || rawType === "language" || rawType === "habit" ? rawType : "skill";
          return {
            id,
            title,
            type,
            deadline: String(goal.deadlineDate ?? goal.deadline ?? ""),
            daily_hours: Number.isFinite(dailyHours) ? dailyHours : 0,
            current_level: String(goal.current_level ?? "beginner"),
            status,
            created_at: String(goal.created_at ?? new Date().toISOString()),
            work_schedule: "all",
          };
        })
        .filter((goal): goal is ApiGoal => Boolean(goal && goal.status === "active"));
      const validGoalIds = new Set(storedGoals.map((goal) => String(goal.id)));
      // Keep the built-in guest preview intact when no local goal collection
      // exists yet. Once the user has a local goal collection, its IDs become
      // authoritative and linked tasks for removed goals are stale.
      const hasLocalGoalCollection = typeof window !== "undefined"
        && window.localStorage.getItem(PRODUCT_STORAGE_KEYS.goals) !== null;
      const cleanedTasks = hasLocalGoalCollection
        ? storedTasks.filter((task) => !task.goalId || validGoalIds.has(String(task.goalId)))
        : storedTasks;
      setWeekTasks(cleanedTasks);
      setTasks(cleanedTasks.filter((task) => task.date === pageDate));
      setGoalOptions(storedGoals);
      setGoalProgressRows([]);
      setGoalProgressStatus("idle");
      setGoalsLoaded(true);
      if (cleanedTasks.length !== storedTasks.length) {
        writeProductArray(PRODUCT_STORAGE_KEYS.tasks, cleanedTasks, { notifyPilo: true });
      }
      setNewTask((current) => ({ ...current, goal: current.goal || storedGoals[0]?.title || "" }));
      setStorageReady(true);
      return;
    }
    let active = true;
    setTasks([]);
    setWeekTasks([]);
    setGoalOptions([]);
    setGoalProgressRows([]);
    setGoalProgressStatus("loading");
    setGoalsLoaded(false);
    setDataLoading(true);
    setGoalsLoading(true);
    setDataError("");
    let pendingRequests = 3;
    const finishRequest = () => {
      pendingRequests -= 1;
      if (active && pendingRequests === 0) {
        setDataLoading(false);
        setGoalsLoading(false);
      }
    };
    const reportError = (reason: unknown, fallback: string) => {
      if (!active) return;
      const message = reason instanceof Error ? reason.message : fallback;
      setDataError((current) => current ? `${current}；${message}` : message);
    };
    void productApi.listTasks(todayIso)
      .then((nextTasks) => {
        if (!active || pageDate !== todayIso) return;
        setTasks(nextTasks.map(taskFromApi));
      })
      .catch((reason) => reportError(reason, "今日计划加载失败"))
      .finally(finishRequest);
    void productApi.listTasks(undefined, { dateFrom: weekDates[0], dateTo: weekDates[6] })
      .then((nextWeekTasks) => {
        if (!active) return;
        const mapped = nextWeekTasks.map(taskFromApi);
        setWeekTasks(mapped);
        setTasks(mapped.filter((task) => task.date === pageDate));
      })
      .catch((reason) => reportError(reason, "本周任务加载失败"))
      .finally(finishRequest);
    void productApi.listGoals()
      .then((nextGoals) => {
        if (!active) return;
        setGoalOptions(nextGoals);
        setGoalsLoaded(true);
        const firstActiveGoal = nextGoals.find((goal) => goal.status === "active");
        if (firstActiveGoal) setNewTask((current) => ({ ...current, goal: current.goal || firstActiveGoal.id }));
        if (nextGoals.length === 0) {
          setGoalProgressRows([]);
          setGoalProgressStatus("idle");
          return null;
        }
        return productApi.getGoalsProgress()
          .then((rows) => {
            if (!active) return rows;
            setGoalProgressRows(rows);
            setGoalProgressStatus("ready");
            return rows;
          })
          .catch((reason) => {
            if (active) {
              // A deleted goal can race with the aggregate progress request.
              // There is no actionable retry in that state; the successful
              // goal list and orphan cleanup are the source of truth.
              if (reason instanceof ApiError && (reason.status === 404 || reason.message.includes("目标不存在"))) {
                setGoalProgressRows([]);
                setGoalProgressStatus("idle");
              } else {
                setGoalProgressStatus("error");
                reportError(reason, "目标进度加载失败");
              }
            }
            return null;
          });
      })
      .catch((reason) => reportError(reason, "目标加载失败"))
      .finally(finishRequest);
    return () => { active = false; };
  }, [authStatus, pageDate, storageReady, todayIso, weekDates]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !goalsLoaded) return;
    const validGoalIds = new Set(goalOptions.map((goal) => String(goal.id)));
    const orphanedTasks = weekTasks.filter((task) => task.goalId && !validGoalIds.has(String(task.goalId)));
    if (orphanedTasks.length === 0) return;
    const orphanedIds = new Set(orphanedTasks.map((task) => String(task.id)));
    const remainingTasks = weekTasks.filter((task) => !orphanedIds.has(String(task.id)));
    setWeekTasks(remainingTasks);
    setTasks(remainingTasks.filter((task) => task.date === pageDate));
    void Promise.all(orphanedTasks
      .filter((task): task is DashboardTask & { id: string } => typeof task.id === "string")
      .map((task) => productApi.deleteTask(task.id)))
      .catch((reason) => setDataError(reason instanceof Error ? reason.message : "清理失效任务失败"));
  }, [authStatus, goalOptions, goalsLoaded, pageDate, weekTasks]);

  useEffect(() => {
    try {
      setLocalWeeklyAvailability(readScopedJson<WeeklyAvailability | null>(
        "planpilot-v2-weekly-availability",
        user?.id,
        null,
        "planpilot-v2-weekly-availability",
      ));
    } catch {
      setLocalWeeklyAvailability(null);
    }
  }, [user?.id]);

  useEffect(() => {
    if (authStatus === "loading") return;
    let active = true;
    setScheduleLoaded(false);
    setScheduleError("");
    const loadSchedule = async () => {
      try {
        if (authStatus === "authenticated") {
          const response = await api.get<{ date: string; blocks: ScheduleBlock[] }>(`/api/v1/schedule/${pageDate}`);
          if (active) {
            setScheduleBlocks((current) => scheduleDirty ? current : (response.blocks ?? []));
            setScheduleConfirmed(true);
            if (!scheduleDirty) setScheduleDirty(false);
          }
        } else {
          const stored = readScopedJson<ScheduleBlock[] | null>(
            `planpilot.technology.schedule.${pageDate}`,
            null,
            null,
            `planpilot.technology.schedule.${pageDate}`,
          );
          if (active) {
            // Keep a locally edited draft intact while a retry/load is in
            // flight. A failed request must never replace dirty work with [] .
            setScheduleBlocks((current) => scheduleDirty ? current : (stored ?? []));
            setScheduleConfirmed(true);
            if (!scheduleDirty) setScheduleDirty(false);
          }
        }
      } catch (reason) {
        if (active) {
          // Preserve the user's unsaved blocks so the retry can recover.
          setScheduleBlocks((current) => current);
          setScheduleConfirmed(false);
          setScheduleError(reason instanceof Error ? reason.message : "时间规划加载失败");
        }
      } finally {
        if (active) setScheduleLoaded(true);
      }
    };
    void loadSchedule();
    return () => { active = false; };
  }, [authStatus, pageDate, scheduleRetryNonce, scheduleDirty]);

  useEffect(() => {
    if (scheduleNoticeDateRef.current === pageDate) return;
    scheduleNoticeDateRef.current = pageDate;
    setScheduleNotice("");
    setScheduleSyncState("idle");
  }, [pageDate]);

  useEffect(() => {
    if (!scheduleLoaded || !scheduleConfirmed || !scheduleDirty) return;
    if (authStatus === "authenticated") {
      setScheduleSyncState("saving");
      const timer = window.setTimeout(() => {
        void api.put(`/api/v1/schedule/${pageDate}`, { blocks: scheduleBlocks })
          .then(() => {
            setScheduleSyncState("saved");
            setScheduleDirty(false);
            setScheduleError("");
            setScheduleNotice("时间安排已同步。");
          })
          .catch((reason) => {
            setScheduleSyncState("error");
            setScheduleError(reason instanceof Error ? reason.message : "时间安排同步失败");
          });
      }, 350);
      return () => window.clearTimeout(timer);
    }
    writeScopedJson(`planpilot.technology.schedule.${pageDate}`, null, scheduleBlocks, `planpilot.technology.schedule.${pageDate}`);
    setScheduleDirty(false);
    setScheduleSyncState("saved");
  }, [authStatus, pageDate, scheduleBlocks, scheduleConfirmed, scheduleDirty, scheduleLoaded]);

  useEffect(() => {
    if (
      authStatus !== "authenticated"
      || pageDate !== todayIso
      || !scheduleLoaded
      || !scheduleConfirmed
      || scheduleDirty
      || scheduleSyncState === "saving"
    ) return;

    for (const block of scheduleBlocks) {
      if (!block.taskId) continue;
      const startMinute = Math.round(block.startHour * 60);
      const endMinute = startMinute + block.durationMinutes;
      if (executionClockMinute < startMinute || executionClockMinute >= endMinute) continue;
      const task = tasks.find((item) => String(item.id) === String(block.taskId));
      if (!task || task.done || task.status !== "pending" || typeof task.id !== "string") continue;

      const observationKey = `${todayIso}:${block.id}:${task.id}`;
      if (observedScheduleStartsRef.current.has(observationKey)) continue;
      observedScheduleStartsRef.current.add(observationKey);
      void productApi.observeTaskStart(task.id)
        .then((updated) => {
          setTasks((current) => current.map((item) => item.id === task.id
            ? { ...item, status: updated.status }
            : item));
          setWeekTasks((current) => current.map((item) => item.id === task.id
            ? { ...item, status: updated.status }
            : item));
        })
        .catch(() => {
          // 埋点观察失败不阻塞任务操作；留待下一个 30 秒时钟周期重试。
          observedScheduleStartsRef.current.delete(observationKey);
        });
    }
  }, [authStatus, executionClockMinute, pageDate, scheduleBlocks, scheduleConfirmed, scheduleDirty, scheduleLoaded, scheduleSyncState, tasks, todayIso]);

  useEffect(() => {
    if (!storageReady || authStatus === "authenticated") return;
    writeProductArray(PRODUCT_STORAGE_KEYS.tasks, weekTasks);
  }, [authStatus, storageReady, weekTasks]);

  useEffect(() => {
    const pageTasks = tasks.filter((task) => !task.date || task.date === pageDate);
    // A date switch temporarily leaves the old page's tasks in state. Do not
    // relabel those tasks as belonging to the newly selected date; the
    // independent page load will populate the correct slice shortly.
    if (tasks.length > 0 && pageTasks.length === 0) return;
    setWeekTasks((current) => [
      ...current.filter((task) => task.date !== pageDate),
      ...pageTasks.map((task) => ({ ...task, date: pageDate })),
    ]);
  }, [pageDate, tasks]);

  useEffect(() => {
    if (!undoTask) return;
    const timer = window.setTimeout(() => setUndoTask(null), 5000);
    return () => window.clearTimeout(timer);
  }, [undoTask]);

  useEffect(() => {
    if (!addTaskOpen) return;

    function closeDialog(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Select/clock popovers are the top layer. Radix closes its Select from
      // a document-capture listener before this window listener runs, so do
      // not let the same Escape dismiss the parent task dialog as well.
      if (isNestedAddTaskOverlayTarget(event.target)) return;
      closeAddTask();
    }

    window.addEventListener("keydown", closeDialog);
    return () => window.removeEventListener("keydown", closeDialog);
  }, [addTaskOpen]);

  useEffect(() => {
    if (!schedulePlannerOpen) return;
    function closePlanner(event: KeyboardEvent) {
      if (event.key === "Escape") setSchedulePlannerOpen(false);
    }
    window.addEventListener("keydown", closePlanner);
    return () => window.removeEventListener("keydown", closePlanner);
  }, [schedulePlannerOpen]);

  useEffect(() => () => {
    if (scheduleScrollTimerRef.current !== null) window.clearTimeout(scheduleScrollTimerRef.current);
  }, []);

  useEffect(() => {
    const applyUrlState = () => {
      const params = new URLSearchParams(window.location.search);
      setWorkspaceView(params.get("view") === "week" ? "week" : "today");
      setTodayPlanMode(params.get("mode") === "schedule" ? "schedule" : "tasks");
      const nextDate = params.get("date");
      setSelectedWeekDay(nextDate && weekDates.includes(nextDate) ? nextDate : todayIso);
      setSelectedTaskId(params.get("selected"));
    };
    applyUrlState();
    window.addEventListener("popstate", applyUrlState);
    return () => window.removeEventListener("popstate", applyUrlState);
  }, [todayIso, weekDates]);

  function toggleTask(id: string | number) {
    const target = tasks.find((task) => task.id === id);
    if (!target) return;

    setUndoTask({
      id: target.id,
      title: target.title,
      previousDone: target.done,
    });
    const nextDone = !target.done;
    setTasks((current) => current.map((task) =>
      task.id === id ? { ...task, done: nextDone, status: nextDone ? "completed" : "pending" } : task,
    ));
    setWeekTasks((current) => current.map((task) =>
      task.id === id ? { ...task, done: nextDone, status: nextDone ? "completed" : "pending" } : task,
    ));
    if (authStatus === "authenticated" && typeof id === "string") {
      void productApi.updateTask(id, { done: nextDone }).catch((reason) => {
        setDataError(reason instanceof Error ? reason.message : "任务状态同步失败");
        setTasks((latest) => latest.map((task) => task.id === id ? { ...task, done: target.done } : task));
        setWeekTasks((latest) => latest.map((task) => task.id === id ? { ...task, done: target.done } : task));
      });
    }
    if (nextDone) {
      signalPiloContext({
        kind: "completed",
        surface: "today",
        objectId: String(target.id),
        objectTitle: target.title,
        message: `“${target.title}”完成了。先把这一小步留住就好。`,
      });
    }
  }

  function restoreTask() {
    if (!undoTask) return;
    setTasks((current) =>
      current.map((task) =>
        task.id === undoTask.id
          ? { ...task, done: undoTask.previousDone }
          : task,
      ),
    );
    setWeekTasks((current) =>
      current.map((task) =>
        task.id === undoTask.id
          ? { ...task, done: undoTask.previousDone }
          : task,
      ),
    );
    setUndoTask(null);
    if (authStatus === "authenticated" && typeof undoTask.id === "string") {
      void productApi.updateTask(undoTask.id, { done: undoTask.previousDone }).catch((reason) => {
        setDataError(reason instanceof Error ? reason.message : "撤销操作同步失败");
      });
    }
  }

  async function toggleWeekTask(task: DashboardTask) {
    setWeekActionError("");
    const previousWeekTasks = weekTasks;
    const nextDone = !task.done;
    const nextWeekTasks = weekTasks.map((item) => item.id === task.id ? { ...item, done: nextDone } : item);
    setWeekTasks(nextWeekTasks);
    setTasks(nextWeekTasks.filter((item) => item.date === pageDate));
    setWeekActionNotice(nextDone ? `已完成“${task.title}”` : `已恢复“${task.title}”`);

    if (authStatus === "authenticated" && typeof task.id === "string") {
      try {
        await productApi.updateTask(task.id, { done: nextDone });
      } catch (reason) {
        setWeekTasks(previousWeekTasks);
        setTasks(previousWeekTasks.filter((item) => item.date === pageDate));
        setWeekActionNotice("");
        setWeekActionError(reason instanceof Error ? reason.message : "任务状态同步失败");
      }
    }
  }

  function openWeekAdjustmentPreview() {
    setWeekActionError("");
    if (!hasWeekOverload || !peakAdjustmentTask || !weekAdjustmentDestination || weekActionPending) {
      setWeekActionNotice(weekPlannedMinutes === 0 ? "先为任务补充日期与预计时长。" : "当前没有需要移动的待完成任务。");
      return;
    }

    setWeekAdjustmentPreview({ task: peakAdjustmentTask, from: peakAdjustmentDay, to: weekAdjustmentDestination });
  }

  async function confirmWeekAdjustment() {
    if (!weekAdjustmentPreview || weekActionPending) return;
    setWeekActionError("");
    const { task, from, to } = weekAdjustmentPreview;

    const previousWeekTasks = weekTasks;
    const nextWeekTasks = weekTasks.map((item) => item.id === task.id
      ? { ...item, date: to.isoDate, time: "待安排" }
      : item);
    const movedOutOfPage = task.date === pageDate && to.isoDate !== pageDate;
    setWeekActionPending(true);
    setWeekTasks(nextWeekTasks);
    setTasks(nextWeekTasks.filter((item) => item.date === pageDate));
    setSelectedWeekDay(to.isoDate);
    setWeekLoadDetailOpen(true);
    setWeekActionNotice(`已将“${task.title}”移至${to.dateLabel}，请确认新的开始时间。`);
    updatePageUrl({ date: to.isoDate });

    if (authStatus === "authenticated" && typeof task.id === "string") {
      try {
        await productApi.updateTask(task.id, {
          date: to.isoDate,
          rescheduleTrigger: "overload_recovery",
          recoveryStrategy: "standard",
        });
      } catch (reason) {
        setWeekTasks(previousWeekTasks);
        setTasks(previousWeekTasks.filter((item) => item.date === pageDate));
        setSelectedWeekDay(from.isoDate);
        updatePageUrl({ date: from.isoDate });
        setWeekActionNotice("");
        setWeekActionError(reason instanceof Error ? reason.message : "本周调整同步失败");
        setWeekActionPending(false);
        setWeekAdjustmentPreview(null);
        return;
      }
    }
    if (movedOutOfPage) {
      setScheduleBlocks((current) => current.filter((block) => String(block.taskId) !== String(task.id)));
      setScheduleConfirmed(true);
      setScheduleDirty(true);
      setScheduleNotice(`已从${pageDateLabel}的时间规划移除“${task.title}”，新日期需要重新安排时间。`);
    }
    setWeekActionPending(false);
    setWeekAdjustmentPreview(null);
  }

  function updateTaskPriority(id: string | number, nextPriority: string) {
    const target = tasks.find((task) => task.id === id);
    if (!target || target.priority === nextPriority) return;

    const nextTasks = tasks.map((task) =>
      task.id === id ? { ...task, priority: nextPriority } : task,
    );
    setTasks(nextTasks);

    if (authStatus === "authenticated" && typeof id === "string") {
      void productApi.updateTask(id, { priority: priorityToApi(nextPriority) }).catch((reason) => {
        setDataError(reason instanceof Error ? reason.message : "任务优先级同步失败");
        setTasks((current) => current.map((task) =>
          task.id === id ? { ...task, priority: target.priority } : task,
        ));
      });
    }
  }

  async function saveActualMinutes(task: DashboardTask) {
    if (!actualEntryTask || String(actualEntryTask.id) !== String(task.id)) return;
    const actualMinutes = Number.parseInt(actualEntryTask.value, 10);
    if (!Number.isFinite(actualMinutes) || actualMinutes < 0) return;
    setActualEntrySaving(true);
    const previous = task.actualMinutes;
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, actualMinutes } : item));
    setWeekTasks((current) => current.map((item) => item.id === task.id ? { ...item, actualMinutes } : item));
    try {
      if (authStatus === "authenticated" && typeof task.id === "string") {
        await productApi.recordActualMinutes(task.id, actualMinutes);
      }
      setActualEntryTask(null);
    } catch (reason) {
      setTasks((current) => current.map((item) => item.id === task.id ? { ...item, actualMinutes: previous } : item));
      setWeekTasks((current) => current.map((item) => item.id === task.id ? { ...item, actualMinutes: previous } : item));
      setDataError(reason instanceof Error ? reason.message : "实际投入同步失败");
    } finally {
      setActualEntrySaving(false);
    }
  }

  function openSchedulePlanner() {
    setPlannerNowMinute(pageDate === todayIso ? getCurrentMinute(scheduleTimezone) : 0);
    setPlannerStrategy("balanced");
    setSchedulePlannerOpen(true);
  }

  function revealScheduleScrollbar(region: "preview" | "availability" | "schedule") {
    setActiveScheduleScroll(region);
    if (scheduleScrollTimerRef.current !== null) window.clearTimeout(scheduleScrollTimerRef.current);
    scheduleScrollTimerRef.current = window.setTimeout(() => {
      setActiveScheduleScroll(null);
      scheduleScrollTimerRef.current = null;
    }, 620);
  }

  function applySchedulePreview() {
    if (!schedulePreview) return;
    setScheduleBlocks(schedulePreview.blocks);
    setScheduleConfirmed(true);
    setScheduleDirty(true);
    setTodayPlanMode("tasks");
    updatePageUrl({ mode: null });
    const strategyLabel = plannerStrategy === "balanced" ? "均衡" : "紧凑";
    if (schedulePreview.unscheduled.length) {
      setScheduleNotice(`已按${strategyLabel}方式安排 ${schedulePreview.scheduledTaskIds.length} 项，${schedulePreview.unscheduled.length} 项暂未排入。`);
    } else {
      setScheduleNotice(`已按${strategyLabel}方式生成安排，任务列表已同步更新。`);
    }
    setSchedulePlannerOpen(false);
  }

  function clearTechnologySchedule() {
    setScheduleBlocks([]);
    setScheduleConfirmed(true);
    setScheduleDirty(true);
    setScheduleNotice(`已清空${pageDateLabel}的时间安排。`);
  }

  function confirmTechnologySchedule() {
    if (!scheduleBlocks.length) return;
    setScheduleConfirmed(true);
    setScheduleDirty(true);
    setScheduleNotice("时间规划已确认，任务列表已同步显示完整时间段。");
  }

  async function addTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (taskSubmitState === "submitting" || taskSubmitLockRef.current) return;
    const title = newTask.title.trim();
    if (!title) return;
    const startMinute = parseTimeToMinute(newTask.time);
    const endMinute = parseTimeToMinute(newTask.endTime);
    if (startMinute === undefined || endMinute === undefined || endMinute <= startMinute) {
      setNewTaskTimeError("结束时间需要晚于开始时间");
      return;
    }
    const estimatedMinutes = endMinute - startMinute;
    const duration = `${estimatedMinutes} 分钟`;
    const hasScheduleConflict = scheduleBlocks.some((block) => {
      const blockStart = Math.round(block.startHour * 60);
      const blockEnd = blockStart + block.durationMinutes;
      return startMinute < blockEnd && endMinute > blockStart;
    });
    if (hasScheduleConflict) {
      setNewTaskTimeError("这个时段与已有安排重叠，请换一个时间。");
      return;
    }

    taskSubmitLockRef.current = true;
    setTaskSubmitState("submitting");
    setTaskSubmitError("");
    setDataError("");

    if (authStatus === "authenticated") {
      const goal = goalOptions.find((item) => item.id === newTask.goal && item.status === "active");
      if (!goal) {
        taskSubmitLockRef.current = false;
        setTaskSubmitState("error");
        setTaskSubmitError(goalsLoading ? "目标正在加载，请稍候。" : "请先创建一个目标，再添加任务。");
        return;
      }
      try {
        const hadUnsavedScheduleDraft = scheduleDirty;
        const priority = priorityToApi(newTask.priority);
        const created = await productApi.createTaskWithSchedule({ title, description: `用户在添加任务时选择了 ${newTask.time}–${newTask.endTime} 的计划时段。`, goalId: goal.id, estimatedMinutes, date: pageDate, priority, blocks: [{
          id: `technology-schedule-pending-${Date.now()}`,
          label: title,
          taskId: "pending",
          goalTitle: goal.title,
          startHour: startMinute / 60,
          durationMinutes: estimatedMinutes,
          color: SCHEDULE_COLORS[scheduleBlocks.length % SCHEDULE_COLORS.length],
          progress: 0,
        }] });
        setTasks((current) => [...current, taskFromApi(created)]);
        setScheduleBlocks((current) => [...current, {
          id: `task-schedule-${created.id}`,
          label: created.title,
          taskId: created.id,
          goalTitle: goal.title,
          startHour: startMinute / 60,
          durationMinutes: estimatedMinutes,
          color: SCHEDULE_COLORS[current.length % SCHEDULE_COLORS.length],
          progress: 0,
        }].sort((left, right) => left.startHour - right.startHour));
        setScheduleConfirmed(true);
        // The atomic endpoint already persisted the new block. Only retain a
        // dirty draft when the user had other unsaved local schedule edits.
        setScheduleDirty(hadUnsavedScheduleDraft);
      } catch (reason) {
        taskSubmitLockRef.current = false;
        setTaskSubmitState("error");
        setTaskSubmitError(reason instanceof Error ? reason.message : "任务添加失败");
        return;
      }
    } else {
      const localTaskId = Date.now();
      setTasks((current) => [...current, {
        id: localTaskId,
        goalId: goalOptions.find((goal) => goal.title === newTask.goal)?.id,
        date: pageDate,
        goal: newTask.goal,
        time: newTask.time,
        priority: newTask.priority,
        duration,
        title,
        done: false,
        actualMinutes: null,
      }]);
      setScheduleBlocks((current) => [...current, {
        id: `technology-schedule-${localTaskId}`,
        label: title,
        taskId: String(localTaskId),
        goalTitle: newTask.goal,
        startHour: startMinute / 60,
        durationMinutes: estimatedMinutes,
        color: SCHEDULE_COLORS[current.length % SCHEDULE_COLORS.length],
        progress: 0,
      }].sort((left, right) => left.startHour - right.startHour));
      setScheduleConfirmed(true);
      setScheduleDirty(true);
    }
    setTaskSubmitState("success");
    setTaskSuccessNotice(`已添加“${title}”，并安排在 ${newTask.time}–${newTask.endTime}。`);
    setNewTask((current) => ({ ...current, title: "" }));
    closeAddTask();
  }

  return (
    <div className="dashboard-page" data-today-iso={todayIso}>
      {(dataLoading || dataError || scheduleError || weekActionError) && (
        <DataSyncNotice
          loading={dataLoading && !dataError && !scheduleError && !weekActionError}
          title={dataError ? "今日计划同步失败" : scheduleError ? "时间规划同步失败" : weekActionError ? "本周计划同步失败" : "正在同步今日计划"}
          message={dataError || scheduleError || weekActionError || undefined}
          retryLabel="重新加载"
          onRetry={dataError
            ? () => window.location.reload()
            : scheduleError
              ? () => setScheduleRetryNonce((value) => value + 1)
              : weekActionError
                ? () => window.location.reload()
              : undefined}
        />
      )}

      {workspaceView === "today" ? (
        <>
          <ThemeDashboardLead data={leadData} />

          <section className="workspace-grid">
        <article id="today-plan" className={`panel today-panel ${legacyScheduleViewEnabled ? "is-schedule" : ""}`}>
          <header className="panel-header">
            <div>
              <small>TODAY</small>
              <h2>今日计划</h2>
            </div>
            <div className="today-plan-actions">
              <button
                type="button"
                className="today-plan-mode-switch"
                aria-label={scheduleBlocks.length > 0 ? "重新规划" : "打开时间规划"}
                onClick={openSchedulePlanner}
              >
                <CalendarClock size={14} />
                {scheduleBlocks.length > 0 ? "重新规划" : "时间规划"}
              </button>
              <button
                ref={addTaskButtonRef}
                type="button"
                className="today-plan-add"
                onClick={openAddTask}
              >
                <Plus size={14} />
                添加任务
              </button>
            </div>
          </header>

          <div className="plan-progress">
            <div>
              <span>{completed} / {tasks.length} 已完成</span>
              <b>{progress}%</b>
            </div>
            <i><span style={{ width: `${progress}%` }} /></i>
          </div>

          {scheduleNotice && (
            <p className="today-schedule-notice today-task-schedule-notice" role="status">
              {scheduleNotice}
            </p>
          )}

          {/* The legacy schedule-result branch remains below but is disabled. */}
          {!legacyScheduleViewEnabled ? (
            <div className="task-list">
              {displayedTasks.map((task) => {
                const canOpenTask = Boolean(resolveTaskGoalId(task));
                const isEditingActual = Boolean(actualEntryTask && String(actualEntryTask.id) === String(task.id));
                const scheduledProgress = scheduledProgressByTaskId.get(String(task.id));
                return (
                  <article
                    key={task.id}
                    className={`task-item ${task.done ? "is-done" : ""} ${task.id === nextTaskId ? "is-next" : ""} ${canOpenTask ? "is-navigable" : ""}`}
                  >
                    <button
                      type="button"
                      className="task-checkbox"
                      aria-label={`${task.done ? "标记为未完成：" : "标记为已完成："}${task.title}`}
                      aria-pressed={task.done}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleTask(task.id);
                      }}
                    >
                      <span className="task-checkbox-mark">
                        {task.done && <Check size={13} />}
                      </span>
                    </button>
                    <span
                      className={`task-schedule-rail ${scheduledProgress ? "is-scheduled" : ""}`}
                      style={scheduledProgress ? { backgroundColor: task.done ? "var(--workspace-border-strong)" : scheduledProgress.color } : undefined}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>{task.title}</strong>
                      <span>{task.goal} · {task.duration}</span>
                    </div>
                    {isEditingActual && actualEntryTask ? (
                      <form
                        ref={actualEditorRef}
                        className="task-meta is-completed task-actual-editor"
                        aria-label={`记录“${task.title}”的实际投入`}
                        onSubmit={(event) => { event.preventDefault(); void saveActualMinutes(task); }}
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActualEntryTask(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setActualEntryTask(null);
                        }}
                      >
                        <label className="task-actual-input">
                          <span className="visually-hidden">实际投入（分钟）</span>
                          <input
                            type="number"
                            min="0"
                            inputMode="numeric"
                            autoFocus
                            value={actualEntryTask.value}
                            onChange={(event) => setActualEntryTask((current) => current ? { ...current, value: event.target.value } : current)}
                            placeholder="0"
                          />
                          <em aria-hidden="true">分钟</em>
                        </label>
                        <button type="submit" disabled={actualEntrySaving}>{actualEntrySaving ? "保存中" : "保存"}</button>
                        <button type="button" className="task-actual-cancel" aria-label="取消记录实际投入" onClick={() => setActualEntryTask(null)}>
                          <X size={13} />
                        </button>
                      </form>
                    ) : (
                      <span className={`task-meta ${task.done ? "is-completed" : ""} ${scheduledProgress ? "is-scheduled" : ""}`}>
                        {task.done ? (
                          <button
                            type="button"
                            className="task-actual-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setActualEntryTask({ id: task.id, value: task.actualMinutes == null ? "" : String(task.actualMinutes) });
                            }}
                          >
                            <Clock3 size={12} aria-hidden="true" />
                            {task.actualMinutes == null ? "记录实际投入" : `实际 ${task.actualMinutes} 分钟`}
                          </button>
                        ) : (
                          <>
                            <small>{scheduledTimeByTaskId.get(String(task.id)) ?? formatTaskTimeRange(task.time, task.duration)}</small>
                            {scheduledProgress ? (
                              <span
                                className="task-elapsed-progress"
                                tabIndex={0}
                                aria-label={`时间流逝度 ${scheduledProgress.elapsed}%`}
                                title={scheduledProgress.elapsed >= 100 ? "该学习时段已经结束" : scheduledProgress.elapsed > 0 ? `当前时段已进行 ${scheduledProgress.elapsed}%` : "该学习时段尚未开始"}
                              >
                                <span className="task-elapsed-bar">
                                  <i><b style={{ width: `${scheduledProgress.elapsed}%` }} /></i>
                                </span>
                                <span className="task-elapsed-copy" aria-hidden="true">时间流逝度 · {scheduledProgress.elapsed}%</span>
                              </span>
                            ) : (
                              <TaskPriorityPicker
                                taskTitle={task.title}
                                value={task.priority}
                                onChange={(nextPriority) => updateTaskPriority(task.id, nextPriority)}
                              />
                            )}
                          </>
                        )}
                      </span>
                    )}
                    {canOpenTask && (
                      <button
                        type="button"
                        className="task-open-button"
                        aria-label={`打开任务：${task.title}`}
                        title={`跳转到目标详情：${task.goal}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          openTask(task);
                        }}
                      >
                        <ChevronRight className="task-open-indicator" size={14} aria-hidden="true" />
                      </button>
                    )}
                  </article>
                );
              })}
              {tasks.length === 0 && (
                <div className="today-task-empty" role="status">
                  <strong>今天还没有任务安排。</strong>
                  <span>添加一个带目标和时间的任务，计划会与日程保持同步。</span>
                </div>
              )}
            </div>
          ) : (
            <div className="today-schedule-view">
              {scheduleNotice && <p className="today-schedule-notice" role="status">{scheduleNotice}</p>}
              {scheduleSyncState === "saving" && <p className="today-schedule-sync" role="status">正在同步时间安排…</p>}
              {scheduleBlocks.length > 0 ? (
                <div
                  className={`today-schedule-list ${activeScheduleScroll === "schedule" ? "is-scrolling" : ""}`}
                  onScroll={() => revealScheduleScrollbar("schedule")}
                >
                  {(() => {
                    const currentMinute = pageDate === todayIso ? getCurrentMinute(scheduleTimezone) : 0;
                    return scheduleBlocks.map((block) => {
                      const task = tasks.find((item) => String(item.id) === String(block.taskId));
                      const endHour = block.startHour + block.durationMinutes / 60;
                      const startMinute = Math.round(block.startHour * 60);
                      const endMinute = startMinute + block.durationMinutes;
                      const elapsed = currentMinute <= startMinute
                        ? 0
                        : currentMinute >= endMinute
                          ? 100
                          : Math.round(((currentMinute - startMinute) / (endMinute - startMinute)) * 100);
                      return (
                        <div key={block.id} className={`today-schedule-row ${task?.done ? "is-done" : ""}`}>
                          <span className="today-schedule-color" style={{ backgroundColor: task?.done ? "var(--workspace-border-strong)" : block.color }} />
                          <span className="today-schedule-time">{formatScheduleHour(block.startHour)}–{formatScheduleHour(endHour)}</span>
                          <span className="today-schedule-divider" />
                          <span className="today-schedule-task">
                            <strong>{block.label}</strong>
                            <small>{block.goalTitle || task?.goal || "今日任务"} · {block.durationMinutes} 分钟</small>
                          </span>
                          <span
                            className="today-schedule-progress"
                            title={elapsed >= 100 ? "该学习时段已经结束" : elapsed > 0 ? `当前时段已进行 ${elapsed}%` : "该学习时段尚未开始"}
                          >
                            <small>时间流逝度</small>
                            <span>
                              <i><b style={{ width: `${elapsed}%`, backgroundColor: block.color }} /></i>
                              <em>{elapsed}%</em>
                            </span>
                          </span>
                        </div>
                      );
                    });
                  })()}
                </div>
              ) : (
                <div className="today-schedule-empty">
                  <span><Clock size={17} /></span>
                  <div>
                    <strong>把任务排进{pageDateLabel}的可用时段</strong>
                    <small>系统会结合优先级、预计时长和你的可用时段生成安排。</small>
                    {tasks.some((task) => !task.done) && (
                      <button type="button" className="today-schedule-empty-pending" onClick={openSchedulePlanner}>
                        <span>{tasks.filter((task) => !task.done).length} 项任务待安排</span>
                        <ArrowRight size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              )}
              {scheduleBlocks.length > 0 && (
                <footer className="today-schedule-footer">
                  <button
                    type="button"
                    className="today-schedule-replan"
                    onClick={openSchedulePlanner}
                    title="保留已开始的时间块，重新规划后续任务"
                  >
                    <CalendarClock size={13} />
                    重新规划
                  </button>
                  <div>
                    <button type="button" className="today-schedule-cancel" onClick={clearTechnologySchedule}>
                      <X size={13} />
                      取消
                    </button>
                    <button
                      type="button"
                      className="today-schedule-apply"
                      onClick={confirmTechnologySchedule}
                      disabled={scheduleConfirmed}
                      aria-label={scheduleConfirmed ? "安排已应用" : "应用安排"}
                    >
                      <Check size={13} />
                      应用
                    </button>
                  </div>
                </footer>
              )}
            </div>
          )}
          {schedulePlannerOpen && schedulePreview && (
            <div
              className="today-schedule-planner-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setSchedulePlannerOpen(false);
              }}
            >
              <section
                className="today-schedule-planner"
                role="dialog"
                aria-modal="true"
                aria-label={`自动规划${pageDateLabel}的任务`}
              >
                <header>
                  <div className="today-schedule-planner-title">
                    <span aria-hidden="true"><CalendarClock size={15} /></span>
                    <div>
                      <strong>自动规划</strong>
                      <small>选择一种节奏，预览会即时更新</small>
                    </div>
                  </div>
                  <div className="today-schedule-planner-modes" role="group" aria-label="选择规划节奏">
                    <button
                      type="button"
                      className={plannerStrategy === "balanced" ? "is-active" : ""}
                      aria-pressed={plannerStrategy === "balanced"}
                      onClick={() => setPlannerStrategy("balanced")}
                    >
                      <span><Clock3 size={13} />均衡</span>
                      <small role="tooltip">任务间保留 10 分钟</small>
                    </button>
                    <button
                      type="button"
                      className={plannerStrategy === "compact" ? "is-active" : ""}
                      aria-pressed={plannerStrategy === "compact"}
                      onClick={() => setPlannerStrategy("compact")}
                    >
                      <span><Timer size={13} />紧凑</span>
                      <small role="tooltip">连续安排，容纳更多任务</small>
                    </button>
                  </div>
                  <button type="button" className="today-schedule-planner-close" aria-label="关闭自动规划" onClick={() => setSchedulePlannerOpen(false)}>
                    <X size={15} />
                  </button>
                </header>

                <div className="today-schedule-planner-preview" key={plannerStrategy}>
                  {schedulePreview.blocks.length > 0 ? (
                    <div className={`today-schedule-planner-timeline ${activeScheduleScroll === "preview" ? "is-scrolling" : ""}`} onScroll={() => revealScheduleScrollbar("preview")}>
                      {schedulePreview.blocks.map((block) => (
                        <div key={block.id}>
                          <time>{formatScheduleHour(block.startHour)}–{formatScheduleHour(block.startHour + block.durationMinutes / 60)}</time>
                          <i style={{ backgroundColor: block.color }} />
                          <span><strong>{block.label}</strong><small>{block.durationMinutes} 分钟</small></span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="today-schedule-planner-empty">
                      <CalendarRange size={14} aria-hidden="true" />
                      <span>{pageDateLabel}剩余的可用时段不足以安排任务</span>
                    </div>
                  )}
                  {schedulePreview.unscheduled.length > 0 && (
                    <p className="today-schedule-planner-unresolved">
                      <ListTodo size={14} aria-hidden="true" />
                      <span>{schedulePreview.unscheduled.length} 项暂未排入，可切换节奏比较结果</span>
                    </p>
                  )}
                </div>

                <footer>
                  <div className="today-schedule-planner-availability">
                    <span>{pageDateLabel === "今天" ? "今日可用时段" : `${pageDateLabel}可用时段`}</span>
                    <strong
                      className={activeScheduleScroll === "availability" ? "is-scrolling" : ""}
                      aria-label={`今天剩余可用时段：${remainingAvailabilityLabels.length ? remainingAvailabilityLabels.join("、") : `${pageDateLabel}已没有剩余可用时间`}`}
                      tabIndex={0}
                    >
                      <span className="today-schedule-planner-availability-primary">
                        {remainingAvailabilityLabels[0] ?? `${pageDateLabel}已没有剩余可用时间`}
                      </span>
                      {remainingAvailabilityLabels.length > 1 && (
                        <span className="today-schedule-planner-availability-more" role="tooltip">
                          其余可用时段：{remainingAvailabilityLabels.slice(1).join("、")}
                        </span>
                      )}
                    </strong>
                    <Link href="/studio/settings?returnTo=%2Fstudio%2Fwork">调整</Link>
                  </div>
                  <div className="today-schedule-planner-footer-actions">
                    <button type="button" onClick={() => setSchedulePlannerOpen(false)}>取消</button>
                    <button type="button" className="is-primary" disabled={!schedulePreview.blocks.length} onClick={applySchedulePreview}>
                      <Check size={13} />应用
                    </button>
                  </div>
                </footer>
              </section>
            </div>
          )}
        </article>

        <article id="weekly-rhythm" className="panel rhythm-panel">
          <header className="panel-header">
            <div>
              <small>RHYTHM</small>
              <h2>本周节奏</h2>
            </div>
              <button
                type="button"
                className="rhythm-week-entry"
              onClick={() => changeWorkspaceView("week")}
            >
              <CalendarRange size={15} />
              <span>本周</span>
              <ArrowRight size={14} />
            </button>
          </header>

          <div className="rhythm-heatmap" aria-label="本周实际学习投入与后续计划">
            <header>
              <span>实际投入与后续计划</span>
              <small><i /> 实际投入 <i className="is-plan" /> 计划量</small>
            </header>
            <div className="rhythm-heatmap-grid">
              {rhythmDays.map((item) => {
                const isToday = item.phase === "today";
                const level = item.phase === "future"
                  ? "is-planned"
                  : item.actualMinutes >= 70
                  ? "is-peak"
                  : item.actualMinutes >= 40
                    ? "is-steady"
                    : "is-light";
                  const levelLabel = item.phase === "future"
                  ? "计划"
                  : item.phase === "today"
                    ? completedTodayMinutes !== null ? "已投入" : "待记录"
                    : item.actualMinutes >= 70
                      ? "高峰"
                      : item.actualMinutes >= 40
                      ? "稳定"
                      : "轻量";
                  const intensity = item.phase === "future"
                    ? null
                    : Math.min(24, 4 + item.actualMinutes * 0.17);
                  const rhythmStyle = intensity === null ? undefined : {
                    "--rhythm-fill": `${intensity}%`,
                    "--rhythm-fill-start": `${Math.max(3, intensity * 0.48)}%`,
                    "--rhythm-border": `${Math.min(38, intensity + 12)}%`,
                    "--rhythm-shadow": `${Math.min(6, 1.5 + item.actualMinutes * 0.035)}%`,
                  } as CSSProperties;
                return (
                  <article
                    key={item.day}
                    className={`${level} is-${item.phase} ${isToday ? "is-today" : ""}`}
                    style={rhythmStyle}
                    aria-current={isToday ? "date" : undefined}
                    aria-label={item.phase === "future"
                      ? `${item.day}计划学习 ${item.plannedMinutes} 分钟`
                      : item.phase === "today"
                        ? `${item.day}计划 ${item.plannedMinutes} 分钟，${completedTodayMinutes === null ? "暂无实际投入记录" : `已投入 ${completedTodayMinutes} 分钟`}`
                        : `${item.day}实际学习投入 ${item.actualMinutes} 分钟，${levelLabel}`}
                  >
                    <span>{item.short}</span>
                    <strong>{item.displayMinutes}</strong>
                    <small>分钟</small>
                    <em>{levelLabel}</em>
                  </article>
                );
              })}
            </div>
            <div className="rhythm-peak-note">
              <span><Clock3 size={16} /></span>
              <div>
                <strong>{rhythmPeak ? `截至今天，${rhythmPeak.day}投入最高` : hasActualWeekMinutes ? "本周实际投入正在积累" : "本周实际投入等待记录"}</strong>
                <small>{rhythmPeak ? `已投入 ${rhythmPeak.actualMinutes} 分钟；未来日期仅展示计划量` : hasActualWeekMinutes ? `已完成学习 ${weekActualMinutes} 分钟，节奏判断已生成` : "完成一次学习后，这里会生成节奏判断"}</small>
              </div>
            </div>
          </div>

          <div className="rhythm-summary" aria-label="本周节奏摘要">
            <article>
              <div>
                <b>{rhythmJudgment}</b>
                <span>本周节奏判断</span>
              </div>
              <div className="rhythm-summary-aside">
                <span>平均每日</span>
                <strong>{hasActualWeekMinutes ? `${averageActualMinutes} 分钟` : "—"}</strong>
              </div>
            </article>
            <article>
              <div>
                <b>{completed}/{tasks.length}</b>
                <span>今日任务完成</span>
              </div>
              <div className="rhythm-summary-aside is-positive">
                <span>本周已投入</span>
                <strong>{hasActualWeekMinutes ? `${weekActualMinutes} 分钟` : "—"}</strong>
              </div>
            </article>
          </div>
        </article>
          </section>

          <section className="coach-strip coach-strip-top coach-strip-goal-advice" aria-label="学习伙伴提醒">
            <span className="coach-avatar">P</span>
            <div>
              <small>Pilo · 长期学习伙伴</small>
              <strong>{weekPlannedMinutes === 0
                ? "本周任务还没有形成完整安排。"
                : hasWeekOverload
                  ? `我发现${peakAdjustmentDay.dateLabel}的计划可以提前调整。`
                  : capacityDays.length === 0
                    ? "本周任务已同步，等待目标容量后再判断负荷。"
                    : "本周已排任务目前都在稳定负荷内。"}</strong>
              <p>{weekPlannedMinutes === 0
                ? "为任务补充日期和预计时长后，我会持续检查每天的负荷。"
                : hasWeekOverload
                  ? `${peakAdjustmentDay.day}计划 ${peakAdjustmentDay.load} 分钟，超过当天可用容量 ${peakAdjustMinutes} 分钟。`
                  : capacityDays.length === 0
                    ? "在目标设置中配置每日容量后，我会提供可解释的调整建议。"
                    : `已安排 ${scheduledWeekDays.length} 个学习日，继续保持当前节奏即可。`}</p>
            </div>
            <Link href={coachContextHref}>
              查看建议
              <ArrowRight size={15} />
            </Link>
          </section>

        </>
      ) : (
        <section className={`week-plan-board week-plan-board-redesign focus-${selectedWeekTone}`} aria-label="本周计划">
          <header className="week-plan-heading">
            <div className="week-plan-copy">
              <div className="week-plan-meta">
                <button
                  type="button"
                  className="week-return-today"
                onClick={() => changeWorkspaceView("today")}
                >
                  <ArrowLeft className="week-return-arrow" size={16} aria-hidden="true" />
                  <span>返回今日</span>
                </button>
                <span className="week-plan-context-track">
                  <span className="week-plan-range">{weekRangeLabel}</span>
                </span>
              </div>
              <h2>{weekPlannedMinutes === 0
                ? "本周还没有形成可分析的任务安排。"
                : hasWeekOverload
                  ? `本周节奏基本可控，${peakAdjustmentDay.day}需要减负。`
                  : "本周负荷处于稳定区间，可以按计划推进。"}</h2>
              <p className="week-plan-summary-track">{weekPlannedMinutes === 0
                ? "添加带日期和预计时长的任务后，这里会根据真实安排生成负荷判断。"
                : `本周共安排 ${scheduledWeekDays.length} 个学习日，已完成 ${weekCompletedMinutes} 分钟，剩余 ${remainingWeekMinutes} 分钟。`}</p>
            </div>
            <div className="week-plan-overview" aria-label="本周概览">
              <article className="is-progress">
                <span>本周进度</span>
                <strong className="week-overview-value"><b>{weekProgress}</b><em>%</em></strong>
                <i><b style={{ width: `${weekProgress}%` }} /></i>
              </article>
              <article>
                <span>计划投入</span>
                <strong className="week-overview-value"><b>{Math.floor(weekPlannedMinutes / 60)}</b><em>h</em> <b>{weekPlannedMinutes % 60}</b><em>m</em></strong>
                <span className="week-overview-detail">{scheduledWeekDays.length} 个任务日总量</span>
              </article>
              <article>
                <span>待完成</span>
                <strong className="week-overview-value"><b>{Math.floor(remainingWeekMinutes / 60)}</b><em>h</em> <b>{remainingWeekMinutes % 60}</b><em>m</em></strong>
                <span className="week-overview-detail">{hasWeekOverload ? `${peakAdjustmentDay.day}优先调整` : "按日期继续推进"}</span>
              </article>
              <button
                type="button"
                className="week-plan-adjust"
                onClick={openWeekAdjustmentPreview}
                disabled={weekActionPending || !hasWeekOverload || !peakAdjustmentTask || !weekAdjustmentDestination}
              >
                {weekActionPending ? "正在调整…" : hasWeekOverload ? "智能调整本周" : "当前无需调整"}
                <ArrowRight size={14} />
              </button>
            </div>
          </header>

          {weekActionNotice && <div className="week-action-notice" role="status"><Check size={14} />{weekActionNotice}</div>}

          <div className="week-command-center">
            <section className="week-load-card">
              <header>
                <div className="week-card-heading">
                  <span className="week-card-icon"><CalendarRange size={18} /></span>
                  <div>
                    <small>LOAD MAP</small>
                    <h3>每日计划负荷</h3>
                  </div>
                </div>
                <span className="week-card-source" aria-label="柱形图图例">
                  <span><i className="is-plan" />计划量</span>
                  <span><i className="is-complete" />已完成量</span>
                </span>
              </header>
              <div className="week-load-chart" aria-label="本周每日计划分钟数">
                {weekPlan.map((item) => (
                  <button
                    type="button"
                    key={item.isoDate}
                    className={`${item.isoDate === todayIso ? "is-today" : ""} ${item.status === "负荷偏高" ? "is-risk" : ""} ${item.status === "已完成" ? "is-complete" : ""} ${item.status === "已安排" ? "is-planned" : ""} ${item.load === 0 ? "is-empty" : ""} ${selectedWeekPlan.isoDate === item.isoDate ? "is-selected" : ""}`}
                    aria-label={`查看${item.dateLabel}${item.day}计划，${item.load} 分钟，${item.status}`}
                    aria-pressed={selectedWeekPlan.isoDate === item.isoDate}
                    onClick={() => {
                      if (selectedWeekPlan.isoDate === item.isoDate) {
                        setWeekLoadDetailOpen((current) => !current);
                      } else {
                        changeWeekDay(item.isoDate);
                      }
                    }}
                  >
                    <b>{item.load}<small>m</small></b>
                    <div className="week-load-track">
                      <i
                        className="week-load-plan-fill"
                        style={{ height: `${Math.max(item.load ? 10 : 0, (item.load / maxWeekLoad) * 100)}%` }}
                      />
                      <span
                        className="week-load-complete-fill"
                        style={{ height: `${Math.max(item.completedMinutes ? 5 : 0, (item.completedMinutes / maxWeekLoad) * 100)}%` }}
                      />
                      {item.capacityMinutes !== null && (
                        <em
                          className="week-load-capacity-line"
                          style={{ bottom: `${Math.min(100, ((item.capacityMinutes ?? 0) / maxWeekLoad) * 100)}%` }}
                        />
                      )}
                    </div>
                    <strong>{item.day}</strong>
                    <small>{item.dateLabel}</small>
                    <span className="week-load-tooltip" role="tooltip">
                      <strong>{item.dateLabel} · {item.short}</strong>
                      <small>{item.tasks.length} 项任务，计划 {item.load} 分钟</small>
                      <small>已完成 {item.completedMinutes} 分钟，剩余 {item.remainingMinutes} 分钟</small>
                    </span>
                  </button>
                ))}
              </div>
              {weekLoadDetailOpen ? (
                <div className="week-load-selection" aria-live="polite">
                  <div><small>{selectedWeekPlan.dateLabel} · {selectedWeekPlan.short}</small><strong>{selectedWeekPlan.day}</strong></div>
                  <span><small>任务</small><strong>{selectedWeekPlan.tasks.length} 项</strong></span>
                  <span className="is-plan"><small>计划</small><strong>{selectedWeekPlan.load} 分钟</strong></span>
                  <span className="is-complete"><small>已完成</small><strong>{selectedWeekPlan.completedMinutes} 分钟</strong></span>
                  <span className="is-remaining"><small>待完成</small><strong>{selectedWeekPlan.remainingMinutes} 分钟</strong></span>
                </div>
              ) : (
                <p className="week-load-detail-hint">点击柱形，查看当日计划与完成数据</p>
              )}
              <footer className="week-load-caption">
                <span>悬浮查看数据，点击日期同步下方任务</span>
                <strong>{hasWeekOverload
                  ? `${peakAdjustmentDay.dateLabel} ${peakAdjustmentDay.load} 分钟 · 超出当天可用容量 ${peakAdjustMinutes} 分钟`
                  : scheduledWeekDays.length && capacityDays.length
                    ? `按每天各自的可用容量判断 · 当前安排可控`
                    : scheduledWeekDays.length
                      ? "尚未配置目标容量，暂不判断负荷"
                      : "暂无任务数据可判断负荷"}</strong>
              </footer>
            </section>

            <aside className="week-risk-card">
              <header>
                <span className="week-card-icon is-insight"><Gauge size={18} /></span>
                <div><small>WEEKLY INSIGHT</small><h3>本周关键判断</h3></div>
                <span className={`week-risk-level ${hasWeekOverload ? "" : "is-stable"}`}>{weekPlannedMinutes === 0 ? "等待数据" : hasWeekOverload ? "需要调整" : capacityDays.length === 0 ? "暂无容量" : "节奏稳定"}</span>
              </header>
              <h3>{weekPlannedMinutes === 0
                ? "安排任务后才能生成本周判断。"
                  : hasWeekOverload
                    ? `${peakAdjustmentDay.dateLabel}的负荷需要回收 ${peakAdjustMinutes} 分钟。`
                    : capacityDays.length === 0
                    ? "任务已同步，但尚未配置每日目标容量。"
                    : "本周没有超过稳定上限的任务日。"}</h3>
              <p>{weekPlannedMinutes === 0
                ? "当前不会展示虚构建议；任务日期、预计时长和完成状态齐备后再计算。"
                : hasWeekOverload
                  ? `该日有 ${peakAdjustmentDay.tasks.length} 项任务，共 ${peakAdjustmentDay.load} 分钟。只需移动一项低优先级任务，不必重排整周。`
                  : capacityDays.length
                    ? `已按每个学习日的可用时段核对 ${capacityDays.length} 天，可以保持当前节奏。`
                    : "当前账号没有配置每日目标容量，因此只展示任务和完成状态，不生成负荷判断。"}</p>
              <div className="week-risk-facts">
                <span><small>容量内任务日</small><strong>{capacityDays.length === 0 ? "—" : `${balancedWeekDays} / ${capacityDays.length}`}</strong></span>
                <span><small>峰值负荷</small><strong>{scheduledWeekDays.length ? `${peakLoadDay.load} 分钟` : "暂无"}</strong></span>
              </div>
              <div className="week-risk-action">
                <Sparkles size={15} />
                <span><strong>{hasWeekOverload ? "推荐调整" : "当前建议"}</strong> {weekPlannedMinutes === 0
                  ? "先为本周任务补充日期和预计时长。"
                  : hasWeekOverload
                    ? `将“${peakAdjustmentTask?.title ?? "一项低优先级任务"}”移动到相邻低负荷日。`
                    : capacityDays.length === 0
                      ? "先在目标设置中配置每日容量，再生成负荷建议。"
                      : "继续按当前顺序推进，无需额外重排。"}</span>
              </div>
              <button
                type="button"
                className="week-risk-adjust"
                onClick={() => {
                  if (!hasWeekOverload) return;
                  setSelectedWeekDay(peakAdjustmentDay.isoDate);
                  setTodayPlanMode("schedule");
                  changeWorkspaceView("today");
                  updatePageUrl({ mode: "schedule", date: peakAdjustmentDay.isoDate });
                }}
                disabled={!hasWeekOverload}
              >
                {hasWeekOverload ? "前往时间规划" : "无需重新排程"}
                <ArrowRight size={14} />
              </button>
            </aside>
          </div>

          <section className="week-agenda">
            <header>
              <div>
                  <small>WEEK AGENDA</small>
                  <h3>每天的计划与完成</h3>
                </div>
              <span><Clock3 size={14} /> 当前查看：{selectedWeekPlan.day}</span>
            </header>
            <div className="week-day-selector" role="tablist" aria-label="切换本周任务日期">
              {weekPlan.map((item, index) => (
                <button
                  type="button"
                  role="tab"
                  key={item.isoDate}
                  aria-selected={selectedWeekPlan.isoDate === item.isoDate}
                  className={`${item.status === "负荷偏高" ? "is-risk" : ""} ${item.isoDate === todayIso ? "is-today" : ""}`}
                  onClick={() => changeWeekDay(item.isoDate)}
                >
                  <strong>{item.isoDate === todayIso ? `${WEEKDAY_CN[index]} / 今天` : WEEKDAY_CN[index]}</strong>
                  <small>{item.dateLabel}</small>
                </button>
              ))}
            </div>
            <div className="week-day-focus" key={selectedWeekPlan.isoDate}>
              <div className="week-focus-task-list">
                {selectedWeekDetailTasks.map((entry) => {
                  const canOpen = Boolean(entry.task && resolveTaskGoalId(entry.task));
                  return (
                    <article
                      key={`${entry.title}-${entry.time}`}
                      className={canOpen ? "is-link" : ""}
                      role={canOpen ? "link" : undefined}
                      tabIndex={canOpen ? 0 : undefined}
                      aria-label={canOpen ? `打开任务：${entry.title}` : undefined}
                      onClick={() => { if (entry.task && canOpen) openTask(entry.task); }}
                      onKeyDown={(event) => {
                        if (!entry.task || !canOpen || (event.key !== "Enter" && event.key !== " ")) return;
                        event.preventDefault();
                        openTask(entry.task);
                      }}
                    >
                      <button
                        type="button"
                        className={`week-focus-task-toggle ${entry.state === "已完成" ? "is-complete" : ""}`}
                        aria-label={`${entry.state === "已完成" ? "标记为未完成" : "标记为已完成"}：${entry.title}`}
                        aria-pressed={entry.state === "已完成"}
                        onClick={(event) => { event.stopPropagation(); void toggleWeekTask(entry.task); }}
                      >
                        {entry.state === "已完成" && <Check size={11} />}
                      </button>
                      <div className="week-focus-task-copy"><strong>{entry.title}</strong></div>
                      <span className="week-focus-task-meta">{entry.goal} · {entry.duration}</span>
                      <time>{entry.time}</time>
                      <span className={`week-focus-task-priority is-${entry.priority}`}><i />{entry.priorityLabel}</span>
                      {canOpen && <ChevronRight size={14} aria-hidden="true" />}
                    </article>
                  );
                })}
                {selectedWeekDetailTasks.length === 0 && (
                  <p>{selectedWeekPlan.isoDate < todayIso
                    ? "当天没有可用的任务记录。"
                    : "当天尚未安排任务。"}</p>
                )}
              </div>
            </div>
          </section>
        </section>
      )}

      {taskSuccessNotice && (
        <div className="today-task-success" role="status">
          <Check size={14} aria-hidden="true" />
          <span>{taskSuccessNotice}</span>
          <button type="button" aria-label="关闭任务添加成功提示" onClick={() => setTaskSuccessNotice("")}><X size={13} /></button>
        </div>
      )}

      {weekAdjustmentPreview && (
        <div className="dialog-backdrop" onMouseDown={() => { if (!weekActionPending) setWeekAdjustmentPreview(null); }}>
          <section
            className="app-dialog week-adjustment-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="预览本周智能调整"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="task-dialog-kicker"><Sparkles size={12} /> CHANGE PREVIEW</span>
                <h2>确认本周智能调整</h2>
                <p>这一步只展示影响，确认后才会更新任务日期。</p>
              </div>
              <button type="button" aria-label="关闭调整预览" onClick={() => setWeekAdjustmentPreview(null)} disabled={weekActionPending}><X size={17} /></button>
            </header>
            <div className="week-adjustment-summary">
              <div><small>将移动任务</small><strong>{weekAdjustmentPreview.task.title}</strong><span>{weekAdjustmentPreview.task.goal} · {weekAdjustmentPreview.task.duration}</span></div>
              <ArrowRight size={16} aria-hidden="true" />
              <div><small>从 {weekAdjustmentPreview.from.dateLabel}</small><strong>移至 {weekAdjustmentPreview.to.dateLabel}</strong><span>新日期写入后，时间需要重新安排</span></div>
            </div>
            <div className="week-adjustment-impact">
              <span><small>原日计划</small><strong>{weekAdjustmentPreview.from.load} 分钟</strong></span>
              <span><small>新日计划</small><strong>{weekAdjustmentPreview.to.load + Number.parseInt(weekAdjustmentPreview.task.duration, 10)} 分钟</strong></span>
              <span><small>影响范围</small><strong>1 项任务</strong></span>
            </div>
            <footer>
              <button type="button" onClick={() => setWeekAdjustmentPreview(null)} disabled={weekActionPending}>取消</button>
              <button type="button" className="is-primary" onClick={() => void confirmWeekAdjustment()} disabled={weekActionPending}>
                {weekActionPending ? "正在保存…" : "确认并移动"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {undoTask && (
        <div className="task-undo-toast" role="status">
          <span>
            已{undoTask.previousDone ? "恢复" : "完成"}“{undoTask.title}”
          </span>
          <button type="button" onClick={restoreTask}>撤销</button>
        </div>
      )}

      {addTaskOpen && (
        <div
          className="dialog-backdrop"
          onMouseDown={closeAddTask}
        >
          <form
            className="app-dialog task-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="添加今日任务"
            onSubmit={addTask}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="task-dialog-kicker"><Plus size={12} /> QUICK TASK</span>
                <h2>添加今日任务</h2>
                <p>快速安排到今天，稍后仍可在计划中调整。</p>
              </div>
              <button
                type="button"
                aria-label="关闭添加任务"
                onClick={closeAddTask}
              >
                <X size={17} />
              </button>
            </header>
            <label>
              <span className="task-field-label"><ListTodo size={13} /> 任务名称</span>
              <input
                autoFocus
                value={newTask.title}
                onChange={(event) =>
                  setNewTask((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                placeholder="例如：复习二叉树遍历"
              />
            </label>
            {taskSubmitError && <p className="task-submit-error" role="alert">{taskSubmitError}</p>}
            {authStatus === "authenticated" && goalsLoading && <p className="task-submit-hint" role="status">正在加载可选目标…</p>}
            {authStatus === "authenticated" && !goalsLoading && goalOptions.length === 0 && <p className="task-submit-hint">当前账号还没有可关联的目标，请先创建目标。</p>}
            <div className="dialog-form-grid">
              <div className="task-time-range" aria-label="任务时间范围">
                <label>
                  <span className="task-field-label"><Clock3 size={13} /> 开始时间</span>
                  <ClockTimePicker
                    ariaLabel="今日任务开始时间"
                    value={newTask.time}
                    variant="form"
                    onChange={(value) => {
                      setNewTaskTimeError("");
                      setNewTask((current) => {
                        const startMinute = parseTimeToMinute(value);
                        const currentEndMinute = parseTimeToMinute(current.endTime);
                        const shouldMoveEnd = startMinute !== undefined
                          && (currentEndMinute === undefined || currentEndMinute <= startMinute);
                        return {
                          ...current,
                          time: value,
                          endTime: shouldMoveEnd
                            ? formatScheduleHour(Math.min(startMinute + 30, 23 * 60 + 59) / 60)
                            : current.endTime,
                        };
                      });
                    }}
                  />
                </label>
                <label>
                  <span className="task-field-label"><Clock size={13} /> 结束时间</span>
                  <ClockTimePicker
                    ariaLabel="今日任务结束时间"
                    value={newTask.endTime}
                    variant="form"
                    align="end"
                    onChange={(value) => {
                      setNewTaskTimeError("");
                      setNewTask((current) => ({ ...current, endTime: value }));
                    }}
                  />
                </label>
              </div>
              {newTaskTimeError && <p className="task-time-error" role="alert">{newTaskTimeError}</p>}
              <div className="task-dialog-field">
                <span className="task-field-label"><Target size={13} /> 关联目标</span>
                <QuickTaskSelect
                  ariaLabel="关联目标"
                  kind="goal"
                  menuLabel="选择关联目标"
                  options={quickTaskGoalOptions}
                  value={newTask.goal}
                  onValueChange={(value) =>
                    setNewTask((current) => ({
                      ...current,
                      goal: value,
                    }))
                  }
                />
              </div>
              <div className="task-dialog-field">
                <span className="task-field-label"><Flag size={13} /> 优先级</span>
                <QuickTaskSelect
                  ariaLabel="优先级"
                  kind="priority"
                  menuLabel="选择任务优先级"
                  options={quickTaskPriorityOptions}
                  value={newTask.priority}
                  onValueChange={(value) =>
                    setNewTask((current) => ({
                      ...current,
                      priority: value,
                    }))
                  }
                />
              </div>
            </div>
            <footer>
              <small>按 Enter 快速添加</small>
              <button type="button" onClick={closeAddTask}>
                取消
              </button>
              <button type="submit" disabled={taskSubmitState === "submitting" || (authStatus === "authenticated" && goalsLoading)}>
                {taskSubmitState === "submitting" ? <Clock3 size={14} /> : <Plus size={14} />}
                {taskSubmitState === "submitting" ? "正在添加…" : "添加到今日"}
              </button>
            </footer>
          </form>
        </div>
      )}

      {guestIntroOpen && <GuestModeDialog onClose={closeGuestIntro} />}

    </div>
  );
}
