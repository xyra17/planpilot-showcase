"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  CheckCircle2, Circle, Clock, ArrowRight,
  Sparkles, RotateCcw, TrendingUp, Brain, Zap, Target,
  Plus, Trash2, Pencil, Check, X, Search,
  Calendar, Wand2, LayoutList, BarChart3, CalendarCheck, Activity, ChevronDown,
  ClipboardList, Sprout,
} from "lucide-react";
import { api } from "@/lib/api";
import { useTasks, type Priority } from "@/lib/tasks-context";
import { useGoalStore } from "@/lib/stores/goalStore";
import { useAuthStore } from "@/lib/stores/authStore";
import { CheckinForm } from "@/components/agent/CheckinForm";
import { cn } from "@/lib/utils";
import { TodayInsight } from "@/components/learner/TodayInsight";

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

const _now = new Date();
const TODAY = localDate(_now);

type RawTask = { date: string; done: boolean; estimatedMinutes: number };

function buildMonthlyHours(tasks: RawTask[]): { label: string; hours: number }[] {
  const today = new Date();
  const year = today.getFullYear(), month = today.getMonth(), todayDate = today.getDate();
  return Array.from({ length: todayDate }, (_, i) => {
    const day = i + 1;
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const mins = tasks.filter((t) => t.date === dateStr && t.done).reduce((s, t) => s + t.estimatedMinutes, 0);
    return { label: `${month + 1}/${day}`, hours: +(mins / 60).toFixed(1) };
  });
}

function buildYearlyHours(tasks: RawTask[], year: number): { label: string; hours: number }[] {
  const today = new Date();
  const maxMonth = year === today.getFullYear() ? today.getMonth() : 11;
  return Array.from({ length: maxMonth + 1 }, (_, i) => {
    const month = i;
    const mins = tasks
      .filter((t) => { const td = new Date(t.date); return td.getFullYear() === year && td.getMonth() === month && t.done; })
      .reduce((s, t) => s + t.estimatedMinutes, 0);
    return { label: `${month + 1}月`, hours: +(mins / 60).toFixed(1) };
  });
}

function buildHeatmapData(tasks: RawTask[]): { date: string; minutes: number }[] {
  return Array.from({ length: 365 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (364 - i));
    const dateStr = localDate(d);
    const mins = tasks.filter((t) => t.date === dateStr && t.done).reduce((s, t) => s + t.estimatedMinutes, 0);
    return { date: dateStr, minutes: mins };
  });
}

// ── SVG 折线图 ──────────────────────────────────────────────
function StudyLineChart({ data }: { data: { label: string; hours: number; isToday?: boolean }[] }) {
  const W = 480, H = 162;
  const padL = 34, padR = 12, padT = 12, padB = 36;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const maxH = Math.max(...data.map((d) => d.hours), 1);

  const pts = data.map((d, i) => ({
    x: padL + (i / Math.max(data.length - 1, 1)) * chartW,
    y: padT + (1 - d.hours / maxH) * chartH,
    label: d.label,
  }));

  const linePath = pts.reduce((acc, p, i) => {
    if (i === 0) return `M${p.x},${p.y}`;
    const prev = pts[i - 1];
    const cx = (prev.x + p.x) / 2;
    return `${acc} C${cx},${prev.y} ${cx},${p.y} ${p.x},${p.y}`;
  }, "");

  const areaPath = `${linePath} L${pts[pts.length - 1].x},${padT + chartH} L${pts[0].x},${padT + chartH} Z`;
  const gridYs = [0, 0.5, 1].map((t) => ({ y: padT + t * chartH, label: +(maxH * (1 - t)).toFixed(1) }));
  const showEvery = Math.ceil(data.length / 7);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent,#2563eb)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--accent,#2563eb)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {gridYs.map(({ y, label }) => (
        <g key={y}>
          <line x1={padL} y1={y} x2={W - padR} y2={y} className="chart-grid" stroke="#f0f0f0" strokeWidth="1" />
          <text x={padL - 4} y={y + 4} textAnchor="end" fontSize="11" className="chart-lbl" fill="#9ca3af">{label}h</text>
        </g>
      ))}
      <path d={areaPath} fill="url(#areaGrad)" />
      <path d={linePath} fill="none" stroke="var(--accent,#2563eb)" strokeWidth="2" strokeLinecap="round" />
      {pts.map((p) => <circle key={p.label} cx={p.x} cy={p.y} r={3} fill="var(--accent,#2563eb)" />)}
      {pts.map((p, i) => {
        const show = i % showEvery === 0 || i === pts.length - 1;
        if (!show) return null;
        const today = data[i]?.isToday;
        return (
          <g key={p.label}>
            <text x={p.x} y={H - 20} textAnchor="middle" fontSize="11" fill={today ? "var(--accent,#2563eb)" : "#9ca3af"} fontWeight={today ? "600" : "normal"}>{p.label}</text>
            {today && <circle cx={p.x} cy={H - 6} r="2.5" fill="var(--accent,#2563eb)" />}
          </g>
        );
      })}
    </svg>
  );
}

// ── 月历热力图 ──────────────────────────────────────────────
const HEAT_COLORS = [
  "var(--heat-0,#f0f0f0)", "var(--heat-1,#bfdbfe)",
  "var(--heat-2,#60a5fa)", "var(--heat-3,#2563eb)", "var(--heat-4,#1e3a8a)",
];
const heatColor = (m: number) =>
  m === 0 ? HEAT_COLORS[0] : m < 30 ? HEAT_COLORS[1] : m < 60 ? HEAT_COLORS[2] : m < 120 ? HEAT_COLORS[3] : HEAT_COLORS[4];
const WEEK_ROW_LABELS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];

function StudyCalendar({ data }: { data: { date: string; minutes: number }[] }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const dataMap = useMemo(() => {
    const m: Record<string, number> = {};
    data.forEach(({ date, minutes }) => { m[date] = minutes; });
    return m;
  }, [data]);

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
  const isCurrentYear = year === now.getFullYear();

  const prevMonth = () => {
    if (month === 0) { setYear((y) => y - 1); setMonth(11); }
    else setMonth((m) => m - 1);
  };
  const nextMonth = () => {
    if (isCurrentMonth) return;
    if (month === 11) { setYear((y) => y + 1); setMonth(0); }
    else setMonth((m) => m + 1);
  };
  const prevYear = () => setYear((y) => y - 1);
  const nextYear = () => {
    if (isCurrentYear) return;
    const newYear = year + 1;
    setYear(newYear);
    if (newYear === now.getFullYear() && month > now.getMonth()) setMonth(now.getMonth());
  };

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // Monday-based offset: Mon=0 … Sun=6
  const firstDowMon = (new Date(year, month, 1).getDay() + 6) % 7;

  // 42 cells = 6 week-columns × 7 day-rows, addressed as cells[col*7 + row]
  const cells = Array.from({ length: 42 }, (_, i) => {
    const day = i - firstDowMon + 1;
    if (day < 1 || day > daysInMonth) return null;
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return { dateStr, minutes: dataMap[dateStr] ?? 0, isToday: dateStr === TODAY };
  });

  return (
    <div>
      <div className="dashboard-module-header mb-3 flex items-center gap-2">
          <div className="dashboard-module-icon w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
            <Activity size={14} style={{ color: "var(--accent)" }} />
          </div>
          <div className="dashboard-module-title text-sm font-semibold text-gray-900">学习热力图</div>
      </div>
      <div className="mx-auto w-full max-w-[620px]">
        <div className="mb-3 flex items-center justify-center gap-0.5">
          <button onClick={prevYear} className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-400 transition text-[11px] font-bold">«</button>
          <button onClick={prevMonth} className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 transition leading-none">‹</button>
          <span className="text-sm font-medium text-gray-400 mx-2">{year}年{month + 1}月</span>
          <button onClick={nextMonth} disabled={isCurrentMonth}
            className={cn("w-6 h-6 flex items-center justify-center rounded-md transition leading-none",
              isCurrentMonth ? "text-gray-200 cursor-not-allowed" : "hover:bg-gray-100 text-gray-500")}>›</button>
          <button onClick={nextYear} disabled={isCurrentYear}
            className={cn("w-6 h-6 flex items-center justify-center rounded-md transition text-[11px] font-bold",
              isCurrentYear ? "text-gray-200 cursor-not-allowed" : "hover:bg-gray-100 text-gray-400")}>»</button>
        </div>

      <div className="flex justify-center">
        {/* 行标签：星期X */}
        <div className="mr-8 flex flex-shrink-0 flex-col gap-[4px]">
          {WEEK_ROW_LABELS.map((d) => (
            <div key={d} style={{ width: 40, height: 14, lineHeight: "14px", fontSize: 11 }}
              className="text-gray-400 text-right leading-none">{d}</div>
          ))}
        </div>
        {/* 6 周列，flex-1 撑满宽度 */}
        <div className="flex w-full max-w-[470px] gap-3">
        {Array.from({ length: 6 }, (_, wi) => (
          <div key={wi} className="flex-1 flex flex-col gap-[4px]">
            {Array.from({ length: 7 }, (_, di) => {
              const cell = cells[wi * 7 + di];
              const mins = cell?.minutes ?? 0;
              return (
                <div key={di} className="flex items-center gap-[4px]"
                  title={cell ? `${cell.dateStr}  ${mins}分钟` : ""}>
                  <div className="flex-shrink-0 rounded-[3px]"
                    style={{
                      width: 28, height: 14,
                      backgroundColor: cell ? heatColor(mins) : "transparent",
                      outline: cell?.isToday ? "1.5px solid var(--accent)" : undefined,
                      outlineOffset: cell?.isToday ? 1 : undefined,
                    }} />
                  {cell && mins > 0 && (
                    <span className="text-[9px] text-gray-400 leading-none truncate">
                      {mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-center gap-1.5">
        <span className="text-xs text-gray-400">学习时长（少）</span>
        {HEAT_COLORS.map((c, i) => <div key={i} style={{ width: 12, height: 12, backgroundColor: c, borderRadius: 3 }} />)}
        <span className="text-xs text-gray-400">学习时长（多）</span>
      </div>
      </div>
    </div>
  );
}

// ── 今日任务面板 ─────────────────────────────────────────────
const PRIORITY_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };
const PRIORITY_DOT: Record<string, string> = { high: "bg-red-400", medium: "bg-yellow-400", low: "bg-gray-300" };
const PRIORITY_CLS: Record<string, { on: string; off: string }> = {
  high:   { on: "bg-red-500 text-white",    off: "text-red-500 hover:bg-red-50" },
  medium: { on: "bg-yellow-400 text-white", off: "text-yellow-600 hover:bg-yellow-50" },
  low:    { on: "bg-gray-400 text-white",   off: "text-gray-400 hover:bg-gray-100" },
};

function DashboardEmptyState({
  kind,
  title,
  description,
  href,
}: {
  kind: "checkin" | "goal";
  title: string;
  description: string;
  href: string;
}) {
  return (
    <div className={`dashboard-empty-state ${kind === "checkin" ? "is-checkin" : "is-goal"}`}>
      <div className="dashboard-empty-art" aria-hidden="true">
        {kind === "checkin" ? (
          <>
            <span className="dashboard-empty-paper"><ClipboardList size={49} strokeWidth={1.45} /></span>
            <span className="dashboard-empty-sprout"><Sprout size={34} strokeWidth={1.55} /></span>
          </>
        ) : (
          <span className="dashboard-empty-target"><Target size={68} strokeWidth={1.35} /></span>
        )}
      </div>
      <p className="dashboard-empty-title">{title}</p>
      <Link href={href} className="dashboard-empty-description">
        {description}
        <ArrowRight size={12} aria-hidden="true" />
      </Link>
    </div>
  );
}

function TodayTasksPanel() {
  const { tasks, isLoading, error, addTask, updateTask, deleteTask, toggleTask, refresh } = useTasks();
  const { goals, currentGoalId, fetchGoals } = useGoalStore();
  const todayTasks = tasks.filter((t) => t.date === TODAY);

  const [panelTab, setPanelTab] = useState<"tasks" | "checkin">("tasks");
  const [checkinKey, setCheckinKey] = useState(0);
  const [checkinRate, setCheckinRate] = useState(0);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editMinutes, setEditMinutes] = useState(30);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newGoalId, setNewGoalId] = useState("");
  const [newMinutes, setNewMinutes] = useState(30);
  const [newPriority, setNewPriority] = useState<Priority>("medium");
  const [editPriority, setEditPriority] = useState<Priority>("medium");
  const addRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (showAdd) addRef.current?.focus(); }, [showAdd]);

  const filtered = todayTasks.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()));
  const done = todayTasks.filter((t) => t.done).length;

  function saveEdit(id: string) {
    if (editTitle.trim()) updateTask(id, { title: editTitle.trim(), estimatedMinutes: editMinutes, priority: editPriority });
    setEditingId(null);
  }

  function submitAdd() {
    if (!newTitle.trim()) return;
    const goal = goals.find((g) => g.id === newGoalId);
    addTask({ title: newTitle.trim(), goalId: newGoalId, goalTitle: goal?.title ?? "", done: false, estimatedMinutes: newMinutes, date: TODAY, priority: newPriority });
    setNewTitle(""); setNewMinutes(30); setNewPriority("medium"); setShowAdd(false);
  }

  useEffect(() => { fetchGoals(); }, [fetchGoals]);
  const activeGoal = goals.find((g) => g.id === currentGoalId && g.status === "active")
    ?? goals.find((g) => g.status === "active") ?? null;
  const activeGoalTodayTasks = useMemo(
    () => activeGoal
      ? tasks.filter((task) => task.date === TODAY && task.goalId === activeGoal.id)
      : [],
    [activeGoal, tasks]
  );

  useEffect(() => {
    if (!newGoalId && goals.length > 0) setNewGoalId(goals[0].id);
  }, [goals, newGoalId]);

  return (
    <div className="journal-receipt bg-gray-50 rounded-2xl shadow-sm border border-gray-100 p-5 flex flex-col h-[360px]">
      {/* 面板头 */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="dashboard-module-icon w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
            {panelTab === "tasks"
              ? <CheckCircle2 size={14} style={{ color: "var(--accent)" }} />
              : <CalendarCheck size={14} style={{ color: "var(--accent)" }} />}
          </div>
          <div className="flex items-center gap-0">
            <button onClick={() => setPanelTab("tasks")}
              className={cn("dashboard-module-title text-sm font-semibold px-0.5 pb-0.5 border-b-2 transition",
                panelTab === "tasks" ? "" : "border-transparent text-gray-400 hover:text-gray-700")}
              style={panelTab === "tasks" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}>
              今日任务
            </button>
            <span className="text-gray-200 mx-2 text-sm select-none">/</span>
            <button onClick={() => setPanelTab("checkin")}
              className={cn("dashboard-module-title text-sm font-semibold px-0.5 pb-0.5 border-b-2 transition",
                panelTab === "checkin" ? "" : "border-transparent text-gray-400 hover:text-gray-700")}
              style={panelTab === "checkin" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}>
              今日打卡
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {panelTab === "checkin" && (
            <span
              className="text-xs font-semibold tabular-nums cursor-default select-none"
              style={{ color: "var(--accent)" }}
              title="自动计算"
            >
              掌握度：{checkinRate}%
            </span>
          )}
          <button onClick={() => { refresh(); setCheckinKey((k) => k + 1); }} className="flex items-center justify-center w-6 h-6 rounded-lg hover:bg-gray-100 text-gray-400 transition" title="刷新">
            <RotateCcw size={11} />
          </button>
          {panelTab === "tasks" && (
            <button onClick={() => setShowAdd((v) => !v)} className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition"
              style={{ color: "var(--accent)", background: "var(--accent-light)" }}>
              <Plus size={12} /> 添加
            </button>
          )}
        </div>
      </div>

      {panelTab === "tasks" && (
        <>
          <div className="h-1 w-full bg-gray-100 rounded-full mb-3 overflow-hidden">
            <div className="h-1 rounded-full transition-all" style={{ width: `${todayTasks.length ? (done / todayTasks.length) * 100 : 0}%`, backgroundColor: "var(--accent)" }} />
          </div>

          <div className="relative mb-2.5">
            <Search size={10} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-300" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索任务…"
              className="w-full pl-7 pr-3 py-1.5 text-xs bg-gray-50 border border-gray-100 rounded-lg outline-none" />
          </div>

          {showAdd && (
            <div className="mb-3 p-3 bg-gray-50 rounded-xl border border-gray-100 space-y-2">
              <input ref={addRef} value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); if (e.key === "Escape") setShowAdd(false); }}
                placeholder="任务名称…" className="w-full px-3 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none" />
              <div className="flex gap-2 items-center">
                <select value={newGoalId} onChange={(e) => setNewGoalId(e.target.value)}
                  className="flex-1 px-2 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none">
                  {goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                </select>
                <input type="number" min={5} max={480} value={newMinutes} onChange={(e) => setNewMinutes(Number(e.target.value))}
                  className="w-14 px-2 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none text-center" />
                <span className="text-xs text-gray-400">min</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex gap-0.5">
                  {(["high", "medium", "low"] as Priority[]).map((p) => (
                    <button key={p} type="button" onClick={() => setNewPriority(p)}
                      className={cn("px-1.5 py-0.5 text-xs rounded-md transition", PRIORITY_CLS[p][newPriority === p ? "on" : "off"])}>
                      {PRIORITY_LABEL[p]}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <button onClick={() => setShowAdd(false)} className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-500">取消</button>
                  <button onClick={submitAdd} className="text-xs px-2.5 py-1 rounded-lg text-white" style={{ backgroundColor: "var(--accent)" }}>保存</button>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-1 flex-1 overflow-y-auto min-h-0">
            {isLoading && <p className="text-xs text-gray-400 text-center py-6">加载中…</p>}
            {!isLoading && error && (
              <div className="text-center py-6">
                <p className="text-xs text-red-400 mb-2">{error}</p>
                <button onClick={refresh} className="text-xs px-3 py-1 rounded-lg bg-gray-100 text-gray-600">重试</button>
              </div>
            )}
            {!isLoading && !error && filtered.length === 0 && <p className="text-xs text-gray-400 text-center py-6">暂无今日任务</p>}
            {filtered.map((task) => (
              <div key={task.id} className="today-task-item group flex items-start gap-2 border border-transparent px-2 py-2 rounded-xl hover:bg-gray-50 transition">
                <button onClick={() => toggleTask(task.id)} className="mt-0.5 flex-shrink-0">
                  {task.done
                    ? <CheckCircle2 size={15} style={{ color: "var(--accent)" }} />
                    : <Circle size={15} className="text-gray-300 group-hover:text-gray-400 transition" />}
                </button>
                {editingId === task.id ? (
                  <div className="flex-1 space-y-1.5">
                    <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveEdit(task.id); if (e.key === "Escape") setEditingId(null); }}
                      className="w-full px-2 py-1 text-xs bg-white border border-gray-200 rounded-lg outline-none" autoFocus />
                    <div className="flex items-center gap-1.5">
                      <input type="number" min={5} max={480} value={editMinutes} onChange={(e) => setEditMinutes(Number(e.target.value))}
                        className="w-14 px-2 py-0.5 text-xs bg-white border border-gray-200 rounded-lg outline-none text-center" />
                      <span className="text-xs text-gray-400">min</span>
                      <div className="flex gap-0.5 ml-1">
                        {(["high", "medium", "low"] as Priority[]).map((p) => (
                          <button key={p} type="button" onClick={() => setEditPriority(p)}
                            className={cn("px-1.5 py-0.5 text-xs rounded-md transition", PRIORITY_CLS[p][editPriority === p ? "on" : "off"])}>
                            {PRIORITY_LABEL[p]}
                          </button>
                        ))}
                      </div>
                      <button onClick={() => saveEdit(task.id)} className="ml-auto p-1 rounded" style={{ color: "var(--accent)" }}><Check size={12} /></button>
                      <button onClick={() => setEditingId(null)} className="p-1 rounded text-gray-400"><X size={12} /></button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <p className={cn("text-sm leading-snug", task.done ? "line-through text-gray-400" : "text-gray-700")}>{task.title}</p>
                      <span className="text-xs text-gray-400 flex items-center gap-0.5 mt-0.5">
                        <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", PRIORITY_DOT[task.priority ?? "medium"])} />
                        <Clock size={9} />{task.estimatedMinutes}m · <span className="truncate">{task.goalTitle}</span>
                      </span>
                    </div>
                    <div className="flex gap-0.5 flex-shrink-0">
                      <button onClick={() => { setEditingId(task.id); setEditTitle(task.title); setEditMinutes(task.estimatedMinutes); setEditPriority(task.priority ?? "medium"); }}
                        className="p-1 rounded hover:bg-gray-100 text-gray-400"><Pencil size={11} /></button>
                      <button onClick={() => deleteTask(task.id)} className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"><Trash2 size={11} /></button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

        </>
      )}

      {panelTab === "checkin" && (
        <div className="flex-1 overflow-y-auto min-h-0">
          {activeGoal ? (
            <CheckinForm
              key={checkinKey}
              goalId={activeGoal.id}
              goalTitle={activeGoal.title}
              tasks={activeGoalTodayTasks.map((t) => ({
                id: t.id,
                title: t.title,
                estimated_mins: t.estimatedMinutes,
                status: t.done ? "completed" : "pending",
                mastery_level: t.masteryLevel,
              }))}
              onRateChange={setCheckinRate}
              onSuccess={() => refresh()}
              onReplanRequest={async () => {
                try {
                  await api.post(`/api/v1/agent/reschedule/${activeGoal.id}`, {});
                  refresh();
                  setCheckinKey((key) => key + 1);
                } catch {}
              }}
            />
          ) : (
            <DashboardEmptyState
              kind="checkin"
              title="还没有打卡记录"
              description="添加你的第一个学习打卡吧！"
              href="/work/goals/new"
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── 今日时间规划 ─────────────────────────────────────────────
type TimeBlock = {
  id: string;
  label: string;
  taskId?: string;
  goalTitle?: string;
  startHour: number;
  durationMinutes: number;
  color: string;
  progress: number;
};

// 跟随主题色方案，从浅到深循环
const THEME_BLOCK_COLORS = [
  "var(--heat-2)",
  "var(--accent)",
  "var(--heat-4)",
  "var(--accent-dark)",
];

// 编辑器可选颜色：鲜明色，不依赖主题
const VIVID_COLORS = [
  "#ef4444","#f97316","#eab308","#22c55e",
  "#06b6d4","#8b5cf6","#ec4899","#6366f1",
];

const SCHED_START = 8, SCHED_END = 22;

function hourToStr(h: number) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
}

function strToHour(s: string) {
  const [h, m] = s.split(":").map(Number);
  return h + (m || 0) / 60;
}

function buildAIBlocks(
  taskList: { id: string; title: string; goalTitle: string; estimatedMinutes: number }[],
  fromHour = 0,
  slotConfig = { morning: 2, afternoon: 2, evening: 1.5 }
): TimeBlock[] {
  const slots = [
    { key: "m", startHour: 9, hours: slotConfig.morning },
    { key: "a", startHour: 14, hours: slotConfig.afternoon },
    { key: "e", startHour: 20, hours: slotConfig.evening },
  ];

  const result: TimeBlock[] = [];
  let idx = 0;
  for (const slot of slots) {
    const slotStart = Math.max(slot.startHour, fromHour + 0.25);
    if (slotStart >= slot.startHour + slot.hours) continue;
    let cur = slotStart * 60;
    const end = (slot.startHour + slot.hours) * 60;
    while (idx < taskList.length && cur + 5 <= end) {
      const t = taskList[idx];
      const dur = Math.min(t.estimatedMinutes, end - cur);
      result.push({
        id: `${slot.key}-${idx}`,
        label: t.title,
        taskId: t.id,
        goalTitle: t.goalTitle,
        startHour: cur / 60,
        durationMinutes: dur,
        color: THEME_BLOCK_COLORS[idx % THEME_BLOCK_COLORS.length],
        progress: 0,
      });
      cur += dur + 10;
      idx++;
    }
  }
  // 剩余任务：从最后一个时间块之后开始排列，避免重叠
  if (idx < taskList.length) {
    let overflowStart: number;
    if (result.length > 0) {
      const last = result[result.length - 1];
      overflowStart = last.startHour + last.durationMinutes / 60 + 10 / 60;
    } else {
      overflowStart = fromHour + 0.25;
    }
    let cur = overflowStart * 60;
    while (idx < taskList.length) {
      const t = taskList[idx];
      result.push({
        id: `overflow-${idx}`,
        label: t.title,
        taskId: t.id,
        goalTitle: t.goalTitle,
        startHour: cur / 60,
        durationMinutes: t.estimatedMinutes,
        color: THEME_BLOCK_COLORS[idx % THEME_BLOCK_COLORS.length],
        progress: 0,
      });
      cur += t.estimatedMinutes + 10;
      idx++;
    }
  }
  return result;
}

function buildSequentialBlocks(
  taskList: { id: string; title: string; goalTitle: string; estimatedMinutes: number }[],
  startHour: number,
): TimeBlock[] {
  const result: TimeBlock[] = [];
  let cur = startHour * 60;
  taskList.forEach((t, idx) => {
    result.push({
      id: `seq-${idx}`,
      label: t.title,
      taskId: t.id,
      goalTitle: t.goalTitle,
      startHour: cur / 60,
      durationMinutes: t.estimatedMinutes,
      color: THEME_BLOCK_COLORS[idx % THEME_BLOCK_COLORS.length],
      progress: 0,
    });
    cur += t.estimatedMinutes + 10;
  });
  return result;
}

function DailySchedulePanel() {
  const { tasks } = useTasks();
  const { goals } = useGoalStore();

  const [open, setOpen] = useState(true);
  const [viewMode, setViewMode] = useState<"timeline" | "list">("list");
  const [blocks, setBlocks] = useState<TimeBlock[]>([]);
  const [showAIDialog, setShowAIDialog] = useState(false);
  const [showSlotConfig, setShowSlotConfig] = useState(false);
  const [customStartStr, setCustomStartStr] = useState(() => {
    const d = new Date(); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  });
  const [slotHours, setSlotHours] = useState<{ morning: number; afternoon: number; evening: number }>(() => {
    try { const s = localStorage.getItem("slotHours"); if (s) return JSON.parse(s); } catch {}
    return { morning: 2, afternoon: 2, evening: 1.5 };
  });
  const updateSlotHour = useCallback((key: "morning" | "afternoon" | "evening", val: number) => {
    setSlotHours((prev) => {
      const next = { ...prev, [key]: val };
      localStorage.setItem("slotHours", JSON.stringify(next));
      return next;
    });
  }, []);
  const blocksLoadedRef = useRef(false);
  const [blocksLoaded, setBlocksLoaded] = useState(false);

  useEffect(() => {
    api.get<{ date: string; blocks: TimeBlock[] }>("/api/v1/schedule/today")
      .then((data) => {
        setBlocks(data.blocks);
        blocksLoadedRef.current = true;
        setBlocksLoaded(true);
      })
      .catch(() => { blocksLoadedRef.current = true; setBlocksLoaded(true); });
  }, []);

  // 删除目标后，过滤掉已不存在任务对应的时间块
  useEffect(() => {
    if (!blocksLoaded) return;
    const taskIds = new Set(tasks.map((t) => t.id));
    const isUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    setBlocks((prev) => {
      const filtered = prev.filter((b) => !isUUID(b.id) || taskIds.has(b.id));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [tasks, blocksLoaded]);

  useEffect(() => {
    if (!blocksLoadedRef.current) return;
    const t = setTimeout(() => {
      api.put("/api/v1/schedule/today", { blocks }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [blocks]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [latePlanMsg, setLatePlanMsg] = useState(false);
  const [draft, setDraft] = useState<{ label: string; startStr: string; durationMinutes: number; color: string; progress: number }>({
    label: "", startStr: "09:00", durationMinutes: 60, color: THEME_BLOCK_COLORS[0], progress: 0,
  });
  const [overlapWarning, setOverlapWarning] = useState<{ names: string[] } | null>(null);

  // 实时时钟，5 分钟更新一次
  const [nowHour, setNowHour] = useState(() => {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
  });
  useEffect(() => {
    const id = setInterval(() => {
      const d = new Date();
      setNowHour(d.getHours() + d.getMinutes() / 60);
    }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // 动态列宽：以最长内容为准，所有行统一
  const goalColWidth = useMemo(() => {
    if (typeof document === "undefined") return 64;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return 64;
    ctx.font = "12px system-ui, -apple-system, sans-serif"; // 匹配实际渲染字体
    const maxWidth = Math.max(
      0,
      ...blocks.filter((b) => b.goalTitle).map((b) => ctx.measureText(b.goalTitle!).width)
    );
    return maxWidth === 0 ? 0 : Math.max(64, Math.ceil(maxWidth) + 8); // +8px 余量
  }, [blocks]);

  const buildSortedTasks = useCallback(() => {
    const now = new Date().getHours() + new Date().getMinutes() / 60;
    if (now >= 22.5) {
      const undoneCount = tasks.filter((t) => t.date === TODAY && !t.done).length;
      if (undoneCount > 0) { setLatePlanMsg(true); setBlocks([]); setSelectedId(null); return null; }
    }
    setLatePlanMsg(false);
    const goalMap = Object.fromEntries(goals.map((g) => [g.id, g.title]));
    const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return tasks
      .filter((t) => t.date === TODAY && !t.done)
      .sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority ?? "medium"];
        const pb = PRIORITY_ORDER[b.priority ?? "medium"];
        if (pa !== pb) return pa - pb;
        return b.estimatedMinutes - a.estimatedMinutes;
      })
      .map((t) => ({ id: t.id, title: t.title, goalTitle: goalMap[t.goalId ?? ""] ?? "", estimatedMinutes: t.estimatedMinutes }));
  }, [goals, tasks]);

  const applyAI = useCallback((mode: "now" | "slots" | "custom", customStr?: string) => {
    const sorted = buildSortedTasks();
    if (!sorted) return;
    const now = new Date().getHours() + new Date().getMinutes() / 60;
    if (mode === "now") {
      setBlocks(buildSequentialBlocks(sorted, now + 1/60));
    } else if (mode === "custom") {
      const h = strToHour(customStr ?? hourToStr(now));
      setBlocks(buildSequentialBlocks(sorted, h));
    } else {
      setBlocks(buildAIBlocks(sorted, now, slotHours));
    }
    setSelectedId(null);
    setShowAIDialog(false);
  }, [buildSortedTasks, slotHours]);

  const selectBlock = useCallback((b: TimeBlock) => {
    setSelectedId((prev) => (prev === b.id ? null : b.id));
    setDraft({ label: b.label, startStr: hourToStr(b.startHour), durationMinutes: b.durationMinutes, color: b.color, progress: b.progress });
    setOverlapWarning(null);
  }, []);

  const commitSave = useCallback(() => {
    if (!selectedId) return;
    setBlocks((prev) =>
      prev.map((b) =>
        b.id === selectedId
          ? { ...b, label: draft.label, startHour: strToHour(draft.startStr), durationMinutes: draft.durationMinutes, color: draft.color, progress: draft.progress }
          : b
      )
    );
    setSelectedId(null);
    setOverlapWarning(null);
  }, [selectedId, draft]);

  const commitSaveWithCascade = useCallback(() => {
    if (!selectedId) return;
    const newStart = strToHour(draft.startStr);
    const newDur = draft.durationMinutes;
    setBlocks((prev) => {
      const afterEdit = prev.map((b) =>
        b.id === selectedId
          ? { ...b, label: draft.label, startHour: newStart, durationMinutes: newDur, color: draft.color, progress: draft.progress }
          : { ...b }
      );
      const sorted = [...afterEdit].sort((a, b) => a.startHour - b.startHour);
      const editedIdx = sorted.findIndex((b) => b.id === selectedId);
      let cursor = sorted[editedIdx].startHour + sorted[editedIdx].durationMinutes / 60 + 10 / 60;
      for (let i = editedIdx + 1; i < sorted.length; i++) {
        if (sorted[i].startHour < cursor) {
          sorted[i] = { ...sorted[i], startHour: cursor };
          cursor = sorted[i].startHour + sorted[i].durationMinutes / 60 + 10 / 60;
        } else {
          break;
        }
      }
      return prev.map((b) => sorted.find((s) => s.id === b.id)!);
    });
    setSelectedId(null);
    setOverlapWarning(null);
  }, [selectedId, draft]);

  const saveEdit = useCallback(() => {
    if (!selectedId) return;
    const newStart = strToHour(draft.startStr);
    const newEnd = newStart + draft.durationMinutes / 60;
    const overlapping = blocks.filter((b) => {
      if (b.id === selectedId) return false;
      const bEnd = b.startHour + b.durationMinutes / 60;
      return newStart < bEnd && newEnd > b.startHour;
    });
    if (overlapping.length > 0) {
      setOverlapWarning({ names: overlapping.map((b) => b.label) });
    } else {
      commitSave();
    }
  }, [selectedId, draft, blocks, commitSave]);

  const deleteBlock = useCallback((id: string) => {
    setBlocks((prev) => prev.filter((b) => b.id !== id));
    setSelectedId((prev) => (prev === id ? null : prev));
  }, []);

  // 时间轴终点动态扩展：有超时块时自动延伸，保证所有块可见
  const schedEnd = useMemo(() => {
    if (blocks.length === 0) return SCHED_END;
    const latest = Math.max(...blocks.map((b) => b.startHour + b.durationMinutes / 60));
    return Math.max(SCHED_END, Math.ceil(latest + 0.5));
  }, [blocks]);
  const schedRange = schedEnd - SCHED_START;
  const hourMarkers = Array.from({ length: Math.floor(schedRange / 2) + 1 }, (_, i) => SCHED_START + i * 2).filter((h) => h <= schedEnd);
  const getBlockLeft = (b: TimeBlock) => `${((b.startHour - SCHED_START) / schedRange) * 100}%`;
  const getBlockWidth = (b: TimeBlock) => `${Math.max(0.8, (b.durationMinutes / (schedRange * 60)) * 100)}%`;
  const selectedBlock = blocks.find((b) => b.id === selectedId);

  return (
    <div className="journal-card bg-gray-50 rounded-2xl shadow-sm border border-gray-100 p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="dashboard-module-icon w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: "var(--accent-light)" }}>
            <Calendar size={14} style={{ color: "var(--accent)" }} />
          </div>
          <span className="dashboard-module-title text-sm font-semibold text-gray-900">今日时间规划</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button onClick={() => { const d = new Date(); d.setMinutes(Math.ceil(d.getMinutes()/15)*15,0,0); setCustomStartStr(`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`); setShowAIDialog((v) => !v); }}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg text-white font-medium transition hover:opacity-90"
              style={{ backgroundColor: "var(--accent)" }}>
              <Wand2 size={11} /> AI 智能规划
            </button>
            {showAIDialog && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowAIDialog(false)} />
                <div className="absolute top-full right-0 mt-1.5 z-30 bg-white rounded-2xl border border-gray-100 p-3 w-60"
                  style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.10)" }}>
                  <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2 px-1">开始时间</p>
                  <div className="space-y-1">
                    <button onClick={() => applyAI("now")}
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-gray-50 text-left transition group">
                      <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
                        <Clock size={12} style={{ color: "var(--accent)" }} />
                      </div>
                      <div>
                        <div className="text-xs font-medium text-gray-800">从现在开始</div>
                        <div className="text-[10px] text-gray-400">{hourToStr(new Date().getHours() + new Date().getMinutes()/60)} 起顺序排列</div>
                      </div>
                    </button>
                    <div className="flex items-center gap-1">
                      <button onClick={() => applyAI("slots")}
                        className="flex-1 flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-gray-50 text-left transition">
                        <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
                          <LayoutList size={12} style={{ color: "var(--accent)" }} />
                        </div>
                        <div>
                          <div className="text-xs font-medium text-gray-800">按预设时段</div>
                          <div className="text-[10px] text-gray-400">上午{slotHours.morning}h · 下午{slotHours.afternoon}h · 晚上{slotHours.evening}h</div>
                        </div>
                      </button>
                      <button onClick={() => setShowSlotConfig((v) => !v)}
                        className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 transition flex-shrink-0 mr-1">
                        <ChevronDown size={11} className={cn("transition-transform", showSlotConfig && "rotate-180")} />
                      </button>
                    </div>
                    {showSlotConfig && (
                      <div className="px-2 pb-1.5 space-y-1">
                        {([
                          { key: "morning" as const, label: "上午", start: "09:00" },
                          { key: "afternoon" as const, label: "下午", start: "14:00" },
                          { key: "evening" as const, label: "晚上", start: "20:00" },
                        ]).map(({ key, label, start }) => (
                          <div key={key} className="flex items-center justify-between">
                            <span className="text-[10px] text-gray-500">{label} {start}</span>
                            <div className="flex items-center gap-1">
                              <button onClick={() => updateSlotHour(key, Math.max(0, +(slotHours[key] - 0.5).toFixed(1)))}
                                className="w-5 h-5 rounded flex items-center justify-center text-gray-400 hover:bg-gray-100">−</button>
                              <span className="text-[10px] text-gray-700 w-6 text-center">{slotHours[key]}h</span>
                              <button onClick={() => updateSlotHour(key, Math.min(8, +(slotHours[key] + 0.5).toFixed(1)))}
                                className="w-5 h-5 rounded flex items-center justify-center text-gray-400 hover:bg-gray-100">+</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 px-1 pt-1 border-t border-gray-100">
                      <input type="time" value={customStartStr}
                        onChange={(e) => setCustomStartStr(e.target.value)}
                        className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:ring-1"
                        style={{ ["--tw-ring-color" as string]: "var(--accent)" }} />
                      <button onClick={() => applyAI("custom", customStartStr)} disabled={!customStartStr}
                        className="px-2.5 py-1.5 text-xs rounded-lg text-white font-medium transition hover:opacity-90 disabled:opacity-40 flex-shrink-0"
                        style={{ backgroundColor: "var(--accent)" }}>
                        确定
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
            <button onClick={() => setViewMode("list")}
              className={cn("p-1.5 rounded-md transition", viewMode === "list" ? "bg-white text-gray-900 shadow-sm" : "text-gray-400 hover:text-gray-600")}
              title="列表视图">
              <LayoutList size={13} />
            </button>
            <button onClick={() => setViewMode("timeline")}
              className={cn("p-1.5 rounded-md transition", viewMode === "timeline" ? "bg-white text-gray-900 shadow-sm" : "text-gray-400 hover:text-gray-600")}
              title="时间轴视图">
              <BarChart3 size={13} />
            </button>
          </div>
          <button onClick={() => setOpen((v) => !v)}
            className="text-xs text-gray-400 hover:text-gray-600 transition bg-gray-50 px-2.5 py-1 rounded-lg">
            {open ? "收起" : "展开"}
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* 时间轴视图 */}
          {viewMode === "timeline" && (
          <div className="relative">
            <div className="relative h-5 mb-1">
              {hourMarkers.map((h) => (
                <span key={h} className="absolute text-xs text-gray-300 -translate-x-1/2"
                  style={{ left: `${((h - SCHED_START) / schedRange) * 100}%` }}>
                  {h}:00
                </span>
              ))}
            </div>

            <div className="relative h-24 bg-gray-50 rounded-xl overflow-hidden cursor-default"
              onClick={() => setSelectedId(null)}>
              {hourMarkers.map((h) => (
                <div key={h} className="absolute top-0 bottom-0 w-px bg-gray-200"
                  style={{ left: `${((h - SCHED_START) / schedRange) * 100}%` }} />
              ))}

              {blocks.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">
                  {latePlanMsg ? "今天已经很晚了，好好休息 💤 明天继续加油吧！" : "点击「AI 智能规划」生成今日时间规划"}
                </div>
              )}

              {blocks.map((b) => {
                const widthPct = (b.durationMinutes / (schedRange * 60)) * 100;
                const showLabel = widthPct > 2;
                const isDone = !!b.taskId && !!tasks.find((t) => t.id === b.taskId)?.done;
                return (
                  <button key={b.id}
                    title={`${b.label}  ${hourToStr(b.startHour)} · ${b.durationMinutes}min`}
                    onClick={(e) => { e.stopPropagation(); selectBlock(b); }}
                    className={cn(
                      "absolute top-1.5 bottom-1.5 rounded-lg text-white text-xs font-medium transition hover:opacity-90 overflow-hidden flex justify-center pt-2",
                      selectedId === b.id && "ring-2 ring-offset-1 ring-gray-500"
                    )}
                    style={{ left: getBlockLeft(b), width: getBlockWidth(b), backgroundColor: isDone ? "#9ca3af" : b.color, opacity: isDone ? 0.7 : 1 }}>
                    {showLabel && (
                      <span style={{ writingMode: "vertical-rl", textOrientation: "mixed", lineHeight: 1.3 }}
                        className="relative overflow-hidden max-h-full text-ellipsis whitespace-nowrap z-10">
                        {b.label}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* 列表视图 */}
          {viewMode === "list" && (
            <div className="daily-plan-scroll h-44 space-y-1.5 overflow-x-hidden overflow-y-scroll pr-2">
              {blocks.length === 0 && (
                <div className="py-8 text-center text-xs text-gray-400">
                  {latePlanMsg ? "今天已经很晚了，好好休息 💤 明天继续加油吧！" : "点击「AI 智能规划」生成今日时间规划"}
                </div>
              )}
              {[...blocks].sort((a, b) => a.startHour - b.startHour).map((b) => {
                const endHour = b.startHour + b.durationMinutes / 60;
                const isSelected = selectedId === b.id;
                const isDone = !!b.taskId && !!tasks.find((t) => t.id === b.taskId)?.done;
                return (
                  <div key={b.id}>
                    <div
                      className={cn(
                        "group flex items-center gap-3 px-3 py-2.5 border transition cursor-pointer",
                        isDone ? "opacity-60" : "",
                        isSelected
                          ? "rounded-t-xl border-gray-200 bg-gray-50"
                          : "rounded-xl border-gray-100 hover:border-gray-200 hover:bg-gray-50"
                      )}
                      onClick={() => selectBlock(b)}>
                      {/* 左侧色条 */}
                      <div className="w-1 self-stretch rounded-full flex-shrink-0" style={{ backgroundColor: isDone ? "#9ca3af" : b.color }} />
                      {/* 时间 */}
                      <span className="text-sm font-semibold text-gray-700 font-mono whitespace-nowrap flex-shrink-0 w-28">
                        {hourToStr(b.startHour)}–{hourToStr(endHour)}
                      </span>
                      <div className="w-px h-4 bg-gray-200 flex-shrink-0" />
                      {/* 任务名 */}
                      <span className="text-sm text-gray-800 font-medium flex-1 truncate">{b.label}</span>
                      <div className="w-px h-4 bg-gray-200 flex-shrink-0" />
                      {/* 时间流逝度 */}
                      {(() => {
                        const endH = b.startHour + b.durationMinutes / 60;
                        const elapsed = nowHour <= b.startHour ? 0 : nowHour >= endH ? 100 : Math.round(((nowHour - b.startHour) / (b.durationMinutes / 60)) * 100);
                        const active = nowHour >= b.startHour && nowHour < endH;
                        return (
                          <div className="flex items-center gap-1.5 flex-shrink-0"
                            title={`${elapsed}%${active ? " · 进行中" : elapsed >= 100 ? " · 已结束" : " · 未开始"}`}>
                            <span className="text-xs text-gray-400 whitespace-nowrap">时间流逝度</span>
                            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden w-16">
                              <div className="h-full rounded-full transition-all"
                                style={{ width: `${elapsed}%`, backgroundColor: active ? b.color : elapsed >= 100 ? "#9ca3af" : "#d1d5db" }} />
                            </div>
                            <span className="text-xs font-semibold w-8 text-right tabular-nums"
                              style={{ color: active ? b.color : undefined, opacity: elapsed === 0 ? 0.35 : 1 }}>
                              {elapsed}%
                            </span>
                          </div>
                        );
                      })()}
                      {/* 关联目标（末尾）*/}
                      {b.goalTitle && (
                        <>
                          <div className="w-px h-4 bg-gray-200 flex-shrink-0" />
                          <span className="text-xs text-gray-400 whitespace-nowrap flex-shrink-0" style={{ width: goalColWidth, minWidth: goalColWidth }}>{b.goalTitle}</span>
                        </>
                      )}
                      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition flex-shrink-0">
                        <button onClick={(e) => { e.stopPropagation(); deleteBlock(b.id); }}
                          className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                    {isSelected && (
                      <div className="px-3 pt-3 pb-2.5 bg-gray-50 rounded-b-xl border border-t-0 border-gray-200 space-y-2.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <input value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                            placeholder="时间块名称"
                            className="flex-1 min-w-28 px-2.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-accent" />
                          <div className="flex items-center gap-0.5">
                            <input type="number" min={0} max={23}
                              value={Number(draft.startStr.split(":")[0])}
                              onChange={(e) => {
                                const h = Math.min(23, Math.max(0, Number(e.target.value)));
                                const m = draft.startStr.split(":")[1] ?? "00";
                                setDraft((d) => ({ ...d, startStr: `${String(h).padStart(2,"0")}:${m}` }));
                              }}
                              className="w-11 px-1.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none text-center" />
                            <span className="text-xs text-gray-400 px-0.5">:</span>
                            <input type="number" min={0} max={55} step={5}
                              value={Number(draft.startStr.split(":")[1] ?? "0")}
                              onChange={(e) => {
                                const m = Math.min(55, Math.max(0, Number(e.target.value)));
                                const h = draft.startStr.split(":")[0] ?? "09";
                                setDraft((d) => ({ ...d, startStr: `${h}:${String(m).padStart(2,"0")}` }));
                              }}
                              className="w-11 px-1.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none text-center" />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <input type="number" min={5} max={480} step={5} value={draft.durationMinutes}
                              onChange={(e) => setDraft((d) => ({ ...d, durationMinutes: Number(e.target.value) }))}
                              className="w-16 px-2 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none text-center" />
                            <span className="text-xs text-gray-400">min</span>
                          </div>
                          <div className="flex gap-1 items-center flex-wrap">
                            {VIVID_COLORS.map((c) => (
                              <button key={c} onClick={() => setDraft((d) => ({ ...d, color: c }))}
                                className={cn("w-4 h-4 rounded-full transition hover:scale-110", draft.color === c && "ring-2 ring-offset-1 ring-gray-400")}
                                style={{ backgroundColor: c }} />
                            ))}
                          </div>
                        </div>
                        {overlapWarning && (
                          <div className="flex items-center gap-2 px-2.5 py-2 bg-gray-100 border border-gray-200 rounded-lg">
                            <span className="text-xs text-gray-600 flex-1">与「{overlapWarning.names.join("、")}」时间重叠</span>
                            <button onClick={() => setOverlapWarning(null)}
                              className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-500 hover:bg-gray-200 transition flex-shrink-0">取消</button>
                            <button onClick={commitSaveWithCascade}
                              className="text-xs px-2 py-1 rounded text-white transition hover:opacity-90 flex-shrink-0"
                              style={{ backgroundColor: "var(--accent)" }}>移动后续任务</button>
                          </div>
                        )}
                        <div className="flex gap-1 justify-end">
                          <button onClick={() => { setSelectedId(null); setOverlapWarning(null); }}
                            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition"><X size={13} /></button>
                          <button onClick={saveEdit}
                            className="px-3 py-1.5 rounded-lg text-white text-xs font-medium transition hover:opacity-90"
                            style={{ backgroundColor: "var(--accent)" }}>保存</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* 时间轴编辑面板 */}
          {viewMode === "timeline" && selectedBlock && (
            <div className="mt-3 p-3 bg-gray-50 rounded-xl border border-gray-100 space-y-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <input value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                  placeholder="时间块名称"
                  className="flex-1 min-w-28 px-2.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-accent" />
                <div className="flex items-center gap-0.5">
                  <input type="number" min={0} max={23}
                    value={Number(draft.startStr.split(":")[0])}
                    onChange={(e) => {
                      const h = Math.min(23, Math.max(0, Number(e.target.value)));
                      const m = draft.startStr.split(":")[1] ?? "00";
                      setDraft((d) => ({ ...d, startStr: `${String(h).padStart(2,"0")}:${m}` }));
                    }}
                    className="w-11 px-1.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none text-center" />
                  <span className="text-xs text-gray-400 px-0.5">:</span>
                  <input type="number" min={0} max={55} step={5}
                    value={Number(draft.startStr.split(":")[1] ?? "0")}
                    onChange={(e) => {
                      const m = Math.min(55, Math.max(0, Number(e.target.value)));
                      const h = draft.startStr.split(":")[0] ?? "09";
                      setDraft((d) => ({ ...d, startStr: `${h}:${String(m).padStart(2,"0")}` }));
                    }}
                    className="w-11 px-1.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none text-center" />
                </div>
                <div className="flex items-center gap-1.5">
                  <input type="number" min={5} max={480} step={5} value={draft.durationMinutes}
                    onChange={(e) => setDraft((d) => ({ ...d, durationMinutes: Number(e.target.value) }))}
                    className="w-16 px-2 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none text-center" />
                  <span className="text-xs text-gray-400">min</span>
                </div>
                <div className="flex gap-1 items-center flex-wrap">
                  {VIVID_COLORS.map((c) => (
                    <button key={c} onClick={() => setDraft((d) => ({ ...d, color: c }))}
                      className={cn("w-4 h-4 rounded-full transition hover:scale-110", draft.color === c && "ring-2 ring-offset-1 ring-gray-400")}
                      style={{ backgroundColor: c }} />
                  ))}
                </div>
                <div className="flex gap-1 ml-auto">
                  <button onClick={() => deleteBlock(selectedBlock.id)}
                    className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition">
                    <Trash2 size={13} />
                  </button>
                  <button onClick={() => { setSelectedId(null); setOverlapWarning(null); }}
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition">
                    <X size={13} />
                  </button>
                  <button onClick={saveEdit}
                    className="px-3 py-1.5 rounded-lg text-white text-xs font-medium transition hover:opacity-90"
                    style={{ backgroundColor: "var(--accent)" }}>
                    保存
                  </button>
                </div>
              </div>
              {overlapWarning && (
                <div className="flex items-center gap-2 px-2.5 py-2 bg-gray-100 border border-gray-200 rounded-lg">
                  <span className="text-xs text-gray-600 flex-1">与「{overlapWarning.names.join("、")}」时间重叠</span>
                  <button onClick={() => setOverlapWarning(null)}
                    className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-500 hover:bg-gray-200 transition flex-shrink-0">取消</button>
                  <button onClick={commitSaveWithCascade}
                    className="text-xs px-2 py-1 rounded text-white transition hover:opacity-90 flex-shrink-0"
                    style={{ backgroundColor: "var(--accent)" }}>移动后续任务</button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}


// ── 主页面 ──────────────────────────────────────────────────
type ReviewQuestion = { id: string; question: string; hint: string };
type GoalReview = { goalId: string; goalTitle: string; questions: ReviewQuestion[] };

type DailyBrief = {
  date: string;
  summary: string;
  goalReviews: GoalReview[];
  insight: string | null;
  recommendedAction?: string;
};

type Period = "week" | "month" | "year";
const periodLabels: Record<Period, string> = { week: "本周", month: "本月", year: "全年" };

type GoalProgressData = {
  total_tasks: number;
  completed_tasks: number;
  avg_completion_rate: number;
  streak_days: number;
  days_ahead_or_behind: number;
};

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "上午好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

// ── 新用户首屏引导 ────────────────────────────────────────────
function NewUserWelcome({ username }: { username: string }) {
  const steps = [
    {
      step: 1,
      icon: Target,
      title: "创建学习目标",
      desc: "设定一个有截止日期的目标，比如「30 天读完一本书」或「通过 CET-6 考试」",
      href: "/work/goals?create=1",
      cta: "去创建目标",
    },
    {
      step: 2,
      icon: CheckCircle2,
      title: "拆解每日任务",
      desc: "把大目标分解成每天可执行的小步骤，AI 帮你生成任务计划",
      href: "/work/goals",
      cta: "查看目标列表",
    },
    {
      step: 3,
      icon: Brain,
      title: "记录学习过程",
      desc: "写学习记录、整理笔记、上传资料，把知识真正沉淀下来",
      href: "/work/notes?create=1",
      cta: "去写学习记录",
    },
  ];

  return (
    <div className="new-user-welcome flex flex-col items-center gap-10 py-6 px-2">
      {/* 插图区域 */}
      <div className="nu-illustration relative flex items-center justify-center" style={{ width: 180, height: 160 }}>
        {/* 光晕背景 */}
        <div className="absolute inset-0 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle at 50% 55%, color-mix(in srgb, var(--accent) 12%, transparent) 0%, transparent 70%)" }} />
        {/* 中心圆 */}
        <div className="relative z-10 w-20 h-20 rounded-full flex items-center justify-center"
          style={{ background: "var(--accent)", boxShadow: "0 8px 28px color-mix(in srgb, var(--accent) 38%, transparent)" }}>
          <Target size={36} className="text-white" />
        </div>
        {/* 卫星 dot — 上右 */}
        <div className="absolute top-5 right-7 w-9 h-9 rounded-full flex items-center justify-center z-10"
          style={{ background: "var(--accent-light)", border: "2px solid color-mix(in srgb, var(--accent) 30%, white)" }}>
          <CheckCircle2 size={15} style={{ color: "var(--accent)" }} />
        </div>
        {/* 卫星 dot — 下左 */}
        <div className="absolute bottom-5 left-7 w-8 h-8 rounded-full flex items-center justify-center z-10"
          style={{ background: "var(--accent-light)", border: "2px solid color-mix(in srgb, var(--accent) 30%, white)" }}>
          <Brain size={13} style={{ color: "var(--accent)" }} />
        </div>
        {/* 卫星 dot — 上左 */}
        <div className="absolute top-8 left-4 w-6 h-6 rounded-full z-10"
          style={{ background: "color-mix(in srgb, var(--accent) 18%, white)", border: "1.5px solid color-mix(in srgb, var(--accent) 22%, white)" }} />
        {/* 虚线轨道圆 */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 180 160">
          <ellipse cx="90" cy="80" rx="72" ry="62"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="5 5"
            style={{ color: "color-mix(in srgb, var(--accent) 22%, transparent)" }} />
        </svg>
      </div>

      {/* 标题 */}
      <div className="text-center max-w-lg">
        <p className="nu-subtitle text-xs font-semibold tracking-widest uppercase mb-2"
          style={{ color: "var(--accent)" }}>
          欢迎，{username}
        </p>
        <h2 className="nu-heading text-2xl font-bold text-gray-900 mb-3 leading-snug">
          开启你的学习之旅 ✨
        </h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          PlanPilot 把每个学习目标变成有序的行动计划，帮你<br className="hidden sm:inline" />
          一步一步走向理想。从创建第一个目标开始吧。
        </p>
      </div>

      {/* 三步卡片 */}
      <div className="nu-steps grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-2xl">
        {steps.map(({ step, icon: Icon, title, desc, href, cta }) => (
          <Link
            key={step}
            href={href}
            className="nu-step-card group relative flex flex-col gap-3 rounded-2xl border p-5 transition-all"
            style={{ borderColor: "color-mix(in srgb, var(--accent) 20%, #e5e7eb)", background: "white" }}
          >
            {/* 序号 + 图标 */}
            <div className="flex items-center gap-2.5">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                style={{ background: "var(--accent)" }}>
                {step}
              </span>
              <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: "var(--accent-light)" }}>
                <Icon size={16} style={{ color: "var(--accent)" }} />
              </div>
            </div>
            {/* 文字 */}
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-gray-900 mb-1">{title}</h3>
              <p className="text-xs text-gray-500 leading-relaxed">{desc}</p>
            </div>
            {/* CTA 行 */}
            <div className="flex items-center gap-1 text-xs font-semibold transition-colors"
              style={{ color: "var(--accent)" }}>
              {cta}
              <ArrowRight size={11} className="transition-transform group-hover:translate-x-0.5" />
            </div>
            {/* hover 左侧色条 */}
            <div className="nu-step-bar absolute left-0 top-4 bottom-4 w-0.5 rounded-full transition-all"
              style={{ background: "var(--accent)" }} />
          </Link>
        ))}
      </div>

      {/* 主 CTA 按钮 */}
      <Link
        href="/work/goals?create=1"
        className="nu-cta-btn flex items-center gap-2 rounded-2xl px-8 py-3.5 text-sm font-semibold text-white transition-all"
        style={{
          background: "var(--accent)",
          boxShadow: "0 4px 16px color-mix(in srgb, var(--accent) 38%, transparent)",
        }}
      >
        <Plus size={16} />
        创建第一个学习目标
      </Link>

      {/* 功能预览标签 */}
      <div className="flex flex-wrap items-center justify-center gap-2 pb-2">
        {[
          { icon: TrendingUp, label: "学习时长追踪" },
          { icon: Sparkles,   label: "AI 每日复习提示" },
          { icon: CalendarCheck, label: "打卡热力图" },
          { icon: Wand2,      label: "智能任务规划" },
        ].map(({ icon: Icon, label }) => (
          <span key={label}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs"
            style={{ background: "color-mix(in srgb, var(--accent) 8%, #f8f9fb)", color: "var(--accent)", border: "1px solid color-mix(in srgb, var(--accent) 15%, #e5e7eb)" }}>
            <Icon size={11} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { tasks, refresh } = useTasks();
  const { goals, fetchGoals } = useGoalStore();
  const { user } = useAuthStore();
  const todayTasks = tasks.filter((t) => t.date === TODAY);
  const [period, setPeriod] = useState<Period>("week");
  const [chartYear, setChartYear] = useState(new Date().getFullYear());
  const [briefOpen, setBriefOpen] = useState(false);
  const [reviewTab, setReviewTab] = useState<"priority" | "others">("priority");
  const [activeReview, setActiveReview] = useState<string | null>(null);
  const [dailyBrief, setDailyBrief] = useState<DailyBrief | null>(null);
  const [briefLoaded, setBriefLoaded] = useState(false);
  const [progressMap, setProgressMap] = useState<Record<string, GoalProgressData>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    if (localStorage.getItem("tasksNeedRefresh") === "1") {
      localStorage.removeItem("tasksNeedRefresh");
      refresh();
    }
  }, [refresh]);

  useEffect(() => { fetchGoals(); }, [fetchGoals]);

  const tasksDoneSignal = tasks.filter((t) => t.done).map((t) => t.id).sort().join(",");
  const [debouncedSignal, setDebouncedSignal] = useState(tasksDoneSignal);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSignal(tasksDoneSignal), 400);
    return () => clearTimeout(t);
  }, [tasksDoneSignal]);

  useEffect(() => {
    if (goals.length === 0) return;
    Promise.all(
      goals.map((g) =>
        api.get<GoalProgressData>(`/api/v1/goals/${g.id}/progress`)
          .then((data) => ({ id: g.id, data }))
          .catch(() => null)
      )
    ).then((results) => {
      const map: Record<string, GoalProgressData> = {};
      results.forEach((r) => { if (r) map[r.id] = r.data; });
      setProgressMap(map);
    });
  }, [goals, debouncedSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setBriefLoaded(false);
    api.get<DailyBrief | null>("/api/v1/agent/daily-brief")
      .then((brief) => setDailyBrief(brief ?? null))
      .catch(() => setDailyBrief(null))
      .finally(() => setBriefLoaded(true));
  }, [user?.username]);

  const refreshReview = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const d = await api.get<DailyBrief | null>("/api/v1/agent/daily-brief?refresh=true");
      setDailyBrief(d ?? null);
    } catch { /* ignore */ } finally {
      setIsRefreshing(false);
    }
  }, []);

  const weeklyHours = useMemo(() => {
    const DAY_LABELS = ["周一","周二","周三","周四","周五","周六","周日"];
    const today = new Date();
    const todayDow = (today.getDay() + 6) % 7; // Mon=0, Sun=6
    const monday = new Date(today);
    monday.setDate(today.getDate() - todayDow);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dateStr = localDate(d);
      const mins = tasks.filter((t) => t.date === dateStr && t.done).reduce((s, t) => s + t.estimatedMinutes, 0);
      return { label: DAY_LABELS[i], hours: +(mins / 60).toFixed(1), isToday: i === todayDow };
    });
  }, [tasks]);

  const monthlyHours  = useMemo(() => buildMonthlyHours(tasks),  [tasks]);
  const yearlyHours   = useMemo(() => buildYearlyHours(tasks, chartYear),   [tasks, chartYear]);
  const heatmapData   = useMemo(() => buildHeatmapData(tasks),   [tasks]);

  const periodData: Record<Period, { label: string; hours: number }[]> = {
    week: weeklyHours, month: monthlyHours, year: yearlyHours,
  };

  const done = todayTasks.filter((t) => t.done).length;
  const weekTotal = weeklyHours.reduce((s, d) => s + d.hours, 0).toFixed(1);
  const primaryGoal = goals.find((g) => g.status === "active") ?? goals[0] ?? null;
  const username = user?.username ?? "用户";
  const activeGoalsCount = goals.filter((g) => g.status === "active").length;
  const isNewUser = goals.length === 0 && tasks.length === 0;

  return (
    <div className="flex h-full flex-col bg-white">
      <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="calm-dashboard p-5 sm:p-8 space-y-6">
      {/* ── 欢迎区域 ── */}
      <section className="welcome-panel">
        <div className="home-welcome-layout">
          {/* 左侧：问候 + 洞察 */}
          <div className="home-welcome-copy">
            <h1 className="calm-heading home-greeting text-gray-900">
              {getGreeting()}，{username}<span className="home-greeting-wave" aria-hidden="true">👋</span>
            </h1>
            <TodayInsight inline goalId={primaryGoal?.id ?? null} />
          </div>
          {/* 右侧：统计 */}
          <div className="home-summary-stats">
            {[
              { label: "本周时长", value: `${weekTotal}h`,                  icon: Clock        },
              { label: "进行目标", value: `${activeGoalsCount} 个`,          icon: TrendingUp   },
              { label: "今日完成", value: `${done}/${todayTasks.length}`,    icon: CheckCircle2 },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="home-summary-stat">
                <div className="home-summary-stat-icon">
                  <Icon size={14} />
                </div>
                <div className="home-summary-stat-value">{value}</div>
                <div className="home-summary-stat-label">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {isNewUser ? (
        <NewUserWelcome username={username} />
      ) : (<>

      {/* ── AI 每日简报 ── */}
      {briefLoaded && (
        <div className="brief-card rounded-2xl p-5 relative overflow-hidden">
          <div className="absolute -top-6 -right-6 w-32 h-32 rounded-full pointer-events-none" style={{ background: "rgba(255,255,255,0.07)" }} />
          <div className="absolute -bottom-8 -right-16 w-48 h-48 rounded-full pointer-events-none" style={{ background: "rgba(255,255,255,0.05)" }} />

          {/* 标题行 */}
          <div className="relative flex items-center gap-2 mb-3">
            <div className="dashboard-module-icon w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "rgba(255,255,255,0.2)" }}>
              <Sparkles size={14} className="text-white" />
            </div>
            <span className="dashboard-module-title text-sm font-semibold text-white">今日复习提示</span>
          </div>

          {dailyBrief ? (
            <>
              {/* 推荐行动块 */}
              {dailyBrief.recommendedAction && (
                <div className="brief-recommended-action relative rounded-xl px-3.5 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-semibold tracking-widest text-white/45 mb-1 uppercase">推荐行动</p>
                      <p className="text-xs text-white/90 leading-relaxed">{dailyBrief.recommendedAction}</p>
                    </div>
                    {(dailyBrief.goalReviews ?? []).length > 0 && (
                      <button
                        onClick={() => setBriefOpen((v) => !v)}
                        className="flex-shrink-0 flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg font-medium transition self-center"
                        style={{ background: "rgba(255,255,255,0.22)", color: "white" }}
                      >
                        {briefOpen ? "收起" : "开始复习"}
                        <ChevronDown size={11} className={cn("transition-transform", briefOpen && "rotate-180")} />
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* 展开的复习区域 */}
              {briefOpen && (
                <div className="relative mt-3 -mx-5 -mb-5 bg-white rounded-b-2xl overflow-hidden">
                  {/* Tab 栏 */}
                  <div className="flex items-center justify-between px-5 pt-3.5 pb-3 border-b" style={{ borderColor: "var(--border-subtle)" }}>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setReviewTab("priority")}
                        className="text-xs px-3 py-1.5 rounded-lg font-medium transition"
                        style={reviewTab === "priority"
                          ? { background: "var(--accent)", color: "white" }
                          : { color: "var(--text-2)" }}
                      >
                        今日优先
                      </button>
                      {(dailyBrief.goalReviews ?? []).length > 1 && (
                        <button
                          onClick={() => setReviewTab("others")}
                          className="text-xs px-3 py-1.5 rounded-lg font-medium transition"
                          style={reviewTab === "others"
                            ? { background: "var(--accent)", color: "white" }
                            : { color: "var(--text-2)" }}
                        >
                          其他目标
                          <span className="ml-1 opacity-50">({(dailyBrief.goalReviews ?? []).length - 1})</span>
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => refreshReview()}
                      disabled={isRefreshing}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-40 transition"
                      style={{ background: "var(--accent-light)", color: "var(--accent)" }}
                    >
                      <RotateCcw size={11} className={isRefreshing ? "animate-spin" : ""} />
                      {isRefreshing ? "生成中..." : "换一批"}
                    </button>
                  </div>

                  <div className="px-5 py-4">
                    {/* 今日优先 tab */}
                    {reviewTab === "priority" && (
                      <>
                        {(dailyBrief.goalReviews ?? []).length > 0 ? (() => {
                          const gr = dailyBrief.goalReviews[0];
                          return (
                            <>
                              <p className="flex items-center gap-1.5 text-[11px] font-medium mb-3" style={{ color: "var(--text-3)" }}>
                                <Target size={10} style={{ color: "var(--accent)" }} />
                                {gr.goalTitle}
                              </p>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                {gr.questions.map((q) => (
                                  <button
                                    key={q.id}
                                    onClick={() => setActiveReview(activeReview === q.id ? null : q.id)}
                                    className="text-left rounded-xl border p-3 transition"
                                    style={{
                                      borderColor: activeReview === q.id ? "var(--accent)" : "var(--border-subtle)",
                                      background: activeReview === q.id ? "var(--accent-light)" : "var(--surface)",
                                    }}
                                  >
                                    <div className="flex items-start gap-1.5">
                                      <Zap size={10} className="flex-shrink-0 mt-0.5" style={{ color: "var(--accent)" }} />
                                      <p className="text-xs font-medium leading-snug" style={{ color: "var(--text-1)" }}>{q.question}</p>
                                    </div>
                                    {activeReview === q.id
                                      ? <p className="text-xs mt-2 pt-2 border-t leading-relaxed" style={{ color: "var(--text-2)", borderColor: "var(--accent-muted)" }}>{q.hint}</p>
                                      : <p className="text-[10px] mt-1.5" style={{ color: "var(--text-3)" }}>点击查看提示</p>}
                                  </button>
                                ))}
                              </div>
                            </>
                          );
                        })() : (
                          <p className="text-xs py-2" style={{ color: "var(--text-2)" }}>昨日暂无已完成任务，完成任务后次日生成复习题</p>
                        )}
                      </>
                    )}

                    {/* 其他目标 tab */}
                    {reviewTab === "others" && (
                      <div className="space-y-5">
                        {(dailyBrief.goalReviews ?? []).slice(1).map((gr) => (
                          <div key={gr.goalId}>
                            <p className="flex items-center gap-1.5 text-[11px] font-medium mb-2.5" style={{ color: "var(--text-3)" }}>
                              <Target size={10} style={{ color: "var(--accent)" }} />
                              {gr.goalTitle}
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                              {gr.questions.map((q) => (
                                <button
                                  key={q.id}
                                  onClick={() => setActiveReview(activeReview === q.id ? null : q.id)}
                                  className="text-left rounded-xl border p-3 transition"
                                  style={{
                                    borderColor: activeReview === q.id ? "var(--accent)" : "var(--border-subtle)",
                                    background: activeReview === q.id ? "var(--accent-light)" : "var(--surface)",
                                  }}
                                >
                                  <div className="flex items-start gap-1.5">
                                    <Zap size={10} className="flex-shrink-0 mt-0.5" style={{ color: "var(--accent)" }} />
                                    <p className="text-xs font-medium leading-snug" style={{ color: "var(--text-1)" }}>{q.question}</p>
                                  </div>
                                  {activeReview === q.id
                                    ? <p className="text-xs mt-2 pt-2 border-t leading-relaxed" style={{ color: "var(--text-2)", borderColor: "var(--accent-muted)" }}>{q.hint}</p>
                                    : <p className="text-[10px] mt-1.5" style={{ color: "var(--text-3)" }}>点击查看提示</p>}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                        {(dailyBrief.goalReviews ?? []).length <= 1 && (
                          <p className="text-xs py-2" style={{ color: "var(--text-2)" }}>暂无其他目标的复习内容</p>
                        )}
                      </div>
                    )}

                    {dailyBrief.insight && (
                      <div className="mt-4 pt-3 border-t flex items-center gap-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-3)" }}>
                        <Brain size={11} /> {dailyBrief.insight}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="relative text-sm text-white/50 leading-relaxed">暂无复习提示，完成首次学习回顾后生成</p>
          )}
        </div>
      )}

      {/* ── 学习时长趋势 + 热力图 ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="journal-card bg-gray-50 rounded-2xl shadow-sm border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="dashboard-module-icon w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
                <TrendingUp size={14} style={{ color: "var(--accent)" }} />
              </div>
              <div>
                <h2 className="dashboard-module-title text-sm font-semibold text-gray-900">学习时长趋势</h2>
                <p className="text-xs text-gray-400">单位：小时</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {period === "year" && (
                <div className="flex items-center gap-0.5">
                  <button onClick={() => setChartYear((y) => y - 1)}
                    className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 transition leading-none">‹</button>
                  <span className="text-xs text-gray-400 mx-1">{chartYear}年</span>
                  <button onClick={() => setChartYear((y) => y + 1)}
                    disabled={chartYear >= new Date().getFullYear()}
                    className={cn("w-6 h-6 flex items-center justify-center rounded-md transition leading-none",
                      chartYear >= new Date().getFullYear() ? "text-gray-200 cursor-not-allowed" : "hover:bg-gray-100 text-gray-500")}>›</button>
                </div>
              )}
              <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
                {(["week", "month", "year"] as Period[]).map((p) => (
                  <button key={p} onClick={() => setPeriod(p)}
                    className={cn("text-xs px-2.5 py-1 rounded-md transition font-medium",
                      period === p ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700")}>
                    {periodLabels[p]}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-4"><StudyLineChart data={periodData[period]} /></div>
        </div>

        <div className="journal-card bg-gray-50 rounded-2xl shadow-sm border border-gray-100 p-5">
          <StudyCalendar data={heatmapData} />
        </div>
      </div>

      {/* ── 第二行：今日任务 + 目标进度 ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* 今日任务 */}
        <TodayTasksPanel />

        {/* 目标进度 */}
        <div className="journal-card bg-gray-50 rounded-2xl shadow-sm border border-gray-100 p-5 flex flex-col h-[360px]">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="dashboard-module-icon w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
                <Target size={14} style={{ color: "var(--accent)" }} />
              </div>
              <h2 className="dashboard-module-title text-sm font-semibold text-gray-900">目标进度</h2>
            </div>
            <Link href="/work/goals" className="text-xs flex items-center gap-0.5 hover:underline" style={{ color: "var(--accent)" }}>
              全部 <ArrowRight size={11} />
            </Link>
          </div>
          <div className="goal-progress-scroll min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto pr-2">
            {goals.length === 0 && (
              <DashboardEmptyState
                kind="goal"
                title="暂无目标"
                description="去创建你的第一个学习目标吧！"
                href="/work/goals?create=1"
              />
            )}
            {goals.map((goal) => {
              const prog = progressMap[goal.id];
              const daysLeft = Math.max(0, Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / 86400000));
              const statusLabel: Record<string, string> = { active: "进行中", completed: "已完成", paused: "暂停", abandoned: "已放弃" };
              const taskProgress = prog && prog.total_tasks > 0 ? Math.round((prog.completed_tasks / prog.total_tasks) * 100) : 0;
              const deadlineDate = new Date(goal.deadline);
              const deadlineStr = `${deadlineDate.getMonth() + 1}月${deadlineDate.getDate()}日`;
              return (
                <Link key={goal.id} href={`/work/goals/${goal.id}`}
                  className="goal-progress-item group block w-full rounded-xl border border-transparent px-2.5 py-2 transition">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-gray-700 truncate flex-1 mr-2">{goal.title}</span>
                    <span className="relative flex-shrink-0 h-4 flex items-center">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full group-hover:invisible transition leading-none tabular-nums font-medium"
                        style={{ color: "var(--accent)" }}>
                        {statusLabel[goal.status] ?? goal.status}
                      </span>
                      <span className="absolute inset-0 flex items-center justify-center invisible group-hover:visible text-[10px] font-bold tabular-nums"
                        style={{ color: "var(--accent)" }}>
                        {taskProgress}%
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-2 rounded-full transition-all"
                        style={{ width: `${taskProgress}%`, backgroundColor: "var(--accent)" }} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-400">
                    <span>{prog ? `${prog.completed_tasks} / ${prog.total_tasks} 个任务` : `剩余 ${daysLeft} 天`}</span>
                    <span className="flex items-center gap-1.5">
                      {prog && prog.streak_days > 0 && (
                        <span className="flex items-center gap-0.5" title={`连续打卡 ${prog.streak_days} 天`}>
                          <Zap size={9} style={{ color: "var(--accent)" }} />
                          {prog.streak_days} 天
                        </span>
                      )}
                      {daysLeft > 0 && (
                        <>
                          <span className="group-hover:hidden">剩余 {daysLeft} 天</span>
                          <span className="hidden group-hover:inline">预计完成 {deadlineStr}</span>
                        </>
                      )}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── 今日时间规划 ── */}
      <DailySchedulePanel />

      </>)}

    </div>
    </main>
    </div>
  );
}
