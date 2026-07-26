"use client";

import { useState, useRef, useEffect, useCallback } from "react";


import Link from "next/link";
import {
  ArrowLeft, CheckCircle2, Circle, Clock,
  Bot, Plus, Trash2, Pencil, FileText,
  Check, X, Search, ChevronLeft, ChevronRight, ChevronDown, ChevronUp,
  Loader2, BookOpen, Calendar, BarChart3,
} from "lucide-react";
import { useTasks, type Task, type Priority } from "@/lib/tasks-context";
import { cn } from "@/lib/utils";
import { ChatWindow } from "@/components/agent/ChatWindow";
import { VerificationDialog } from "@/components/agent/VerificationDialog";
import { ProgressOverview } from "@/components/goal/ProgressOverview";
import { DebtCard } from "@/components/agent/DebtCard";
import { api } from "@/lib/api";
import type { Goal } from "@/lib/stores/goalStore";
import TaskNoteDrawer from "@/components/notes/TaskNoteDrawer";
import GoalNotesPanel from "@/components/notes/GoalNotesPanel";

const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })();
const MONTH_NAMES = ["一月","二月","三月","四月","五月","六月","七月","八月","九月","十月","十一月","十二月"];
const DAY_NAMES_SHORT = ["一","二","三","四","五","六","日"];

const STATUS_LABEL: Record<string, string> = {
  active: "进行中", completed: "已完成", paused: "暂停", abandoned: "已放弃",
};

function computeDaysLeft(deadline: string) {
  const diff = new Date(deadline).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
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
    <div>
      <div className="flex items-center justify-between mb-3">
        <button onClick={prevMonth} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500 transition">
          <ChevronLeft size={14} />
        </button>
        <span className="text-xs font-semibold text-gray-700">{viewYear}年 {MONTH_NAMES[viewMonth]}</span>
        <button onClick={nextMonth} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500 transition">
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="grid grid-cols-7 mb-1">
        {DAY_NAMES_SHORT.map((d) => (
          <div key={d} className="text-center text-xs text-gray-300 py-0.5">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
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
                "relative flex flex-col items-center justify-center h-8 rounded-lg text-xs transition",
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

      <div className="flex items-center gap-3 mt-3 pt-2 border-t border-gray-50 text-xs text-gray-400">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: "var(--accent)" }} /> 已完成
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> 待完成
        </span>
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
  tasks, selectedDate, goalId, goalTitle,
}: {
  tasks: Task[]; selectedDate: string; goalId: string; goalTitle: string;
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

      <div className="space-y-1 max-h-40 overflow-y-auto">
        {dayTasks.map((task) => (
          <div key={task.id} className="group flex items-start gap-2 px-2 py-1.5 rounded-xl hover:bg-gray-50 transition">
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
                  <p className={cn("text-xs leading-snug", task.done ? "line-through text-gray-400" : "text-gray-700")}>{task.title}</p>
                  <span className="text-xs text-gray-400 flex items-center gap-0.5 mt-0.5">
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
}: {
  goal: Goal;
  tasks: Task[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onToggleTask: (taskId: string) => void;
  onVerify: (task: Task) => void;
}) {
  const [view, setView] = useState<"today" | "calendar">("today");
  const [search, setSearch] = useState("");
  const todayTasks = tasks.filter((task) => task.date === TODAY);
  const doneTasks = todayTasks.filter((task) => task.done).length;
  const filteredToday = todayTasks.filter((task) =>
    task.title.toLowerCase().includes(search.trim().toLowerCase())
  );
  const tasksByDate = tasks.reduce<Record<string, Task[]>>((acc, task) => {
    if (!acc[task.date]) acc[task.date] = [];
    acc[task.date].push(task);
    return acc;
  }, {});

  return (
    <div className="px-4 py-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div
          className="inline-flex rounded-xl border border-gray-100 bg-gray-50 p-1"
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
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition",
                  active ? "bg-white shadow-sm" : "text-gray-400 hover:text-gray-600"
                )}
                style={active ? { color: "var(--accent)" } : {}}
              >
                <Icon size={13} />
                {item === "today" ? "今日任务" : "历史任务"}
              </button>
            );
          })}
        </div>
        {view === "calendar" && selectedDate !== TODAY && (
          <button
            type="button"
            onClick={() => onSelectDate(TODAY)}
            className="text-xs text-gray-400 transition hover:text-gray-600"
          >
            回到今天
          </button>
        )}
      </div>

      {view === "today" ? (
        <div className="space-y-1">
          {goal.kb_id && (
            <div className="mb-3 flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
              <span className="text-xs text-gray-500">已关联知识库</span>
              <Link href="/dashboard/knowledge" className="text-xs font-medium underline transition" style={{ color: "var(--accent)" }}>
                上传文件 →
              </Link>
            </div>
          )}
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-gray-400">{doneTasks}/{todayTasks.length} 已完成</span>
            <div className="relative">
              <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-300" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索任务…"
                aria-label="搜索今日任务"
                className="w-28 rounded-lg border border-gray-100 bg-gray-50 py-1 pl-6 pr-2 text-xs outline-none"
              />
            </div>
          </div>

          {filteredToday.length === 0 && (
            <p className="py-4 text-center text-xs text-gray-400">
              {search.trim() ? "没有匹配的任务" : "暂无今日任务"}
            </p>
          )}
          {filteredToday.map((task) => (
            <div key={task.id} className="group flex items-center gap-2 rounded-xl p-2 transition hover:bg-gray-50">
              <button type="button" onClick={() => onToggleTask(task.id)} className="mt-0.5 flex-shrink-0" aria-label={task.done ? "标记为未完成" : "标记为已完成"}>
                {task.done
                  ? <CheckCircle2 size={15} style={{ color: "var(--accent)" }} />
                  : <Circle size={15} className="flex-shrink-0 text-gray-300 transition group-hover:text-gray-400" />}
              </button>
              <div className="min-w-0 flex-1">
                <p className={cn("text-xs leading-snug", task.done ? "text-gray-400 line-through" : "text-gray-700")}>{task.title}</p>
                {task.description && <p className="mt-0.5 text-xs leading-snug text-gray-400">{task.description}</p>}
                <span className="mt-0.5 flex items-center gap-1 text-xs text-gray-400"><Clock size={10} />{task.estimatedMinutes} 分钟</span>
              </div>
              {task.done && (
                <button
                  type="button"
                  onClick={() => onVerify(task)}
                  className="shrink-0 rounded-lg px-2 py-0.5 text-xs text-white transition"
                  style={{ backgroundColor: "var(--accent)" }}
                >
                  验收
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <>
          <MiniCalendar tasksByDate={tasksByDate} selectedDate={selectedDate} onSelect={onSelectDate} />
          <DayTaskList tasks={tasks} selectedDate={selectedDate} goalId={goal.id} goalTitle={goal.title} />
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
}

interface MacroPlan {
  id: string;
  version: number;
  created_at: string;
  phases: { name: string; focus: string; days: number; start_date?: string; end_date?: string; total: number; done: number; tasks: PlanTask[] }[];
  total_tasks: number;
  completed_tasks: number;
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

function PlanOverview({ goalId, deadline, refreshKey, hideRegenerate, dailyHours, onPlanLoad }: { goalId: string; deadline: string; refreshKey?: number; hideRegenerate?: boolean; dailyHours?: number; onPlanLoad?: (totalDays: number) => void }) {
  const { refresh: refreshTasksContext } = useTasks();
  const [plan, setPlan] = useState<MacroPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [expandedPhases, setExpandedPhases] = useState<Set<number>>(new Set());
  const [taskOverrides, setTaskOverrides] = useState<Record<string, Partial<PlanTask>>>({});
  const [masteryHint, setMasteryHint] = useState<string | null>(null);

  const fetchPlan = useCallback(async () => {
    try {
      const res = await api.get<{ plan: MacroPlan | null }>(`/api/v1/goals/${goalId}/plan`);
      setPlan(res.plan);
      setTaskOverrides({});
      setMasteryHint(null);
      if (res.plan) {
        const dates = new Set<string>();
        for (const p of res.plan.phases) for (const t of (p.tasks ?? [])) if (t.scheduled_date) dates.add(t.scheduled_date);
        onPlanLoad?.(dates.size);
      }
    } catch {
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }, [goalId, onPlanLoad]);

  useEffect(() => { fetchPlan(); }, [fetchPlan, refreshKey]);

  async function handleRegenerate() {
    setRegenerating(true);
    try {
      await api.post(`/api/v1/agent/macro-plan/${goalId}`, {});
      await fetchPlan();
    } catch {
      // ignore
    } finally {
      setRegenerating(false);
    }
  }

  async function toggleTaskDone(taskId: string, currentDone: boolean) {
    setTaskOverrides((prev) => ({ ...prev, [taskId]: { ...prev[taskId], status: currentDone ? "pending" : "completed" } }));
    try {
      await api.patch(`/api/v1/tasks/${taskId}`, { done: !currentDone });
      refreshTasksContext();
    } catch {
      setTaskOverrides((prev) => { const n = { ...prev }; delete n[taskId]; return n; });
    }
  }

  async function toggleMastery(taskId: string, currentLevel: string) {
    const mastering = !["L3", "L4"].includes(currentLevel);
    const nextMastery = mastering ? "L3" : "L1";
    setTaskOverrides((prev) => ({
      ...prev,
      [taskId]: { ...prev[taskId], mastery_level: nextMastery, ...(mastering ? { status: "completed" } : {}) },
    }));
    try {
      await api.patch(`/api/v1/tasks/${taskId}`, { mastery_level: nextMastery, ...(mastering ? { done: true } : {}) });
      if (mastering) refreshTasksContext();
      if (mastering && plan && dailyHours) {
        const allTasks = plan.phases.flatMap((p) => p.tasks ?? []);
        const thisTask = allTasks.find((t) => t.id === taskId);
        const freedMins = thisTask?.estimated_mins ?? 0;
        const newMasteredMins = allTasks
          .filter((t) => t.id === taskId || ["L3", "L4"].includes(taskOverrides[t.id]?.mastery_level ?? t.mastery_level))
          .reduce((s, t) => s + t.estimated_mins, 0);
        const savedDays = Math.floor(newMasteredMins / (dailyHours * 60));
        if (savedDays > 0) {
          setMasteryHint(`已掌握（节省 ${freedMins} 分钟），可考虑重新规划时间，预计可提前约 ${savedDays} 天完成`);
        } else {
          setMasteryHint(`已标记为已掌握，节省约 ${freedMins} 分钟`);
        }
      } else if (!mastering) {
        setMasteryHint(null);
      }
    } catch {
      setTaskOverrides((prev) => { const n = { ...prev }; delete n[taskId]; return n; });
    }
  }

  function togglePhase(i: number) {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  if (loading) return <div className="py-3 text-xs text-gray-400 text-center">加载中…</div>;

  if (!plan) {
    return (
      <div className="text-center py-4">
        <p className="text-xs text-gray-400 mb-2">暂无AI生成计划</p>
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="text-xs px-3 py-1.5 rounded-lg text-white transition disabled:opacity-50 flex items-center gap-1 mx-auto"
          style={{ backgroundColor: "var(--accent)" }}
        >
          {regenerating ? <><Loader2 size={10} className="animate-spin" /> 生成中…</> : "AI 生成计划"}
        </button>
      </div>
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
    <div className="space-y-3">
      {/* 整体进度 */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-500">总体进度 <span className="font-semibold text-gray-800">{pct}%</span></span>
        <span className="text-gray-400">{masteredCount}/{plan.total_tasks} 已掌握</span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-1.5">
        <div className="h-1.5 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: "var(--accent)" }} />
      </div>
      {totalDays > 0 && firstDate && lastDate && (
        <p className="text-xs text-gray-400">
          预计 {totalDays} 天（{fmtDate(firstDate)} - {fmtDate(lastDate)}）
        </p>
      )}
      {masteryHint && (
        <div className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
          {masteryHint}
        </div>
      )}

      {/* 阶段列表 */}
      <div className="space-y-1.5 mt-1">
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
            <div key={i} className="rounded-xl border border-gray-100 overflow-hidden">
              {/* 阶段头 */}
              <button
                onClick={() => togglePhase(i)}
                className="w-full flex items-center gap-2 px-2.5 py-2 bg-gray-50 hover:bg-gray-100 transition text-left"
              >
                {isExpanded ? <ChevronDown size={12} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={12} className="text-gray-400 flex-shrink-0" />}
                <span className={cn("text-xs font-medium flex-1 truncate", isComplete ? "text-green-600" : "text-gray-700")}>
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
              <div className="h-1 bg-gray-200">
                <div className="h-1 transition-all" style={{ width: `${phasePct}%`, backgroundColor: isComplete ? "#22c55e" : "var(--accent)" }} />
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
                      <div key={task.id} className="flex items-center gap-2 px-3 py-2 border-t border-gray-50 hover:bg-gray-50 transition group">
                        {/* 任务序号方框 */}
                        <button
                          onClick={() => toggleTaskDone(task.id, isDone)}
                          className={cn(
                            "flex-shrink-0 w-5 h-5 rounded text-[10px] font-semibold flex items-center justify-center border transition",
                            isMastered
                              ? "bg-green-50 border-green-300 text-green-600"
                              : isDone
                              ? "text-white border-transparent"
                              : "border-gray-200 text-gray-400 hover:border-gray-400"
                          )}
                          style={isDone && !isMastered ? { backgroundColor: "var(--accent)" } : {}}
                        >
                          {ti + 1}
                        </button>

                        {dn != null && !isMastered && (
                          <span
                            className="text-xs font-mono text-gray-400 flex-shrink-0 w-10 cursor-default"
                            title={task.scheduled_date ? fmtDate(task.scheduled_date) : ""}
                          >
                            {dayLabel(dn)}
                          </span>
                        )}

                        {/* 任务标题 */}
                        <span className={cn("flex-1 text-xs leading-snug truncate", isMastered ? "line-through text-gray-400" : isDone ? "text-gray-500" : "text-gray-700")}>
                          {task.title}
                        </span>

                        {/* 时长 */}
                        <span className="flex items-center gap-0.5 text-xs text-gray-400 flex-shrink-0">
                          <Clock size={9} />{task.estimated_mins}min
                        </span>

                        {/* 已掌握标记 */}
                        <button
                          onClick={() => toggleMastery(task.id, mastery)}
                          className={cn(
                            "flex-shrink-0 text-xs px-1.5 py-0.5 rounded-md border transition",
                            isMastered
                              ? "bg-green-50 border-green-200 text-green-600"
                              : "border-gray-200 text-gray-400 hover:border-green-200 hover:text-green-500 opacity-0 group-hover:opacity-100"
                          )}
                        >
                          {isMastered ? "已掌握" : "掌握？"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!hideRegenerate && (
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="w-full text-xs py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition disabled:opacity-50 flex items-center justify-center gap-1"
        >
          {regenerating ? <><Loader2 size={10} className="animate-spin" /> 规划中…</> : "重新规划时间"}
        </button>
      )}
    </div>
  );
}

export default function GoalDetailPage({ params }: { params: { id: string } }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Goal>(`/api/v1/goals/${params.id}`)
      .then(setGoal)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [params.id]);

  const { tasks, toggleTask } = useTasks();
  const goalTasks = goal ? tasks.filter((t) => t.goalId === goal.id) : [];

  const handleToggleTask = async (taskId: string) => {
    await toggleTask(taskId);
    setProgressRefreshKey(prev => prev + 1);
  };

  const [tab, setTab] = useState<"tasks" | "notes">("tasks");
  const [rightTab, setRightTab] = useState<"plan" | "chat">("chat");
  const [selectedDate, setSelectedDate] = useState(TODAY);
  const [verifyTask, setVerifyTask] = useState<{ taskId: string; taskTitle: string } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [statsCollapsed, setStatsCollapsed] = useState(false);
  const [planRefreshKey, setPlanRefreshKey] = useState(0);
  const [progressRefreshKey, setProgressRefreshKey] = useState(0);
  const [planRegenerating, setPlanRegenerating] = useState(false);
  const [planTotalDays, setPlanTotalDays] = useState<number | null>(null);
  const [showRescheduleConfirm, setShowRescheduleConfirm] = useState(false);
  const [rescheduleResult, setRescheduleResult] = useState<{ estimatedDate: string; daysSaved: number } | null>(null);

  useEffect(() => {
    if (window.matchMedia("(max-width: 768px)").matches) setChatCollapsed(true);
  }, []);

  const [sidebarWidth, setSidebarWidth] = useState(() =>
    typeof window !== "undefined" ? Math.round(window.innerWidth * 0.35) : 420
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

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - dragStartX.current;
      setSidebarWidth(Math.min(700, Math.max(240, dragStartWidth.current + delta)));
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

  async function handlePlanRegenerate() {
    if (!goal) return;
    setShowRescheduleConfirm(false);
    setPlanRegenerating(true);
    try {
      const res = await api.post<{ estimated_completion_date: string; days_saved: number; rescheduled_count: number }>(
        `/api/v1/agent/reschedule/${goal.id}`, {}
      );
      setPlanRefreshKey((k) => k + 1);
      if (res.days_saved > 0) {
        setRescheduleResult({ estimatedDate: res.estimated_completion_date, daysSaved: res.days_saved });
      }
    } finally {
      setPlanRegenerating(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  }

  if (!goal) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
        <p className="text-sm">目标不存在或无权访问</p>
        <Link href="/dashboard/goals" className="text-blue-600 text-sm hover:underline">返回目标列表</Link>
      </div>
    );
  }

  const daysLeft = computeDaysLeft(goal.deadline);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-gray-50">
      {/* 顶部返回栏 */}
      <div className="flex items-center gap-3 px-6 py-3.5 bg-white border-b border-gray-100 flex-shrink-0">
        <Link href="/dashboard/goals" className="text-gray-400 hover:text-gray-600 transition p-1 -ml-1 rounded-lg hover:bg-gray-100">
          <ArrowLeft size={18} />
        </Link>
        <span className="text-sm text-gray-400">/</span>
        <Link href="/dashboard/goals" className="text-sm font-medium text-gray-500 hover:text-gray-800 transition">我的目标</Link>
        <span className="text-sm text-gray-400">/</span>
        <span className="text-sm font-semibold text-gray-900">{goal.title}</span>
        <span className="ml-auto text-xs font-medium px-2.5 py-1 rounded-full bg-blue-50 text-blue-600">
          {STATUS_LABEL[goal.status] ?? goal.status}
        </span>
      </div>

      {/* 目标标题居中显示 */}
      <div className="flex-shrink-0 bg-white border-b border-gray-100 py-3 text-center px-6">
        <p className="leading-snug">
          <span className="text-base font-bold text-gray-900">{goal.title}</span>
          <span className="text-xs text-gray-400 ml-1.5">（截止 {goal.deadline} · {planTotalDays != null ? `计划 ${planTotalDays} 天` : `剩余 ${daysLeft} 天`} · 每日 {goal.daily_hours}h）</span>
        </p>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── 左侧面板 ── */}
        <aside
          className={cn(
            "bg-white border-r border-gray-100 flex flex-col",
            sidebarCollapsed ? "overflow-hidden items-center flex-shrink-0" : chatCollapsed ? "flex-1 overflow-hidden" : "flex-shrink-0 overflow-hidden"
          )}
          style={sidebarCollapsed ? { width: 40 } : chatCollapsed ? {} : { width: sidebarWidth }}
        >
          {sidebarCollapsed ? (
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="mt-3 p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition"
              title="展开面板"
            >
              <ChevronRight size={16} />
            </button>
          ) : (
            <>
              {/* 数据指标 — 可折叠 */}
              <div className="flex-shrink-0 border-b border-gray-100">
                <div className="flex items-center">
                  <button
                    onClick={() => setStatsCollapsed((v) => !v)}
                    className="flex-1 flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition"
                  >
                    <div className="flex items-center gap-1.5" style={{ color: "var(--accent)" }}>
                      <div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ backgroundColor: "var(--accent)" }}>
                        <BarChart3 size={9} className="text-white" />
                      </div>
                      <span className="text-sm font-semibold">数据指标</span>
                    </div>
                    {statsCollapsed
                      ? <ChevronDown size={13} className="text-gray-400" />
                      : <ChevronUp size={13} className="text-gray-400" />}
                  </button>
                  <button
                    onClick={() => setSidebarCollapsed(true)}
                    className="p-1.5 mr-1 rounded-lg hover:bg-gray-100 text-gray-400 transition flex-shrink-0"
                    title="收起面板"
                  >
                    <ChevronLeft size={15} />
                  </button>
                </div>
                {!statsCollapsed && (
                  <div className="px-4 pb-3 space-y-3">
                    <ProgressOverview goalId={goal.id} refreshKey={progressRefreshKey} />
                    <DebtCard goalId={goal.id} />
                  </div>
                )}
              </div>

              {/* 顶层只区分任务与笔记；今日/日历在任务组件内部切换 */}
              <div className="flex items-center border-b border-gray-100 flex-shrink-0">
                {(["tasks", "notes"] as const).map((t) => (
                  <button key={t} onClick={() => setTab(t)}
                    className={cn("flex-1 py-3 text-sm font-semibold transition flex items-center justify-center gap-1.5",
                      tab === t ? "border-b-2 text-gray-900" : "text-gray-400 hover:text-gray-600"
                    )}
                    style={tab === t ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}>
                    {t === "tasks"
                      ? <><div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ backgroundColor: "var(--accent)" }}><CheckCircle2 size={9} className="text-white" /></div>任务</>
                      : <><div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ backgroundColor: "var(--accent)" }}><FileText size={9} className="text-white" /></div>相关笔记</>
                    }
                  </button>
                ))}
              </div>

              {/* Tab 内容 */}
              <div className="flex-1 overflow-y-auto">
                {tab === "tasks" && (
                  <GoalTasksWorkspace
                    goal={goal}
                    tasks={goalTasks}
                    selectedDate={selectedDate}
                    onSelectDate={setSelectedDate}
                    onToggleTask={handleToggleTask}
                    onVerify={(task) => setVerifyTask({ taskId: task.id, taskTitle: task.title })}
                  />
                )}

                {tab === "notes" && <GoalNotesPanel goalId={goal.id} />}
              </div>

            </>
          )}
        </aside>

        {/* ── 拖拽分割线 ── */}
        {!sidebarCollapsed && !chatCollapsed && (
          <div
            onMouseDown={onDragStart}
            className="w-1 flex-shrink-0 cursor-col-resize bg-gray-100 hover:bg-blue-300 transition-colors"
            style={{ touchAction: "none" }}
          />
        )}

        {/* ── 右侧 AI 对话 ── */}
        <div className={cn(
          "flex flex-col overflow-hidden",
          chatCollapsed ? "flex-none items-center bg-white border-l border-gray-100" : "flex-1"
        )} style={chatCollapsed ? { width: 40 } : {}}>
          <div className={cn(
            "bg-white border-b border-gray-100 flex items-center flex-shrink-0",
            chatCollapsed ? "flex-col py-3 px-0 gap-3 border-b-0" : "px-4 py-0 gap-0"
          )}>
            {chatCollapsed ? (
              <button
                onClick={() => setChatCollapsed(false)}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition"
                title="展开面板"
              >
                <ChevronLeft size={16} />
              </button>
            ) : (
              <>
                {(["chat", "plan"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setRightTab(t)}
                    className={cn(
                      "flex items-center gap-1.5 px-4 py-3 text-sm font-semibold border-b-2 transition",
                      rightTab === t ? "text-gray-900" : "border-transparent text-gray-400 hover:text-gray-600"
                    )}
                    style={rightTab === t ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}
                  >
                    {t === "chat"
                      ? <><div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ backgroundColor: "var(--accent)" }}><Bot size={9} className="text-white" /></div>AI 助教</>
                      : <><div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ backgroundColor: "var(--accent)" }}><BookOpen size={9} className="text-white" /></div>学习计划</>
                    }
                  </button>
                ))}
                <div className="flex-1" />
                <button
                  onClick={() => setChatCollapsed(true)}
                  className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition flex-shrink-0"
                  title="收起面板"
                >
                  <ChevronRight size={15} />
                </button>
              </>
            )}
          </div>
          {!chatCollapsed && (
            <>
              {rightTab === "plan" && (
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="flex-1 overflow-y-auto px-5 py-4">
                    <PlanOverview goalId={goal.id} deadline={goal.deadline} refreshKey={planRefreshKey} hideRegenerate dailyHours={goal.daily_hours} onPlanLoad={setPlanTotalDays} />
                  </div>
                  <div className="flex-shrink-0 px-5 py-3 border-t border-gray-100">
                    <button
                      onClick={() => setShowRescheduleConfirm(true)}
                      disabled={planRegenerating}
                      className="w-full text-xs py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition disabled:opacity-50 flex items-center justify-center gap-1"
                    >
                      {planRegenerating ? <><Loader2 size={10} className="animate-spin" /> 规划中…</> : "重新规划时间"}
                    </button>
                  </div>
                </div>
              )}
              {rightTab === "chat" && <ChatWindow goalId={goal.id} className="flex-1 min-h-0" />}
            </>
          )}
        </div>
      </div>

      {showRescheduleConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div role="dialog" aria-modal="true" aria-label="确认重新规划时间" className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">重新规划时间</h3>
            <p className="text-xs text-gray-500 leading-relaxed">将对所有未掌握的任务从今日开始重新安排时间，已掌握 / 已完成的任务不受影响。是否继续？</p>
            <div className="flex gap-2">
              <button onClick={() => setShowRescheduleConfirm(false)} className="flex-1 py-2 text-xs rounded-xl bg-gray-100 text-gray-500 hover:bg-gray-200 transition font-medium">取消</button>
              <button onClick={handlePlanRegenerate} disabled={planRegenerating} className="flex-[2] py-2 text-xs rounded-xl text-white font-medium transition disabled:opacity-50 flex items-center justify-center gap-1" style={{ backgroundColor: "var(--accent)" }}>
                {planRegenerating ? <><Loader2 size={10} className="animate-spin" />规划中…</> : "确认重新规划"}
              </button>
            </div>
          </div>
        </div>
      )}

      {rescheduleResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div role="dialog" aria-modal="true" aria-label="规划完成" className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">规划完成</h3>
            <p className="text-xs text-gray-500 leading-relaxed">
              预计 <span className="font-semibold text-gray-800">{rescheduleResult.estimatedDate}</span> 完成，提前了{" "}
              <span className="font-semibold" style={{ color: "var(--accent)" }}>{rescheduleResult.daysSaved} 天</span>
            </p>
            <button onClick={() => setRescheduleResult(null)} className="w-full py-2 text-xs rounded-xl text-white font-medium transition" style={{ backgroundColor: "var(--accent)" }}>好的</button>
          </div>
        </div>
      )}

      {verifyTask && (
        <VerificationDialog
          goalId={goal.id}
          taskId={verifyTask.taskId}
          taskTitle={verifyTask.taskTitle}
          onClose={() => setVerifyTask(null)}
        />
      )}
    </div>
  );
}
