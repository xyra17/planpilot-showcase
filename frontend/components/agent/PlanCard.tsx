"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight, Clock, BookOpen, RefreshCw, Dumbbell, Coffee } from "lucide-react";
import { cn } from "@/lib/utils";

interface PlanTask {
  day_offset: number;
  title: string;
  estimated_mins: number;
  type: "study" | "review" | "practice" | "rest";
  is_buffer?: boolean;
}

interface PlanWeek {
  week: number;
  goal: string;
  tasks: PlanTask[];
  milestone?: string | null;
}

interface PlanPhase {
  phase: number;
  title: string;
  start_day: number;
  end_day: number;
  goal: string;
  weeks: PlanWeek[];
}

interface Plan {
  summary?: { total_days: number; total_hours: number; phases: number };
  phases?: PlanPhase[];
  resource_hints?: string[];
}

const TASK_TYPE_STYLE: Record<string, { icon: React.ReactNode; cls: string }> = {
  study:    { icon: <BookOpen size={11} />,   cls: "bg-blue-50 text-blue-600" },
  review:   { icon: <RefreshCw size={11} />,  cls: "bg-purple-50 text-purple-600" },
  practice: { icon: <Dumbbell size={11} />,   cls: "bg-green-50 text-green-600" },
  rest:     { icon: <Coffee size={11} />,     cls: "bg-gray-50 text-gray-400" },
};

export function PlanCard({ plan }: { plan: Record<string, unknown> }) {
  const [expandedPhase, setExpandedPhase] = useState<number | null>(0);
  const p = plan as Plan;

  if (!p.phases?.length) return null;

  return (
    <div className="mt-3 rounded-xl border border-gray-200 overflow-hidden bg-white text-gray-900 w-full text-left">
      {p.summary && (
        <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex gap-4 text-xs text-gray-500">
          <span><strong className="text-gray-700">{p.summary.total_days}</strong> 天</span>
          <span><strong className="text-gray-700">{p.summary.total_hours}</strong> 学时</span>
          <span><strong className="text-gray-700">{p.summary.phases}</strong> 阶段</span>
        </div>
      )}

      <div className="divide-y divide-gray-100">
        {p.phases.map((phase, i) => (
          <div key={phase.phase}>
            <button
              className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 transition"
              onClick={() => setExpandedPhase(expandedPhase === i ? null : i)}>
              <div className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                style={{ backgroundColor: "var(--accent)" }}>
                {phase.phase}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{phase.title}</p>
                <p className="text-xs text-gray-400">第 {phase.start_day}–{phase.end_day} 天 · {phase.goal}</p>
              </div>
              {expandedPhase === i
                ? <ChevronDown size={14} className="text-gray-400 shrink-0" />
                : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
            </button>

            {expandedPhase === i && (
              <div className="px-4 pb-3 space-y-3 bg-gray-50/50">
                {(phase.weeks ?? []).map((week) => {
                  const realTasks = week.tasks.filter((t) => !t.is_buffer);
                  return (
                    <div key={week.week} className="pl-8">
                      <p className="text-xs font-medium text-gray-600 mb-1.5">
                        第 {week.week} 周 · {week.goal}
                      </p>
                      <div className="space-y-1">
                        {realTasks.slice(0, 5).map((task, ti) => {
                          const style = TASK_TYPE_STYLE[task.type] ?? TASK_TYPE_STYLE.study;
                          return (
                            <div key={ti} className="flex items-center gap-2 text-xs">
                              <span className={cn("px-1.5 py-0.5 rounded flex items-center gap-0.5 shrink-0", style.cls)}>
                                {style.icon}
                              </span>
                              <span className="truncate text-gray-700 flex-1">{task.title}</span>
                              <span className="text-gray-400 shrink-0 flex items-center gap-0.5">
                                <Clock size={9} />{task.estimated_mins}m
                              </span>
                            </div>
                          );
                        })}
                        {realTasks.length > 5 && (
                          <p className="text-xs text-gray-400 pl-5">+{realTasks.length - 5} 个任务</p>
                        )}
                      </div>
                      {week.milestone && (
                        <p className="text-xs text-green-600 mt-1.5 flex items-center gap-1">
                          <span>✓</span> {week.milestone}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {p.resource_hints && p.resource_hints.length > 0 && (
        <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50">
          <p className="text-xs text-gray-400 mb-1">推荐资料</p>
          <div className="flex flex-wrap gap-1">
            {p.resource_hints.map((hint, i) => (
              <span key={i} className="px-2 py-0.5 bg-white border border-gray-200 rounded text-xs text-gray-600">
                {hint}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
