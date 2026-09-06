"use client";

import { useState, useRef, useEffect, useCallback } from "react";


import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  ArrowLeft, CheckCircle2, Circle, Clock,
  Plus, Trash2, Pencil, FileText,
  Check, X, ChevronLeft, ChevronRight, ChevronDown,
  Loader2, BookOpen, Calendar, BarChart3,
} from "lucide-react";
import { useTasks, type Task, type Priority } from "@/lib/tasks-context";
import { cn } from "@/lib/utils";
import { VerificationDialog } from "@/components/agent/VerificationDialog";
import { ProgressOverview, type ProgressData } from "@/components/goal/ProgressOverview";
import PlanModeSelector, { type KbMode, type PacingMode } from "@/components/goal/PlanModeSelector";
import PlanDraftPreview, { type MacroPlanDraft, type PlanExecutionGuide } from "@/components/goal/PlanDraftPreview";
import { DebtCard } from "@/components/agent/DebtCard";
import { DataSyncNotice } from "@/components/ui/DataSyncNotice";
import { api, ApiError } from "@/lib/api";
import type { Goal } from "@/lib/stores/goalStore";
import TaskNoteDrawer from "@/components/notes/TaskNoteDrawer";
import GoalNotesPanel from "@/components/notes/GoalNotesPanel";
import { signalPiloContext } from "@/lib/technology/piloContext";
import { ensureGuestDatasetSeeded, guestApiGoals, guestGoalProgress } from "@/lib/technology/guestData";
import { useAuth } from "@/components/technology/AuthProvider";
import { PRODUCT_STORAGE_KEYS, readProductArray } from "@/lib/technology/productData";

const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })();
const MONTH_NAMES = ["一月","二月","三月","四月","五月","六月","七月","八月","九月","十月","十一月","十二月"];
const DAY_NAMES_SHORT = ["一","二","三","四","五","六","日"];

const STATUS_LABEL: Record<string, string> = {
  active: "进行中", completed: "已完成", paused: "暂停", abandoned: "已放弃",
};

const GUEST_DEMO_GOALS: Record<string, Goal> = Object.fromEntries(
  guestApiGoals().map((goal) => [goal.id, { ...goal, work_schedule: goal.work_schedule ?? "all", meta: {}, kb_id: null }]),
);

const LOCAL_GOAL_TYPES: Record<string, Goal["type"]> = {
  "考试备考": "exam",
  "认证学习": "certification",
  "技能提升": "skill",
  "阅读计划": "reading",
  "语言学习": "language",
  "习惯养成": "habit",
};

function readLocalGoal(id: string): Goal | null {
  const stored = readProductArray<Record<string, unknown>>(PRODUCT_STORAGE_KEYS.goals, [])
    .find((item) => String(item.id) === id);
  if (!stored || typeof stored.name !== "string") return null;
  const dailyText = String(stored.daily ?? "");
  const dailyMinutes = Number.parseFloat(dailyText.match(/[\d.]+/)?.[0] ?? "0");
  const status = stored.status === "已暂停" ? "paused" : stored.status === "已完成" ? "completed" : "active";
  return {
    id,
    type: (typeof stored.apiType === "string" ? stored.apiType : LOCAL_GOAL_TYPES[String(stored.type)]) as Goal["type"] ?? "skill",
    title: stored.name,
    deadline: String(stored.deadlineDate ?? ""),
    daily_hours: dailyMinutes / 60,
    current_level: "beginner",
    status,
    meta: {},
    created_at: new Date().toISOString(),
    work_schedule: "all",
    kb_id: null,
  };
}

function planErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "当前账号没有权限读取这份学习计划，请重新登录后重试。";
    if (error.status === 404) return "目标或学习计划不存在，请返回目标列表确认当前账号。";
  }
  return fallback;
}

function computeDaysLeft(deadline: string) {
  const diff = new Date(deadline).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function GoalExecutionPanel({
  goal,
  tasks,
  daysLeft,
  progressRefreshKey,
  useLocalProgress,
  onSelectDate,
  onCreateTask,
}: {
  goal: Goal;
  tasks: Task[];
  daysLeft: number;
  progressRefreshKey: number;
  useLocalProgress: boolean;
  onSelectDate: (date: string) => void;
  onCreateTask: () => void;
}) {
  const incompleteTasks = tasks.filter((task) => !task.done);
  const remainingMinutes = incompleteTasks.reduce((total, task) => total + task.estimatedMinutes, 0);
  const dailyCapacityMinutes = Math.max(0, Math.round(goal.daily_hours * 60));
  const requiredMinutesPerDay = remainingMinutes
    ? Math.ceil(remainingMinutes / Math.max(daysLeft, 1))
    : 0;
  const loadRatio = dailyCapacityMinutes
    ? requiredMinutesPerDay / dailyCapacityMinutes
    : requiredMinutesPerDay > 0 ? 2 : 0;
  const isOverCapacity = dailyCapacityMinutes > 0 && loadRatio > 1;
  const overloadMinutes = Math.max(0, requiredMinutesPerDay - dailyCapacityMinutes);
  const overloadPercent = dailyCapacityMinutes
    ? Math.round((overloadMinutes / dailyCapacityMinutes) * 100)
    : 0;
  const capacityScale = isOverCapacity ? Math.max(1.2, loadRatio * 1.08) : 1;
  const capacityMarkerPercent = dailyCapacityMinutes
    ? Math.min(100, 1 / capacityScale * 100)
    : 0;
  const requiredFillPercent = dailyCapacityMinutes
    ? Math.min(100, loadRatio / capacityScale * 100)
    : requiredMinutesPerDay > 0 ? 100 : 0;
  const dateAtOffset = (offset: number) => {
    const date = new Date(`${TODAY}T12:00:00`);
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const weekDays = Array.from({ length: 7 }, (_, offset) => {
    const date = dateAtOffset(offset);
    const dateTasks = tasks.filter((task) => task.date === date);
    const day = new Date(`${date}T12:00:00`);
    const labels = ["日", "一", "二", "三", "四", "五", "六"];
    return {
      date,
      label: offset === 0 ? "今天" : `周${labels[day.getDay()]}`,
      dateLabel: `${day.getMonth() + 1}/${day.getDate()}`,
      total: dateTasks.length,
      done: dateTasks.filter((task) => task.done).length,
      plannedMinutes: dateTasks.reduce((total, task) => total + task.estimatedMinutes, 0),
      completedMinutes: dateTasks.filter((task) => task.done).reduce((total, task) => total + task.estimatedMinutes, 0),
    };
  });
  const upcomingCount = weekDays.reduce((total, day) => total + day.total, 0);
  const maxWeekMinutes = Math.max(dailyCapacityMinutes, ...weekDays.map((day) => day.plannedMinutes), 1);
  const todayPlan = weekDays[0];
  const completedTasks = tasks.filter((task) => task.done).length;
  const localProgress: ProgressData | undefined = useLocalProgress
    ? guestGoalProgress(goal.id) ?? {
        goal_id: goal.id,
        title: goal.title,
        deadline: goal.deadline,
        total_tasks: tasks.length,
        completed_tasks: completedTasks,
        avg_completion_rate: tasks.length ? completedTasks / tasks.length : 0,
        streak_days: completedTasks ? 1 : 0,
        debt_count: tasks.filter((task) => !task.done && task.date < TODAY).length,
        days_ahead_or_behind: null,
      }
    : undefined;
  const formatDuration = (minutes: number) => {
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.round((minutes / 60) * 10) / 10;
    return `${hours} 小时`;
  };
  const metrics = (
    <div className="goal-execution-metrics" role="group" aria-label="目标与执行指标">
      <header className="goal-execution-section-header">
        <span><BarChart3 size={14} aria-hidden="true" />目标概览</span>
      </header>
      <ProgressOverview goalId={goal.id} refreshKey={progressRefreshKey} localData={localProgress} />
      <dl className="goal-execution-kpis">
        <div><dt><CheckCircle2 size={14} aria-hidden="true" /><span>今日完成</span></dt><dd>{todayPlan.total ? `${todayPlan.done}/${todayPlan.total}` : "暂无"}</dd></div>
        <div><dt><Calendar size={14} aria-hidden="true" /><span>未来一周</span></dt><dd>{upcomingCount}<small>项</small></dd></div>
        <div><dt><Clock size={14} aria-hidden="true" /><span>剩余投入</span></dt><dd>{formatDuration(remainingMinutes)}</dd></div>
      </dl>
    </div>
  );

  if (tasks.length === 0) {
    return (
      <section className="goal-execution is-empty" aria-label="当前目标执行节奏">
        <div className="goal-execution-empty-content">
          <div className="goal-execution-empty-icon" aria-hidden="true"><BarChart3 size={20} /></div>
          <strong>暂无可分析的执行数据</strong>
          <p>安排至少一个学习任务后，这里会分析每日投入与未来一周的负荷分布。</p>
          <button type="button" onClick={onCreateTask}>
            <Plus size={14} /> 新建任务
          </button>
        </div>
      </section>
    );
  }

  if (incompleteTasks.length === 0) {
    return (
      <section className="goal-execution is-complete" aria-label="当前目标执行节奏">
        {metrics}
        <div className="goal-execution-empty-content">
          <div className="goal-execution-empty-icon" aria-hidden="true"><CheckCircle2 size={20} /></div>
          <strong>当前任务已全部完成</strong>
          <p>这个目标暂时没有待完成任务。可以继续查看学习计划，安排下一阶段。</p>
          <span>{tasks.length} 项任务已完成</span>
        </div>
      </section>
    );
  }

  const capacityStatus = dailyCapacityMinutes === 0
    ? "未设置日投入"
    : isOverCapacity
      ? `超出 ${overloadPercent}%`
      : loadRatio > 0.8
        ? "接近投入上限"
        : "时间充足";
  const capacityStatusTone = dailyCapacityMinutes === 0
    ? "is-unset"
    : isOverCapacity
      ? "is-overloaded"
      : loadRatio > 0.8
        ? "is-near"
        : "is-sufficient";
  const capacityUsagePercent = dailyCapacityMinutes > 0 ? Math.round(loadRatio * 100) : 0;
  const capacitySummary = dailyCapacityMinutes === 0
    ? "设置每日可投入时间后显示占用比例"
    : isOverCapacity
      ? `超出每日可投入 ${overloadMinutes} 分钟`
      : `占用 ${capacityUsagePercent}%，还可安排 ${Math.max(0, dailyCapacityMinutes - requiredMinutesPerDay)} 分钟/日`;
  return (
    <section className="goal-execution" aria-label="当前目标执行节奏">
      {metrics}

      <section className={`goal-execution-capacity ${isOverCapacity ? "is-overloaded" : ""}`} aria-label="每日投入">
        <header className="goal-execution-section-header">
          <span><Clock size={14} aria-hidden="true" />每日投入</span>
          <em className={`goal-execution-section-status goal-capacity-status ${capacityStatusTone}`}>{capacityStatus}</em>
        </header>
        <div className="goal-execution-capacity-summary">
          <div>
            <span>计划所需</span>
            <strong>{requiredMinutesPerDay}<small>分钟/日</small></strong>
          </div>
        </div>
        <div
          className={`goal-execution-capacity-track ${isOverCapacity ? "is-overloaded" : ""}`}
          role="img"
          aria-label={`每天计划需要 ${requiredMinutesPerDay} 分钟，每日可投入 ${dailyCapacityMinutes} 分钟${isOverCapacity ? `，超出 ${overloadMinutes} 分钟，超出比例 ${overloadPercent}%` : ""}`}
        >
          <i style={{ width: `${isOverCapacity ? capacityMarkerPercent : requiredFillPercent}%` }} />
          {isOverCapacity && (
            <em
              aria-hidden="true"
              style={{
                left: `${capacityMarkerPercent}%`,
                width: `${Math.max(0, requiredFillPercent - capacityMarkerPercent)}%`,
              }}
            />
          )}
          {dailyCapacityMinutes > 0 && <span aria-hidden="true" style={{ left: `${capacityMarkerPercent}%` }} />}
        </div>
        <footer>
          <span>{capacitySummary}</span>
        </footer>
      </section>

      <section className="goal-execution-week" aria-label="未来一周任务安排">
        <header className="goal-execution-section-header">
          <span><Calendar size={14} aria-hidden="true" />未来一周安排</span>
          <strong className="goal-execution-section-status">{upcomingCount} 项已安排</strong>
        </header>
        <div className="goal-execution-week-chart" role="group" aria-label={`未来七天共安排 ${upcomingCount} 项任务`}>
          {weekDays.map((day, index) => (
            <button
              type="button"
              key={day.date}
              className={`${index === 0 ? "is-today" : ""} ${day.total ? "is-planned" : "is-empty"} ${day.done === day.total && day.total > 0 ? "is-complete" : ""} ${day.plannedMinutes > dailyCapacityMinutes && dailyCapacityMinutes > 0 ? "is-risk" : ""}`}
              style={{ animationDelay: `${120 + index * 40}ms` }}
              aria-label={`打开${day.dateLabel}${day.label}的任务日历，计划 ${day.plannedMinutes} 分钟，完成 ${day.completedMinutes} 分钟`}
              onClick={() => onSelectDate(day.date)}
            >
              <b>{day.plannedMinutes}<small>m</small></b>
              <span className="goal-execution-week-track" aria-hidden="true">
                <i style={{ height: `${Math.max(day.plannedMinutes ? 8 : 0, day.plannedMinutes / maxWeekMinutes * 100)}%` }} />
                <em style={{ height: `${Math.max(day.completedMinutes ? 4 : 0, day.completedMinutes / maxWeekMinutes * 100)}%` }} />
                {dailyCapacityMinutes > 0 && <u style={{ bottom: `${Math.min(100, dailyCapacityMinutes / maxWeekMinutes * 100)}%` }} />}
              </span>
              <strong>{day.label}</strong>
              <small>{day.dateLabel}</small>
              <span className="goal-execution-week-tooltip" role="tooltip">
                <strong>{day.dateLabel} · {day.label}</strong>
                <small>{day.total} 项任务，计划 {day.plannedMinutes} 分钟</small>
                <small>已完成 {day.completedMinutes} 分钟，剩余 {Math.max(0, day.plannedMinutes - day.completedMinutes)} 分钟</small>
              </span>
            </button>
          ))}
        </div>
        <footer><span><i className="is-planned" />计划量</span><span><i className="is-done" />已完成量</span><span><i className="is-capacity" />可投入上限</span></footer>
      </section>
    </section>
  );
}

// ── 月历组件 ─────────────────────────────────────────────────
function MiniCalendar({
  tasksByDate, selectedDate, onSelect,
}: {
  tasksByDate: Record<string, Task[]>; selectedDate: string; onSelect: (d: string) => void;
}) {
  const todayParts = TODAY.split("-");
  const [viewYear, setViewYear] = useState(Number(todayParts[0]));
  const [viewMonth, setViewMonth] = useState(Number(todayParts[1]) - 1);

  useEffect(() => {
    const [year, month] = selectedDate.split("-").map(Number);
    if (!year || !month) return;
    setViewYear(year);
    setViewMonth(month - 1);
  }, [selectedDate]);

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  }

  function fmt(y: number, m: number, d: number) {
    return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const startOffset = firstDow === 0 ? 6 : firstDow - 1;

  const cells: (number | null)[] = [
    ...Array(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="goal-mini-calendar w-full">
      <div className="goal-mini-calendar-header mb-1.5 flex items-center justify-between">
        <button type="button" aria-label="上个月" onClick={prevMonth} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500 transition">
          <ChevronLeft size={14} />
        </button>
        <div className="goal-mini-calendar-heading">
          <span className="goal-mini-calendar-title text-gray-700">{viewYear}年 {MONTH_NAMES[viewMonth]}</span>
          <div className="goal-mini-calendar-legend text-gray-400" aria-label="任务状态图例">
            <span>
              <i style={{ backgroundColor: "var(--accent)" }} />已完成
            </span>
            <span>
              <i className="bg-amber-400" />待完成
            </span>
          </div>
        </div>
        <button type="button" aria-label="下个月" onClick={nextMonth} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500 transition">
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="goal-mini-calendar-body">
        <div className="goal-mini-calendar-weekdays mb-0.5 grid grid-cols-7">
          {DAY_NAMES_SHORT.map((d) => (
            <div key={d} className="py-0.5 text-center text-gray-300">{d}</div>
          ))}
        </div>

        <div className="goal-mini-calendar-days grid grid-cols-7 gap-y-px">
          {cells.map((day, i) => {
            if (!day) return <div key={i} />;
            const dateStr = fmt(viewYear, viewMonth, day);
            const hasTasks = !!tasksByDate[dateStr]?.length;
            const allDone = hasTasks && tasksByDate[dateStr].every((t) => t.done);
            const isToday = dateStr === TODAY;
            const isSelected = dateStr === selectedDate;
            return (
              <button key={i} onClick={() => onSelect(dateStr)}
                className={cn(
                  "relative flex flex-col items-center justify-center rounded-md leading-none transition",
                  isSelected ? "text-white font-semibold"
                  : isToday ? "font-bold text-gray-900 ring-1 ring-inset ring-gray-300"
                  : "text-gray-600 hover:bg-gray-100",
                )}
                style={isSelected ? { backgroundColor: "var(--accent)" } : {}}
              >
                {day}
                {hasTasks && (
                  <span className="absolute bottom-0.5 w-1 h-1 rounded-full"
                    style={{ backgroundColor: isSelected ? "rgba(255,255,255,0.7)" : allDone ? "var(--accent)" : "#f59e0b" }} />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const PRIORITY_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };
const PRIORITY_DOT: Record<string, string> = { high: "bg-red-400", medium: "bg-yellow-400", low: "bg-gray-300" };
const PRIORITY_CLS: Record<string, { on: string; off: string }> = {
  high:   { on: "bg-red-500 text-white",    off: "text-red-500 hover:bg-red-50" },
  medium: { on: "bg-yellow-400 text-white", off: "text-yellow-600 hover:bg-yellow-50" },
  low:    { on: "bg-gray-400 text-white",   off: "text-gray-400 hover:bg-gray-100" },
};

// ── 任务列表（单天） ─────────────────────────────────────────
function DayTaskList({
  tasks, selectedDate, goalId, goalTitle, focusTaskId,
}: {
  tasks: Task[]; selectedDate: string; goalId: string; goalTitle: string; focusTaskId?: string | null;
}) {
  const { addTask, updateTask, deleteTask, toggleTask } = useTasks();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editMinutes, setEditMinutes] = useState(30);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newMinutes, setNewMinutes] = useState(30);
  const [newPriority, setNewPriority] = useState<Priority>("medium");
  const [editPriority, setEditPriority] = useState<Priority>("medium");
  const [noteTask, setNoteTask] = useState<Task | null>(null);
  const addRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (showAdd) addRef.current?.focus(); }, [showAdd]);

  const dayTasks = tasks.filter((t) => t.goalId === goalId && t.date === selectedDate);
  const done = dayTasks.filter((t) => t.done).length;
  const isToday = selectedDate === TODAY;

  function saveEdit(id: string) {
    if (editTitle.trim()) updateTask(id, { title: editTitle.trim(), estimatedMinutes: editMinutes, priority: editPriority });
    setEditingId(null);
  }

  function submitAdd() {
    if (!newTitle.trim()) return;
    addTask({ title: newTitle.trim(), goalId, goalTitle, done: false, estimatedMinutes: newMinutes, date: selectedDate, priority: newPriority });
    setNewTitle(""); setNewMinutes(30); setNewPriority("medium"); setShowAdd(false);
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500">{isToday ? "今日任务" : selectedDate}</span>
        <div className="flex items-center gap-2">
          {dayTasks.length > 0 && <span className="text-xs text-gray-400">{done}/{dayTasks.length} 完成</span>}
          <button onClick={() => setShowAdd((v) => !v)} className="p-1 rounded-lg transition" style={{ color: "var(--accent)" }}>
            <Plus size={13} />
          </button>
        </div>
      </div>

      {showAdd && (
        <div className="mb-2 p-2.5 bg-gray-50 rounded-xl border border-gray-100 space-y-1.5">
          <input ref={addRef} value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); if (e.key === "Escape") setShowAdd(false); }}
            placeholder="任务名称…" className="w-full px-2.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none" />
          <div className="flex items-center gap-1.5">
            <input type="number" min={5} max={480} value={newMinutes} onChange={(e) => setNewMinutes(Number(e.target.value))}
              className="w-14 px-2 py-1 text-xs bg-white border border-gray-200 rounded-lg outline-none text-center" />
            <span className="text-xs text-gray-400">分钟</span>
            <div className="flex gap-0.5 ml-1">
              {(["high", "medium", "low"] as Priority[]).map((p) => (
                <button key={p} type="button" onClick={() => setNewPriority(p)}
                  className={cn("px-1.5 py-0.5 text-xs rounded-md transition", PRIORITY_CLS[p][newPriority === p ? "on" : "off"])}>
                  {PRIORITY_LABEL[p]}
                </button>
              ))}
            </div>
            <div className="ml-auto flex gap-1">
              <button onClick={() => setShowAdd(false)} className="text-xs px-2 py-1 rounded-lg bg-gray-100 text-gray-500">取消</button>
              <button onClick={submitAdd} className="text-xs px-2 py-1 rounded-lg text-white" style={{ backgroundColor: "var(--accent)" }}>保存</button>
            </div>
          </div>
        </div>
      )}

      {dayTasks.length === 0 && !showAdd && (
        <p className="text-xs text-gray-400 py-3 text-center">当天暂无任务</p>
      )}

      <div className="goal-task-scroll space-y-1 max-h-40 overflow-y-auto">
        {dayTasks.map((task) => (
          <div
            key={task.id}
            data-search-target={focusTaskId === task.id ? "true" : undefined}
            className={cn("goal-task-item group flex items-start gap-2 px-2.5 py-2 rounded-xl transition", focusTaskId === task.id && "is-search-target")}
          >
            <button onClick={() => toggleTask(task.id)} className="mt-0.5 flex-shrink-0">
              {task.done
                ? <CheckCircle2 size={14} style={{ color: "var(--accent)" }} />
                : <Circle size={14} className="text-gray-300 group-hover:text-gray-400 transition" />}
            </button>
            {editingId === task.id ? (
              <div className="flex-1 space-y-1">
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveEdit(task.id); if (e.key === "Escape") setEditingId(null); }}
                  className="w-full px-2 py-1 text-xs bg-white border border-gray-200 rounded-lg outline-none" autoFocus />
                <div className="flex items-center gap-1">
                  <input type="number" min={5} max={480} value={editMinutes} onChange={(e) => setEditMinutes(Number(e.target.value))}
                    className="w-12 px-1.5 py-0.5 text-xs bg-white border border-gray-200 rounded-lg outline-none text-center" />
                  <span className="text-xs text-gray-400">min</span>
                  <div className="flex gap-0.5 ml-1">
                    {(["high", "medium", "low"] as Priority[]).map((p) => (
                      <button key={p} type="button" onClick={() => setEditPriority(p)}
                        className={cn("px-1.5 py-0.5 text-xs rounded-md transition", PRIORITY_CLS[p][editPriority === p ? "on" : "off"])}>
                        {PRIORITY_LABEL[p]}
                      </button>
                    ))}
                  </div>
                  <button onClick={() => saveEdit(task.id)} className="ml-auto p-1" style={{ color: "var(--accent)" }}><Check size={11} /></button>
                  <button onClick={() => setEditingId(null)} className="p-1 text-gray-400"><X size={11} /></button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <p className={cn("text-[13px] font-medium leading-snug", task.done ? "line-through text-gray-400" : "text-gray-700")}>{task.title}</p>
                  <span className="goal-task-meta mt-1 flex w-fit items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-gray-400">
                    <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", PRIORITY_DOT[task.priority ?? "medium"])} />
                    <Clock size={9} />{task.estimatedMinutes} 分钟
                  </span>
                </div>
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition">
                  <button onClick={() => setNoteTask(task)} title="记笔记"
                    className="p-1 rounded hover:bg-gray-100 text-gray-400"><FileText size={10} /></button>
                  <button onClick={() => { setEditingId(task.id); setEditTitle(task.title); setEditMinutes(task.estimatedMinutes); setEditPriority(task.priority ?? "medium"); }}
                    className="p-1 rounded hover:bg-gray-100 text-gray-400"><Pencil size={10} /></button>
                  <button onClick={() => deleteTask(task.id)} className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"><Trash2 size={10} /></button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <TaskNoteDrawer task={noteTask} onClose={() => setNoteTask(null)} />
    </div>
  );
}

// ── 任务工作区：同一组件内切换今日清单与日历 ────────────────
function GoalTasksWorkspace({
  goal,
  tasks,
  selectedDate,
  onSelectDate,
  onToggleTask,
  onVerify,
  focusTaskId,
  createTaskRequestKey,
}: {
  goal: Goal;
  tasks: Task[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onToggleTask: (taskId: string) => void;
  onVerify: (task: Task) => void;
  focusTaskId?: string | null;
  createTaskRequestKey: number;
}) {
  const { addTask, updateTask, deleteTask } = useTasks();
  const [view, setView] = useState<"today" | "calendar">("today");
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newMinutes, setNewMinutes] = useState(30);
  const [newPriority, setNewPriority] = useState<Priority>("medium");
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editMinutes, setEditMinutes] = useState(30);
  const [editPriority, setEditPriority] = useState<Priority>("medium");
  const addRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showAdd) addRef.current?.focus();
  }, [showAdd]);

  useEffect(() => {
    if (createTaskRequestKey === 0) return;
    setView("today");
    onSelectDate(TODAY);
    setShowAdd(true);
  }, [createTaskRequestKey, onSelectDate]);

  useEffect(() => {
    if (!focusTaskId) return;
    const focusedTask = tasks.find((task) => task.id === focusTaskId);
    if (!focusedTask) return;
    setView(focusedTask.date === TODAY ? "today" : "calendar");
    onSelectDate(focusedTask.date);
  }, [focusTaskId, onSelectDate, tasks]);

  useEffect(() => {
    if (!focusTaskId) return;
    const timer = window.setTimeout(() => {
      workspaceRef.current?.querySelector<HTMLElement>('[data-search-target="true"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [focusTaskId, selectedDate, view]);

  useEffect(() => {
    if (selectedDate !== TODAY) setView("calendar");
  }, [selectedDate]);

  const todayTasks = tasks.filter((task) => task.date === TODAY);
  const doneTasks = todayTasks.filter((task) => task.done).length;
  const tasksByDate = tasks.reduce<Record<string, Task[]>>((acc, task) => {
    if (!acc[task.date]) acc[task.date] = [];
    acc[task.date].push(task);
    return acc;
  }, {});

  function cancelAdd() {
    setShowAdd(false);
    setNewTitle("");
    setNewMinutes(30);
    setNewPriority("medium");
  }

  async function submitAdd() {
    const title = newTitle.trim();
    if (!title || isCreating) return;
    setIsCreating(true);
    try {
      await addTask({
        title,
        goalId: goal.id,
        goalTitle: goal.title,
        done: false,
        estimatedMinutes: Math.min(480, Math.max(5, newMinutes || 30)),
        date: TODAY,
        priority: newPriority,
      });
      cancelAdd();
    } finally {
      setIsCreating(false);
    }
  }

  function beginEdit(task: Task) {
    setEditingId(task.id);
    setEditTitle(task.title);
    setEditMinutes(task.estimatedMinutes);
    setEditPriority(task.priority ?? "medium");
  }

  async function saveEdit(taskId: string) {
    const title = editTitle.trim();
    if (!title) return;
    setEditingId(null);
    await updateTask(taskId, {
      title,
      estimatedMinutes: Math.min(480, Math.max(5, editMinutes || 30)),
      priority: editPriority,
    });
  }

  return (
    <div ref={workspaceRef} className="goal-tasks-workspace px-4 py-4 min-h-[260px]">
      <div className="goal-task-toolbar mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-gray-100 pb-2">
        <div
          className="goal-task-view-tabs inline-flex items-center gap-4"
          role="tablist"
          aria-label="任务查看方式"
        >
          {(["today", "calendar"] as const).map((item) => {
            const active = view === item;
            const Icon = item === "today" ? CheckCircle2 : Calendar;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setView(item)}
                className={cn(
                  "goal-task-view-tab relative flex items-center transition",
                  active && "is-active"
                )}
              >
                <Icon size={13} />
                {item === "today" ? "今日任务" : "任务日历"}
              </button>
            );
          })}
        </div>
        {view === "today" ? (
          <div className="goal-task-toolbar-actions ml-auto flex items-center gap-2">
            {todayTasks.length > 0 && <span className="text-xs text-gray-400">{doneTasks}/{todayTasks.length} 已完成</span>}
            {todayTasks.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="goal-task-add-button flex items-center gap-1 rounded-lg border px-3 font-medium transition"
                style={{
                  color: "var(--accent)",
                  borderColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
                  backgroundColor: "var(--accent-light)",
                }}
              >
                <Plus size={13} />
                新建任务
              </button>
            )}
          </div>
        ) : selectedDate !== TODAY ? (
            <button
              type="button"
              onClick={() => onSelectDate(TODAY)}
              className="text-xs text-gray-400 transition hover:text-gray-600"
            >
              回到今天
            </button>
        ) : null}
      </div>

      {view === "today" ? (
        <div className="space-y-1">
          {showAdd && (
            <div className="goal-task-editor mb-2 rounded-xl border border-gray-100 px-3 py-2.5">
              <input
                ref={addRef}
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitAdd();
                  if (event.key === "Escape") cancelAdd();
                }}
                placeholder={`为“${goal.title}”添加今日任务`}
                aria-label="任务名称"
                className="w-full bg-transparent text-[13px] font-medium text-gray-700 outline-none placeholder:text-gray-300"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-[11px] text-gray-400">
                  <Clock size={11} />
                  <input
                    type="number"
                    min={5}
                    max={480}
                    value={newMinutes}
                    onChange={(event) => setNewMinutes(Number(event.target.value))}
                    className="goal-task-minutes w-14 rounded-md border border-gray-100 bg-transparent px-1.5 py-1 text-center text-[11px] outline-none"
                  />
                  分钟
                </label>
                <div className="flex items-center gap-1" aria-label="任务优先级">
                  {(["high", "medium", "low"] as Priority[]).map((priority) => (
                    <button
                      key={priority}
                      type="button"
                      onClick={() => setNewPriority(priority)}
                      className={cn(
                        "rounded-md px-1.5 py-0.5 text-[10px] transition",
                        PRIORITY_CLS[priority][newPriority === priority ? "on" : "off"]
                      )}
                    >
                      {PRIORITY_LABEL[priority]}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-1">
                  <button type="button" onClick={cancelAdd} className="rounded-md px-2 py-1 text-[11px] text-gray-400 transition hover:bg-gray-100">
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitAdd()}
                    disabled={!newTitle.trim() || isCreating}
                    className="rounded-md px-2 py-1 text-[11px] font-medium text-white transition disabled:opacity-40"
                    style={{ backgroundColor: "var(--accent)" }}
                  >
                    {isCreating ? "创建中…" : "创建"}
                  </button>
                </div>
              </div>
            </div>
          )}
          {todayTasks.length === 0 && !showAdd && (
            <div className="goal-task-empty">
              <span className="goal-task-empty-icon" aria-hidden="true"><CheckCircle2 size={19} /></span>
              <strong>今天还没有学习任务</strong>
              <p>添加一个 15–60 分钟的小任务，开始推进“{goal.title}”。</p>
            </div>
          )}
          {todayTasks.map((task) => (
            <div
              key={task.id}
              data-search-target={focusTaskId === task.id ? "true" : undefined}
              className={cn("goal-task-item group flex items-start gap-2 rounded-xl px-2.5 py-2.5 transition", focusTaskId === task.id && "is-search-target")}
            >
              <button type="button" onClick={() => onToggleTask(task.id)} className="mt-0.5 flex-shrink-0" aria-label={task.done ? "标记为未完成" : "标记为已完成"}>
                {task.done
                  ? <CheckCircle2 size={15} style={{ color: "var(--accent)" }} />
                  : <Circle size={15} className="flex-shrink-0 text-gray-300 transition group-hover:text-gray-400" />}
              </button>
              {editingId === task.id ? (
                <div className="goal-task-inline-editor min-w-0 flex-1">
                  <input
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveEdit(task.id);
                      if (event.key === "Escape") setEditingId(null);
                    }}
                    aria-label="编辑任务名称"
                    className="goal-task-editor-title w-full outline-none"
                    autoFocus
                  />
                  <div className="goal-task-editor-controls">
                    <label className="goal-task-duration-control">
                      <span className="goal-task-control-label">预计时长</span>
                      <Clock size={13} aria-hidden="true" />
                      <input
                        type="number"
                        min={5}
                        max={480}
                        value={editMinutes}
                        onChange={(event) => setEditMinutes(Number(event.target.value))}
                        className="goal-task-minutes text-center outline-none"
                      />
                      <em>分钟</em>
                    </label>
                    <div className="goal-task-priority-options" aria-label="任务优先级">
                      <span className="goal-task-control-label">优先级</span>
                      {(["high", "medium", "low"] as Priority[]).map((priority) => (
                        <button
                          key={priority}
                          type="button"
                          onClick={() => setEditPriority(priority)}
                          aria-pressed={editPriority === priority}
                          className={`goal-task-priority-option is-${priority}`}
                        >
                          {PRIORITY_LABEL[priority]}
                        </button>
                      ))}
                    </div>
                    <div className="goal-task-editor-actions">
                      <button type="button" onClick={() => void saveEdit(task.id)} className="goal-task-editor-save" aria-label="应用编辑">
                        应用
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} className="goal-task-editor-cancel" aria-label="取消编辑">
                        取消
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-[13px] font-medium leading-snug", task.done ? "text-gray-400 line-through" : "text-gray-700")}>{task.title}</p>
                    {task.description && <p className="goal-task-description mt-1 text-[11px] leading-relaxed">{task.description}</p>}
                    {task.executionGuide && (
                      <details className="goal-today-task-guide">
                        <summary>执行方法</summary>
                        {task.executionGuide.why_now && <p><strong>为什么现在做</strong>{task.executionGuide.why_now}</p>}
                        {(task.executionGuide.steps?.length ?? 0) > 0 && <ol>{task.executionGuide.steps?.map((step) => <li key={step}>{step}</li>)}</ol>}
                        {task.executionGuide.deliverable && <p><strong>产出</strong>{task.executionGuide.deliverable}</p>}
                        {(task.executionGuide.done_criteria?.length ?? 0) > 0 && <ul>{task.executionGuide.done_criteria?.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>}
                      </details>
                    )}
                    <span className="goal-task-meta mt-1.5 flex w-fit items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-gray-400">
                      <span className={cn("h-1.5 w-1.5 rounded-full", PRIORITY_DOT[task.priority ?? "medium"])} />
                      <Clock size={10} />{task.estimatedMinutes} 分钟
                    </span>
                  </div>
                  <div className="goal-task-actions flex shrink-0 items-center gap-0.5">
                    {task.done && (
                      <button
                        type="button"
                        onClick={() => onVerify(task)}
                        className="mr-1 rounded-lg px-2 py-0.5 text-xs text-white transition"
                        style={{ backgroundColor: "var(--accent)" }}
                      >
                        验收
                      </button>
                    )}
                    <button type="button" onClick={() => beginEdit(task)} className="rounded-md p-1.5 text-gray-400 transition hover:bg-gray-100" aria-label={`编辑任务“${task.title}”`}>
                      <Pencil size={12} />
                    </button>
                    <button type="button" onClick={() => void deleteTask(task.id)} className="rounded-md p-1.5 text-gray-400 transition hover:bg-red-50 hover:text-red-500" aria-label={`删除任务“${task.title}”`}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <>
          <MiniCalendar tasksByDate={tasksByDate} selectedDate={selectedDate} onSelect={onSelectDate} />
          <DayTaskList tasks={tasks} selectedDate={selectedDate} goalId={goal.id} goalTitle={goal.title} focusTaskId={focusTaskId} />
        </>
      )}
    </div>
  );
}

interface PlanTask {
  id: string;
  title: string;
  estimated_mins: number;
  status: string;
  mastery_level: string;
  scheduled_date: string;
  objective: string;
  execution_guide: PlanExecutionGuide;
}

interface MacroPlan {
  id: string;
  version: number;
  created_at: string;
  phases: { name: string; focus: string; days: number; start_date?: string; end_date?: string; total: number; done: number; tasks: PlanTask[] }[];
  total_tasks: number;
  completed_tasks: number;
  can_undo?: boolean;
}

function fmtDate(iso: string) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function buildDayMapFromPlan(phases: MacroPlan["phases"]): Map<string, number> {
  const dates = new Set<string>();
  for (const p of phases) for (const t of p.tasks) if (t.scheduled_date) dates.add(t.scheduled_date);
  const sorted = Array.from(dates).sort();
  const map = new Map<string, number>();
  sorted.forEach((d, i) => map.set(d, i + 1));
  return map;
}
function dayLabel(n: number) { return `day${String(n).padStart(2, "0")}`; }

function PlanOverview({ goalId, goalType, goalTitle, refreshKey, onPlanLoad }: { goalId: string; deadline: string; goalType: Goal["type"]; goalTitle: string; refreshKey?: number; onPlanLoad?: (totalDays: number) => void }) {
  const { status: authStatus } = useAuth();
  const [plan, setPlan] = useState<MacroPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [showPlanMode, setShowPlanMode] = useState(false);
  const [draft, setDraft] = useState<MacroPlanDraft | null>(null);
  const [expandedPhases, setExpandedPhases] = useState<Set<number>>(new Set());
  const [taskOverrides, setTaskOverrides] = useState<Record<string, Partial<PlanTask>>>({});
  const [planError, setPlanError] = useState<string | null>(null);
  const fetchPlan = useCallback(async () => {
    setPlanError(null);
    try {
      const res = await api.get<{ plan: MacroPlan | null }>(`/api/v1/goals/${goalId}/plan`);
      setPlan(res.plan);
      setTaskOverrides({});
      if (res.plan) {
        const dates = new Set<string>();
        for (const p of res.plan.phases) for (const t of (p.tasks ?? [])) if (t.scheduled_date) dates.add(t.scheduled_date);
        onPlanLoad?.(dates.size);
      }
    } catch (error) {
      setPlan(null);
      setPlanError(planErrorMessage(error, "学习计划同步失败，请重试。"));
    } finally {
      setLoading(false);
    }
  }, [goalId, onPlanLoad]);

  useEffect(() => { fetchPlan(); }, [fetchPlan, refreshKey]);

  async function handleRegenerate(mode: KbMode = "no_kb", intentSupplement = "", pacingMode: PacingMode = "fixed") {
    if (authStatus !== "authenticated") {
      setPlanError("当前为本地目标，请登录后生成学习计划。");
      return;
    }
    setRegenerating(true);
    setPlanError(null);
    try {
      const nextDraft = await api.post<MacroPlanDraft>(`/api/v1/agent/macro-plan/${goalId}`, {
        kb_mode: mode,
        user_intent_supplement: intentSupplement,
        pacing_mode: pacingMode,
      });
      setShowPlanMode(false);
      setDraft(nextDraft);
    } catch (error) {
      setPlanError(planErrorMessage(error, "学习计划生成失败，请检查服务后重试。"));
    } finally {
      setRegenerating(false);
    }
  }

  async function handleConfirmDraft() {
    if (!draft) return;
    setRegenerating(true);
    setPlanError(null);
    try {
      await api.post(`/api/v1/agent/macro-plan/${goalId}/${draft.plan_id}/confirm`, {});
      setDraft(null);
      localStorage.setItem("tasksNeedRefresh", "1");
      await fetchPlan();
    } catch (error) {
      setPlanError(planErrorMessage(error, "计划写入失败，请重试。"));
    } finally {
      setRegenerating(false);
    }
  }

  async function handleCancelDraft() {
    if (!draft || regenerating) return;
    const planId = draft.plan_id;
    setDraft(null);
    try {
      await api.post(`/api/v1/agent/macro-plan/${goalId}/${planId}/cancel`, {});
    } catch {
      // The draft remains inactive even if the lifecycle audit update cannot be synced.
    }
  }

  async function handleUndoPlan() {
    if (!plan?.can_undo || regenerating) return;
    setRegenerating(true);
    setPlanError(null);
    try {
      await api.post(`/api/v1/agent/macro-plan/${goalId}/${plan.id}/undo`, {});
      localStorage.setItem("tasksNeedRefresh", "1");
      await fetchPlan();
    } catch (error) {
      setPlanError(planErrorMessage(error, "无法撤销这次计划替换。"));
    } finally {
      setRegenerating(false);
    }
  }

  function togglePhase(i: number) {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(i)) { next.delete(i); } else { next.add(i); }
      return next;
    });
  }

  if (loading) return <div className="py-3 text-xs text-gray-400 text-center">加载中…</div>;

  if (planError && !draft && !showPlanMode) {
    return (
      <>
        <DataSyncNotice
          title="学习计划同步失败"
          message={planError}
          retryLabel="重新加载"
          onRetry={() => void fetchPlan()}
        />
        <div className="goal-plan-error goal-execution-empty-content" role="status">
          <span className="goal-execution-empty-icon" aria-hidden="true"><BookOpen size={20} /></span>
          <strong>学习计划暂未显示</strong>
          <p>目标和任务仍可正常使用</p>
        </div>
      </>
    );
  }

  if (!plan) {
    return (
      <>
        <div className="goal-plan-empty text-center py-4">
          <span className="goal-plan-empty-icon"><BookOpen size={18} /></span>
          <strong>还没有学习计划</strong>
          <p className="text-xs text-gray-400 mb-2">先选择参考资料如何参与，再生成阶段安排</p>
          <button
            onClick={() => setShowPlanMode(true)}
            disabled={regenerating}
            className="text-xs px-3 py-1.5 rounded-lg text-white transition disabled:opacity-50 flex items-center gap-1 mx-auto"
            style={{ backgroundColor: "var(--accent)" }}
          >
            {regenerating ? <><Loader2 size={10} className="animate-spin" /> 生成中…</> : "设置资料并生成计划"}
          </button>
        </div>
        <PlanModeSelector open={showPlanMode} busy={regenerating} error={planError ?? undefined} guestMode={authStatus === "unauthenticated"} hasKb={false} goalId={goalId} goalType={goalType} goalTitle={goalTitle} onClose={() => setShowPlanMode(false)} onConfirm={(mode, intent, pacing) => void handleRegenerate(mode, intent, pacing)} />
        {draft && <PlanDraftPreview draft={draft} goalTitle={goalTitle} busy={regenerating} error={planError ?? undefined} onCancel={() => void handleCancelDraft()} onConfirm={() => void handleConfirmDraft()} />}
      </>
    );
  }

  const allPlanTasks = plan.phases.flatMap((p) => p.tasks ?? []);
  const masteredCount = allPlanTasks.filter((t) => ["L3", "L4"].includes(taskOverrides[t.id]?.mastery_level ?? t.mastery_level)).length;
  const pct = plan.total_tasks > 0 ? Math.round(masteredCount / plan.total_tasks * 100) : 0;
  const dayMap = buildDayMapFromPlan(plan.phases);
  const totalDays = dayMap.size;
  const firstDate = plan.phases[0]?.start_date;
  const lastDate = plan.phases[plan.phases.length - 1]?.end_date;
  return (
    <>
    <div className="goal-plan-overview space-y-3">
      {/* 整体进度 */}
      <div className="goal-plan-summary flex items-center justify-between text-xs">
        <span className="text-gray-500">总体进度 <span className="font-semibold text-gray-800">{pct}%</span></span>
        <span className="text-gray-400">{masteredCount}/{plan.total_tasks} 已掌握</span>
      </div>
      <div className="plan-progress-track w-full bg-gray-100 rounded-full h-1.5">
        <div className="goal-plan-progress-fill h-1.5 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      {totalDays > 0 && firstDate && lastDate && (
        <p className="text-xs text-gray-400">
          预计 {totalDays} 天（{fmtDate(firstDate)} - {fmtDate(lastDate)}）
        </p>
      )}

      {/* 阶段列表 */}
      <div className="goal-plan-phase-list space-y-1.5 mt-1">
        {plan.phases.map((phase, i) => {
          const tasks = phase.tasks ?? [];
          const phaseMastered = tasks.filter((t) => ["L3", "L4"].includes(taskOverrides[t.id]?.mastery_level ?? t.mastery_level)).length;
          const phasePct = phase.total > 0 ? Math.round(phaseMastered / phase.total * 100) : 0;
          const isComplete = phase.total > 0 && phaseMastered === phase.total;
          const isExpanded = expandedPhases.has(i);
          const startDay = phase.start_date ? dayMap.get(phase.start_date) : undefined;
          const endDay = phase.end_date ? dayMap.get(phase.end_date) : undefined;
          const phaseRange = startDay != null && endDay != null
            ? (startDay === endDay ? dayLabel(startDay) : `${dayLabel(startDay)}-${dayLabel(endDay)}`)
            : null;
          const phaseRangeTitle = phase.start_date && phase.end_date
            ? `${fmtDate(phase.start_date)} - ${fmtDate(phase.end_date)}`
            : "";
          return (
            <div key={i} className={`goal-plan-phase tone-${i % 3} rounded-xl border border-gray-100 overflow-hidden`}>
              {/* 阶段头 */}
              <button
                onClick={() => togglePhase(i)}
                className="goal-plan-phase-heading w-full flex items-center gap-2 px-2.5 py-2 bg-gray-50 hover:bg-gray-100 transition text-left"
              >
                {isExpanded ? <ChevronDown size={12} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={12} className="text-gray-400 flex-shrink-0" />}
                <span
                  className={cn("plan-phase-title flex-1 truncate text-xs font-medium", isComplete ? "is-complete" : "text-gray-700")}
                  style={isComplete ? { color: "var(--accent)" } : {}}
                >
                  {isComplete ? "✓ " : ""}{phase.name}
                </span>
                {phaseRange && (
                  <span
                    className="text-xs font-mono text-gray-400 flex-shrink-0 cursor-default"
                    title={phaseRangeTitle}
                  >
                    {phaseRange}
                  </span>
                )}
                <span className="text-xs text-gray-400 flex-shrink-0">{phaseMastered}/{phase.total}</span>
              </button>

              {/* 进度条 */}
              <div className="plan-phase-progress-track h-1 bg-gray-200">
                <div className="goal-plan-phase-fill h-1 transition-all" style={{ width: `${phasePct}%` }} />
              </div>

              {/* 阶段焦点 + 任务列表 */}
              {isExpanded && (
                <div className="bg-white">
                  {phase.focus && (
                    <p className="text-xs text-gray-400 px-3 pt-2 pb-1 leading-snug">{phase.focus}</p>
                  )}
                  {tasks.length === 0 && (
                    <p className="text-xs text-gray-400 px-3 py-3 text-center">暂无任务数据</p>
                  )}
                  {tasks.map((task, ti) => {
                    const override = taskOverrides[task.id] ?? {};
                    const status = override.status ?? task.status;
                    const mastery = override.mastery_level ?? task.mastery_level;
                    const isDone = status === "completed" || status === "done";
                    const isMastered = ["L3", "L4"].includes(mastery);
                    const dn = task.scheduled_date ? dayMap.get(task.scheduled_date) : undefined;
                    return (
                      <article key={task.id} className="goal-plan-task border-t border-gray-50 transition group">
                        <div className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50">
                        {/* 任务序号仅用于定位，不承担完成或掌握状态 */}
                        <span
                          title={isDone ? "任务已完成" : "任务序号"}
                          className="plan-task-number flex h-5 w-5 flex-shrink-0 cursor-default items-center justify-center rounded border border-gray-200 text-[10px] font-semibold text-gray-400"
                        >
                          {ti + 1}
                        </span>

                        {dn != null && !isMastered && (
                          <span
                            className="text-xs font-mono text-gray-400 flex-shrink-0 w-10 cursor-default"
                            title={task.scheduled_date ? fmtDate(task.scheduled_date) : ""}
                          >
                            {dayLabel(dn)}
                          </span>
                        )}

                        {/* 任务标题 */}
                        <span className={cn("flex-1 text-xs leading-snug truncate", isMastered ? "line-through text-gray-400" : isDone ? "text-gray-400" : "text-gray-700")}>
                          {task.title}
                        </span>

                        {/* 时长 */}
                        <span className="flex items-center gap-0.5 text-xs text-gray-400 flex-shrink-0">
                          <Clock size={9} />{task.estimated_mins}min
                        </span>

                        {/* 掌握度徽章（只读，来自打卡），unknown/L1 不显示 */}
                        {["L2", "L3", "L4"].includes(mastery) && (
                          <span
                            className="flex-shrink-0 text-[11px] px-2 py-0.5 rounded-md border"
                            style={["L3", "L4"].includes(mastery) ? {
                              color: "var(--accent)",
                              borderColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
                              backgroundColor: "var(--accent-light)",
                            } : {
                              color: "#6b7280",
                              borderColor: "#e5e7eb",
                              backgroundColor: "#f9fafb",
                            }}
                          >
                            {["L3", "L4"].includes(mastery) ? "已掌握" : "了解"}
                          </span>
                        )}
                        </div>
                        {task.execution_guide && (task.execution_guide.steps?.length ?? 0) > 0 && (
                          <details className="goal-plan-task-guide">
                            <summary>查看执行方法与验收标准</summary>
                            <div>
                              <p><strong>为什么现在做</strong>{task.execution_guide.why_now}</p>
                              <p><strong>怎么执行</strong></p>
                              <ol>{task.execution_guide.steps?.map((step) => <li key={step}>{step}</li>)}</ol>
                              <p><strong>本次产出</strong>{task.execution_guide.deliverable}</p>
                              <p><strong>完成标准</strong></p>
                              <ul>{task.execution_guide.done_criteria?.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
                              {(task.execution_guide.source_refs?.length ?? 0) > 0 && <p><strong>依据资料</strong>{task.execution_guide.source_refs?.map((source) => source.locator).join("、")}</p>}
                            </div>
                          </details>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="goal-plan-overview-actions">
        {plan.can_undo && <button type="button" disabled={regenerating} onClick={() => void handleUndoPlan()}>撤销本次替换</button>}
        <button type="button" disabled={regenerating} onClick={() => setShowPlanMode(true)}>重新生成草案</button>
      </div>

    </div>
    <PlanModeSelector open={showPlanMode} busy={regenerating} error={planError ?? undefined} guestMode={authStatus === "unauthenticated"} hasKb={false} goalId={goalId} goalType={goalType} goalTitle={goalTitle} onClose={() => setShowPlanMode(false)} onConfirm={(mode, intent, pacing) => void handleRegenerate(mode, intent, pacing)} />
    {draft && <PlanDraftPreview draft={draft} goalTitle={goalTitle} busy={regenerating} error={planError ?? undefined} onCancel={() => void handleCancelDraft()} onConfirm={() => void handleConfirmDraft()} />}
    </>
  );
}

export default function GoalDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const { status: authStatus } = useAuth();
  const focusedTaskId = searchParams.get("taskId");
  const goalsHref = "/studio/work/goals";
  const [goal, setGoal] = useState<Goal | null>(null);
  const [loading, setLoading] = useState(true);
  const [goalLoadError, setGoalLoadError] = useState<string | null>(null);
  const [goalLoadAttempt, setGoalLoadAttempt] = useState(0);
  const announcedGoalIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (authStatus === "loading") return;
    let active = true;
    setLoading(true);
    setGoalLoadError(null);
    const loadGoal = async () => {
      if (authStatus === "unauthenticated") {
        ensureGuestDatasetSeeded();
        const localGoal = readLocalGoal(params.id) ?? GUEST_DEMO_GOALS[params.id] ?? null;
        if (active) {
          setGoal(localGoal);
          if (!localGoal) setGoalLoadError("本地目标不存在或已被清理。");
          setLoading(false);
        }
        return;
      }
      try {
        const remoteGoal = await api.get<Goal>(`/api/v1/goals/${params.id}`);
        if (active) setGoal(remoteGoal);
      } catch (error) {
        if (active) {
          setGoal(null);
          setGoalLoadError(planErrorMessage(error, "目标数据同步失败，请重试。"));
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadGoal();
    return () => { active = false; };
  }, [authStatus, goalLoadAttempt, params.id]);

  const { tasks, toggleTask } = useTasks();
  const goalTasks = goal ? tasks.filter((t) => t.goalId === goal.id) : [];
  const completedGoalTasks = goalTasks.filter((task) => task.done).length;
  const goalProgress = goalTasks.length ? Math.round((completedGoalTasks / goalTasks.length) * 100) : 0;

  const handleToggleTask = async (taskId: string) => {
    const target = goalTasks.find((task) => task.id === taskId);
    await toggleTask(taskId);
    setProgressRefreshKey(prev => prev + 1);
    if (target && !target.done) {
      signalPiloContext({
        kind: "completed",
        surface: "goals",
        objectId: goal?.id,
        objectTitle: goal?.title,
        message: `“${target.title}”完成了。先把这一步留住就好。`,
      });
    }
  };

  const [tab, setTab] = useState<"tasks" | "notes">("tasks");
  const [rightTab, setRightTab] = useState<"plan" | "execution">(searchParams.get("tab") === "plan" ? "plan" : "execution");
  const [selectedDate, setSelectedDate] = useState(TODAY);
  const [verifyTask, setVerifyTask] = useState<{ taskId: string; taskTitle: string } | null>(null);
  const [planRefreshKey, setPlanRefreshKey] = useState(0);
  const [progressRefreshKey, setProgressRefreshKey] = useState(0);
  const [createTaskRequestKey, setCreateTaskRequestKey] = useState(0);

  useEffect(() => {
    if (searchParams.get("tab") === "plan") setRightTab("plan");
  }, [searchParams]);

  useEffect(() => {
    if (!goal) return;
    signalPiloContext({
      kind: announcedGoalIdRef.current === goal.id ? "scope" : "object-opened",
      surface: "goals",
      objectId: goal.id,
      objectTitle: goal.title,
      progress: goalProgress,
      itemCount: goalTasks.length,
      completedCount: completedGoalTasks,
    });
    announcedGoalIdRef.current = goal.id;
  }, [completedGoalTasks, goal, goalProgress, goalTasks.length]);

  // 从其他页面（打卡、首页任务完成）回来时刷新计划数据
  useEffect(() => {
    const handleVisible = () => {
      if (document.visibilityState === "visible") {
        setPlanRefreshKey((k) => k + 1);
        setProgressRefreshKey((k) => k + 1);
      }
    };
    document.addEventListener("visibilitychange", handleVisible);
    return () => document.removeEventListener("visibilitychange", handleVisible);
  }, []);

  const [sidebarWidth, setSidebarWidth] = useState(() =>
    typeof window !== "undefined"
      ? Math.min(1080, Math.max(420, Math.round((window.innerWidth - 280) * 0.5)))
      : 560
  );
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [sidebarWidth]);

  const resizePanelsByKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSidebarWidth((current) => Math.min(1080, Math.max(420, current + (event.key === "ArrowRight" ? 20 : -20))));
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - dragStartX.current;
      setSidebarWidth(Math.min(1080, Math.max(420, dragStartWidth.current + delta)));
    };
    const onUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  }

  if (!goal) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3" role="status">
        {goalLoadError && (
          <DataSyncNotice
            title="目标数据同步失败"
            message={goalLoadError}
            retryLabel="重新加载"
            onRetry={() => setGoalLoadAttempt((attempt) => attempt + 1)}
          />
        )}
        <p className="text-sm">{goalLoadError ? "目标内容暂未显示" : "目标不存在或无权访问"}</p>
        {goalLoadError && <span className="text-xs text-gray-400">目标数据没有被清空，连接恢复后可重新加载。</span>}
        <Link href={goalsHref} className="text-accent text-sm hover:underline">返回目标列表</Link>
      </div>
    );
  }

  const daysLeft = computeDaysLeft(goal.deadline);

  return (
    <div className="goal-detail-page flex flex-col h-full overflow-hidden bg-gray-50">
      <header className="goal-detail-header bg-white border-b border-gray-100 flex-shrink-0">
        <div className="goal-detail-heading-row">
          <Link href={goalsHref} className="goal-detail-back" aria-label="返回我的目标">
            <ArrowLeft size={18} />
          </Link>
          <div className="goal-detail-heading-copy">
            <div className="goal-detail-title-line">
              <h1>{goal.title}</h1>
              <span className="goal-status">{STATUS_LABEL[goal.status] ?? goal.status}</span>
            </div>
            <p>
              <span>截止 {goal.deadline}</span>
              <span>每日计划投入 {goal.daily_hours >= 1 ? `${goal.daily_hours} 小时` : `${Math.round(goal.daily_hours * 60)} 分钟`}</span>
            </p>
          </div>
        </div>
      </header>

      <div className="goal-detail-body flex flex-1 overflow-hidden">
        {/* ── 左侧面板 ── */}
        <aside
          className="goal-detail-left flex flex-shrink-0 flex-col overflow-hidden bg-white border-r border-gray-100"
          style={{ width: sidebarWidth }}
        >
              {/* 顶层只区分任务与笔记；今日/日历在任务组件内部切换 */}
              <div className="goal-primary-tabs flex items-center border-b border-gray-100 flex-shrink-0">
                {(["tasks", "notes"] as const).map((t) => (
                  <button key={t} onClick={() => setTab(t)}
                    aria-pressed={tab === t}
                    className={cn(`goal-primary-tab goal-primary-tab-${t}`, "flex-1 py-3 text-sm font-semibold transition flex items-center justify-center gap-1.5",
                      tab === t ? "border-b-2 text-gray-900" : "text-gray-400 hover:text-gray-600"
                    )}
                    style={tab === t ? { borderColor: "var(--accent)" } : {}}>
                    {t === "tasks"
                      ? <><CheckCircle2 size={15} aria-hidden="true" />任务</>
                      : <><FileText size={15} aria-hidden="true" />相关笔记</>
                    }
                  </button>
                ))}
              </div>

              {/* Tab 内容 */}
              <div className="goal-detail-scroll flex-1 overflow-y-auto">
                {tab === "tasks" && (<>
                    <GoalTasksWorkspace
                      goal={goal}
                      tasks={goalTasks}
                      selectedDate={selectedDate}
                      onSelectDate={setSelectedDate}
                      onToggleTask={handleToggleTask}
                      onVerify={(task) => setVerifyTask({ taskId: task.id, taskTitle: task.title })}
                      focusTaskId={focusedTaskId}
                      createTaskRequestKey={createTaskRequestKey}
                    />
                    <div className="goal-detail-debt-list"><DebtCard goalId={goal.id} /></div>
                  </>)}

                {tab === "notes" && <GoalNotesPanel goalId={goal.id} />}
              </div>

        </aside>

        {/* ── 拖拽分割线 ── */}
        <div
          onMouseDown={onDragStart}
          onKeyDown={resizePanelsByKeyboard}
          className="goal-detail-resizer flex-shrink-0 cursor-col-resize bg-gray-100 transition-colors"
          style={{ touchAction: "none" }}
          role="separator"
          aria-label="调整左右面板宽度"
          aria-orientation="vertical"
          aria-valuemin={420}
          aria-valuemax={1080}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
        />

        {/* ── 右侧执行节奏与学习计划 ── */}
        <div className="goal-detail-right flex flex-1 flex-col overflow-hidden">
          <div className="goal-right-tabs flex flex-shrink-0 items-center gap-0 border-b border-gray-100 bg-white px-4 py-0">
                {(["execution", "plan"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setRightTab(t)}
                    aria-pressed={rightTab === t}
                    className={cn(
                      `goal-right-tab goal-right-tab-${t}`,
                      "flex items-center gap-1.5 px-4 py-3 text-sm font-semibold border-b-2 transition",
                      rightTab === t ? "text-gray-900" : "border-transparent text-gray-400 hover:text-gray-600"
                    )}
                    style={rightTab === t ? { borderColor: "var(--accent)" } : {}}
                  >
                    {t === "execution"
                      ? <><BarChart3 size={15} aria-hidden="true" />执行节奏</>
                      : <><BookOpen size={15} aria-hidden="true" />学习计划</>
                    }
                  </button>
            ))}
          </div>
          {rightTab === "plan" && (
                <div className="goal-plan-shell flex-1 flex flex-col overflow-hidden">
                  <div className="flex-1 overflow-y-auto px-5 py-4">
                    <PlanOverview goalId={goal.id} goalType={goal.type} goalTitle={goal.title} deadline={goal.deadline} refreshKey={planRefreshKey} />
                  </div>
                </div>
          )}
              {rightTab === "execution" && (
                <GoalExecutionPanel
                  goal={goal}
                  tasks={goalTasks}
                  daysLeft={daysLeft}
                  progressRefreshKey={progressRefreshKey}
                  useLocalProgress={authStatus === "unauthenticated"}
                  onSelectDate={(date) => {
                    setTab("tasks");
                    setSelectedDate(date);
                  }}
                  onCreateTask={() => {
                    setTab("tasks");
                    setSelectedDate(TODAY);
                    setCreateTaskRequestKey((key) => key + 1);
                  }}
                />
              )}
        </div>
      </div>

      {verifyTask && (
        <VerificationDialog
          goalId={goal.id}
          taskId={verifyTask.taskId}
          taskTitle={verifyTask.taskTitle}
          onClose={() => { setVerifyTask(null); setPlanRefreshKey((k) => k + 1); setProgressRefreshKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}
