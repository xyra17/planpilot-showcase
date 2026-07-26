"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  CheckCircle2, Circle, Clock, ArrowRight,
  Sparkles, RotateCcw, TrendingUp, Brain, Zap, Target, BookOpen,
  Plus, Trash2, Pencil, Check, X, Search,
  Calendar, Wand2, LayoutList, BarChart3, CalendarCheck, Loader2, Activity, ChevronDown,
} from "lucide-react";
import { api } from "@/lib/api";
import { useTasks, type Priority } from "@/lib/tasks-context";
import { useGoalStore } from "@/lib/stores/goalStore";
import { useAuthStore } from "@/lib/stores/authStore";
import { CheckinForm } from "@/components/agent/CheckinForm";
import { DailyPlanModal } from "@/components/agent/DailyPlanModal";
import { cn } from "@/lib/utils";

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
            {today && <text x={p.x} y={H - 7} textAnchor="middle" fontSize="9" fill="var(--accent,#2563eb)">今天</text>}
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

  // 标准月历：7 个星期列 × 最多 6 行，完整保留月初和月末日期
  const cells = Array.from({ length: 42 }, (_, i) => {
    const day = i - firstDowMon + 1;
    if (day < 1 || day > daysInMonth) return null;
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return { dateStr, minutes: dataMap[dateStr] ?? 0, isToday: dateStr === TODAY };
  });

  return (
    <div>
      <div className="flex items-center mb-3">
        <div className="flex items-center gap-2 flex-1">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
            <Activity size={14} style={{ color: "var(--accent)" }} />
          </div>
          <div className="text-sm font-semibold text-gray-900">学习热力图</div>
        </div>
        <div className="flex items-center gap-0.5">
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
        <div className="flex-1" />
      </div>

      <div>
        <div className="mb-1.5 grid grid-cols-7 gap-1.5">
          {WEEK_ROW_LABELS.map((label) => (
            <div key={label} className="text-center text-[10px] text-gray-400">
              {label.replace("星期", "周")}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1.5">
          {cells.map((cell, index) => {
            const mins = cell?.minutes ?? 0;
            const day = cell ? Number(cell.dateStr.slice(-2)) : null;
            return (
              <div
                key={cell?.dateStr ?? `empty-${index}`}
                title={cell ? `${cell.dateStr} · ${mins} 分钟` : ""}
                className={cn(
                  "relative flex h-8 min-w-0 items-center justify-center rounded-md text-[10px] transition",
                  cell ? "text-gray-600" : "pointer-events-none"
                )}
                style={cell ? {
                  backgroundColor: heatColor(mins),
                  outline: cell.isToday ? "1.5px solid var(--accent)" : undefined,
                  outlineOffset: cell.isToday ? 1 : undefined,
                  color: mins >= 60 ? "white" : undefined,
                } : undefined}
              >
                {day}
                {cell?.isToday && (
                  <span className="absolute bottom-0.5 right-1 text-[7px] font-semibold" style={{ color: mins >= 60 ? "white" : "var(--accent)" }}>
                    今
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-1.5 mt-3">
        <span className="text-xs text-gray-400">学习时长（少）</span>
        {HEAT_COLORS.map((c, i) => <div key={i} style={{ width: 12, height: 12, backgroundColor: c, borderRadius: 3 }} />)}
        <span className="text-xs text-gray-400">学习时长（多）</span>
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

  useEffect(() => {
    if (!newGoalId && goals.length > 0) setNewGoalId(goals[0].id);
  }, [goals, newGoalId]);

  return (
    <div className="journal-receipt bg-gray-50 rounded-2xl shadow-sm border border-gray-100 p-5 flex flex-col h-[360px]">
      {/* 面板头 */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
            {panelTab === "tasks"
              ? <CheckCircle2 size={14} style={{ color: "var(--accent)" }} />
              : <CalendarCheck size={14} style={{ color: "var(--accent)" }} />}
          </div>
          <div className="flex items-center gap-0">
            <button onClick={() => setPanelTab("tasks")}
              className={cn("text-sm font-semibold px-0.5 pb-0.5 border-b-2 transition",
                panelTab === "tasks" ? "" : "border-transparent text-gray-400 hover:text-gray-700")}
              style={panelTab === "tasks" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}>
              今日任务
            </button>
            <span className="text-gray-200 mx-2 text-sm select-none">/</span>
            <button onClick={() => setPanelTab("checkin")}
              className={cn("text-sm font-semibold px-0.5 pb-0.5 border-b-2 transition",
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
              完成度：{checkinRate}%
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
              <div key={task.id} className="group flex items-start gap-2 px-2 py-2 rounded-xl hover:bg-gray-50 transition">
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
              tasks={todayTasks.map((t) => ({ id: t.id, title: t.title, estimated_mins: t.estimatedMinutes, status: t.done ? "completed" : "pending" }))}
              onRateChange={setCheckinRate}
            />
          ) : (
            <div className="py-10 text-center">
              <p className="text-xs text-gray-400 mb-2">暂无进行中的目标</p>
              <Link href="/dashboard/goals/new" className="text-xs font-medium hover:underline" style={{ color: "var(--accent)" }}>
                去创建目标 →
              </Link>
            </div>
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

const AI_SLOTS = [
  { key: "m", startHour: 9, hours: 2 },
  { key: "a", startHour: 14, hours: 2 },
  { key: "e", startHour: 20, hours: 1.5 },
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
  const { goals, currentGoalId } = useGoalStore();

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

  const addBlock = useCallback(() => {
    const id = String(Date.now());
    const newB: TimeBlock = {
      id, label: "新时间块", startHour: 10, durationMinutes: 60, progress: 0,
      color: THEME_BLOCK_COLORS[blocks.length % THEME_BLOCK_COLORS.length],
    };
    setBlocks((prev) => [...prev, newB]);
    setSelectedId(id);
    setDraft({ label: newB.label, startStr: hourToStr(newB.startHour), durationMinutes: newB.durationMinutes, color: newB.color, progress: 0 });
  }, [blocks.length]);

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
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: "var(--accent-light)" }}>
            <Calendar size={14} style={{ color: "var(--accent)" }} />
          </div>
          <span className="text-sm font-semibold text-gray-900">今日时间规划</span>
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
                              <button onClick={() => updateSlotHour(key, Math.max(0.5, +(slotHours[key] - 0.5).toFixed(1)))}
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
            <div className="h-44 overflow-y-scroll space-y-1.5 pr-1">
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
                            className="flex-1 min-w-28 px-2.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-blue-400" />
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
                  className="flex-1 min-w-28 px-2.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-blue-400" />
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
  insight: string;
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

export default function DashboardPage() {
  const { tasks, refresh } = useTasks();
  const { goals, fetchGoals } = useGoalStore();
  const { user } = useAuthStore();
  const todayTasks = tasks.filter((t) => t.date === TODAY);
  const [period, setPeriod] = useState<Period>("week");
  const [chartYear, setChartYear] = useState(new Date().getFullYear());
  const [briefOpen, setBriefOpen] = useState(false);
  const [activeReview, setActiveReview] = useState<string | null>(null);
  const [dailyBrief, setDailyBrief] = useState<DailyBrief | null>(null);
  const [briefLoaded, setBriefLoaded] = useState(false);
  const [goalCounts, setGoalCounts] = useState<Record<string, number>>({});
  const [progressMap, setProgressMap] = useState<Record<string, GoalProgressData>>({});
  const [refreshingGoals, setRefreshingGoals] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showDailyPlanModal, setShowDailyPlanModal] = useState(false);

  useEffect(() => {
    const last = localStorage.getItem("lastPlanDate");
    if (last !== TODAY) setShowDailyPlanModal(true);
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
    api.get<DailyBrief | null>("/api/v1/agent/daily-brief")
      .then((d) => setDailyBrief(d ?? null))
      .catch(() => {})
      .finally(() => setBriefLoaded(true));
  }, [user?.username]); // eslint-disable-line react-hooks/exhaustive-deps

  const getGoalCount = useCallback((goalId: string, fallback: number) => goalCounts[goalId] ?? fallback, [goalCounts]);

  const refreshGoal = useCallback(async (goalId: string, count: number) => {
    setRefreshingGoals((prev) => new Set(prev).add(goalId));
    try {
      const gr = await api.get<GoalReview | null>(`/api/v1/agent/daily-brief/goal/${goalId}?count=${count}`);
      if (gr) {
        setDailyBrief((prev) => prev ? {
          ...prev,
          goalReviews: prev.goalReviews.map((r) => r.goalId === goalId ? gr : r),
        } : prev);
      }
    } catch { /* ignore */ } finally {
      setRefreshingGoals((prev) => { const s = new Set(prev); s.delete(goalId); return s; });
    }
  }, []);

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

  return (
    <div className="calm-dashboard p-5 sm:p-8 space-y-6">
      {/* ── 欢迎 + 统计条 ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-6">
        <div>
          <p className="calm-eyebrow hidden mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">Your learning rhythm</p>
          <h1 className="calm-heading text-2xl font-bold text-gray-900">{getGreeting()}，{username} 👋</h1>
          <p className="text-sm text-gray-500 mt-1">{TODAY} · 今日任务 {done}/{todayTasks.length}</p>
        </div>
        <div className="flex items-center gap-2 sm:gap-2.5 flex-wrap sm:flex-nowrap sm:flex-shrink-0">
          {[
            { label: "本周时长", value: `${weekTotal}h`,                  icon: Clock        },
            { label: "进行目标", value: `${activeGoalsCount} 个`,          icon: TrendingUp   },
            { label: "今日完成", value: `${done}/${todayTasks.length}`,    icon: CheckCircle2 },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="calm-stat rounded-2xl px-4 py-3 text-center min-w-[84px]">
              <div className="calm-stat-icon w-7 h-7 rounded-xl flex items-center justify-center mx-auto mb-1.5" style={{ backgroundColor: "var(--accent-light)" }}>
                <Icon size={14} style={{ color: "var(--accent)" }} />
              </div>
              <div className="text-sm font-bold text-gray-900 leading-tight">{value}</div>
              <div className="text-xs text-gray-400 mt-0.5">{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── AI 每日简报 ── */}
      {briefLoaded && !dailyBrief && (
        <div className="brief-card rounded-2xl p-5 relative overflow-hidden opacity-60">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "rgba(255,255,255,0.2)" }}><Sparkles size={14} className="text-white" /></div>
            <span className="text-sm font-semibold text-white">AI 每日简报</span>
          </div>
          <p className="text-sm text-white/75">暂无简报，完成首次 Check-in 后生成</p>
        </div>
      )}
      {dailyBrief && (
        <div className="brief-card rounded-2xl p-5 relative overflow-hidden">
          <div className="absolute -top-6 -right-6 w-32 h-32 rounded-full pointer-events-none" style={{ background: "rgba(255,255,255,0.07)" }} />
          <div className="absolute -bottom-8 -right-16 w-48 h-48 rounded-full pointer-events-none" style={{ background: "rgba(255,255,255,0.05)" }} />
          <div className="relative flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "rgba(255,255,255,0.2)" }}><Sparkles size={14} className="text-white" /></div>
              <span className="text-sm font-semibold text-white">AI 每日简报</span>
              <span className="text-xs px-2 py-0.5 rounded-full text-white/80" style={{ background: "rgba(255,255,255,0.18)" }}>基于昨日生成</span>
            </div>
            <button onClick={() => setBriefOpen((v) => !v)} className="text-white/70 hover:text-white transition text-xs px-2.5 py-1 rounded-lg" style={{ background: "rgba(255,255,255,0.15)" }}>
              {briefOpen ? "收起" : "展开"}
            </button>
          </div>
          <p className="relative text-sm text-white/90 leading-relaxed mb-3">{dailyBrief.summary}</p>
          {dailyBrief.recommendedAction && (
            <div className="relative flex items-center gap-2 mb-3 rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.15)" }}>
              <TrendingUp size={12} className="text-white/70 flex-shrink-0" />
              <span className="text-xs text-white/90">{dailyBrief.recommendedAction}</span>
            </div>
          )}
          {briefOpen && (
            <div className="relative -mx-5 px-5 pb-5 -mb-5 mt-3 rounded-b-2xl bg-white">
              <div className="flex items-center gap-2 pt-3 pb-3 border-t" style={{ borderColor: "var(--accent-muted)" }}>
                <button onClick={() => refreshReview()} disabled={isRefreshing}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg disabled:opacity-40 transition flex-shrink-0"
                  style={{ background: "var(--accent-light)", color: "var(--accent)" }}>
                  <RotateCcw size={11} className={isRefreshing ? "animate-spin" : ""} />
                  {isRefreshing ? "生成中..." : "换一批"}
                </button>
                <span className="text-sm font-semibold text-gray-800">10 分钟快速复习</span>
              </div>
              <div className="space-y-3">
                {(dailyBrief.goalReviews ?? []).map((gr) => (
                  <div key={gr.goalId} className="rounded-xl overflow-hidden border" style={{ borderColor: "var(--border-subtle)" }}>
                    {/* 目标标题行 */}
                    <div className="px-3 py-2 flex items-center justify-between" style={{ background: "var(--accent-light)" }}>
                      <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--accent-dark)" }}>
                        <Target size={11} className="flex-shrink-0" />
                        {gr.goalTitle}
                      </div>
                      <div className="flex items-center gap-1">
                        <div className="flex items-center gap-0.5 rounded-lg overflow-hidden" style={{ background: "var(--accent-muted)" }} title="调整本目标复习题数量">
                          <button
                            onClick={() => { const n = Math.max(1, getGoalCount(gr.goalId, gr.questions.length) - 1); setGoalCounts((p) => ({ ...p, [gr.goalId]: n })); }}
                            disabled={refreshingGoals.has(gr.goalId) || getGoalCount(gr.goalId, gr.questions.length) <= 1}
                            className="w-5 h-5 flex items-center justify-center hover:bg-black/10 disabled:opacity-30 transition text-sm leading-none"
                            style={{ color: "var(--accent-dark)" }}>−</button>
                          <span className="text-xs font-semibold w-5 text-center tabular-nums" style={{ color: "var(--accent-dark)" }}>
                            {refreshingGoals.has(gr.goalId)
                              ? <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin" style={{ borderColor: "var(--accent-muted)", borderTopColor: "var(--accent)" }} />
                              : getGoalCount(gr.goalId, gr.questions.length)}
                          </span>
                          <button
                            onClick={() => { const n = Math.min(10, getGoalCount(gr.goalId, gr.questions.length) + 1); setGoalCounts((p) => ({ ...p, [gr.goalId]: n })); }}
                            disabled={refreshingGoals.has(gr.goalId) || getGoalCount(gr.goalId, gr.questions.length) >= 10}
                            className="w-5 h-5 flex items-center justify-center hover:bg-black/10 disabled:opacity-30 transition text-sm leading-none"
                            style={{ color: "var(--accent-dark)" }}>+</button>
                        </div>
                        {goalCounts[gr.goalId] !== undefined && goalCounts[gr.goalId] !== gr.questions.length && !refreshingGoals.has(gr.goalId) && (
                          <button onClick={() => refreshGoal(gr.goalId, goalCounts[gr.goalId])}
                            className="w-5 h-5 rounded-md flex items-center justify-center text-xs transition"
                            style={{ background: "var(--accent)", color: "white" }} title="确认并重新生成">✓</button>
                        )}
                      </div>
                    </div>
                    {/* 题目网格 */}
                    <div className="p-3 grid grid-cols-1 sm:grid-cols-3 gap-2 bg-white">
                      {gr.questions.map((q) => (
                        <button key={q.id} onClick={() => setActiveReview(activeReview === q.id ? null : q.id)}
                          className="hover:bg-gray-50 transition rounded-xl p-3 text-left border"
                          style={{ borderColor: "var(--border-subtle)", background: activeReview === q.id ? "var(--accent-light)" : "var(--surface)" }}>
                          <div className="flex items-start gap-1.5 mb-1">
                            <Zap size={11} className="flex-shrink-0 mt-0.5" style={{ color: "var(--accent)" }} />
                            <div className="text-xs font-semibold leading-tight" style={{ color: "var(--text-1)" }}>{q.question}</div>
                          </div>
                          {activeReview === q.id
                            ? <div className="text-xs leading-relaxed mt-1 border-t pt-1.5" style={{ color: "var(--text-2)", borderColor: "var(--accent-muted)" }}>{q.hint}</div>
                            : <div className="text-xs" style={{ color: "var(--text-3)" }}>点击查看提示</div>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {dailyBrief.goalReviews.length === 0 && (
                  <p className="text-xs pb-2" style={{ color: "var(--text-2)" }}>昨日暂无已完成任务，完成任务后次日生成复习题</p>
                )}
              </div>
              <div className="mt-3 pb-1 flex items-center gap-2 text-xs" style={{ color: "var(--text-2)" }}><Brain size={12} /> {dailyBrief.insight}</div>
            </div>
          )}
        </div>
      )}

      {/* ── 学习时长趋势 + 热力图 ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="journal-card bg-gray-50 rounded-2xl shadow-sm border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
                <TrendingUp size={14} style={{ color: "var(--accent)" }} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">学习时长趋势</h2>
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
              <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
                <Target size={14} style={{ color: "var(--accent)" }} />
              </div>
              <h2 className="text-sm font-semibold text-gray-900">目标进度</h2>
            </div>
            <Link href="/dashboard/goals" className="text-xs flex items-center gap-0.5 hover:underline" style={{ color: "var(--accent)" }}>
              全部 <ArrowRight size={11} />
            </Link>
          </div>
          <div className="space-y-3 flex-1 overflow-y-auto min-h-0">
            {goals.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-6">暂无目标，去创建一个吧</p>
            )}
            {goals.map((goal) => {
              const prog = progressMap[goal.id];
              const daysLeft = Math.max(0, Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / 86400000));
              const statusLabel: Record<string, string> = { active: "进行中", completed: "已完成", paused: "暂停", abandoned: "已放弃" };
              const taskProgress = prog && prog.total_tasks > 0 ? Math.round((prog.completed_tasks / prog.total_tasks) * 100) : 0;
              const deadlineDate = new Date(goal.deadline);
              const deadlineStr = `${deadlineDate.getMonth() + 1}月${deadlineDate.getDate()}日`;
              return (
                <Link key={goal.id} href={`/dashboard/goals/${goal.id}`}
                  className="group block rounded-xl px-2.5 py-2 hover:bg-gray-50 transition -mx-1">
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
                    <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-1 rounded-full transition-all"
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

      {showDailyPlanModal && (
        <DailyPlanModal onClose={() => setShowDailyPlanModal(false)} />
      )}
    </div>
  );
}
