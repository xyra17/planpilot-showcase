"use client";

import {
  ArrowRight,
  CalendarClock,
  FileSearch,
  Gauge,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";

import { buildPiloCoachHref } from "@/lib/technology/piloCoachRoute";
import type { AgentActionAlternative, AgentActionRun } from "@/lib/technology/productApi";

const FALLBACK_ALTERNATIVES: AgentActionAlternative[] = [
  {
    id: "preview_goal_deadline_extension",
    label: "延长目标期限",
    description: "先调整目标截止日期，再让 Pilo 根据新的时间范围生成计划。",
  },
  {
    id: "rebuild_within_deadline",
    label: "保持期限，减量重建",
    description: "保留当前截止日期，减少、拆分或重排任务后再生成可执行方案。",
  },
  {
    id: "analyze_deadline_risk_only",
    label: "只查看期限风险",
    description: "不修改任何数据，只分析剩余时间、积压量和延期影响。",
  },
];

const ALTERNATIVE_ICONS = {
  preview_goal_deadline_extension: CalendarClock,
  rebuild_within_deadline: Gauge,
  analyze_deadline_risk_only: FileSearch,
} as const;

function alternativeIcon(id: string) {
  return ALTERNATIVE_ICONS[id as keyof typeof ALTERNATIVE_ICONS] ?? ArrowRight;
}

export function GoalDeadlineChangeCard({ run }: { run: AgentActionRun }) {
  const alternatives = run.result?.alternatives?.length
    ? run.result.alternatives
    : FALLBACK_ALTERNATIVES;
  const rebuildHref = buildPiloCoachHref({
    intent: "rebuild-within-deadline",
    surface: "goals",
    goalId: run.goal_id ?? undefined,
    prompt: "请保留当前目标截止日期，分析现有任务量后，通过减少、拆分或重排任务生成一份可执行的调整预览。任何修改都要等我确认后再执行。",
  });
  const riskHref = buildPiloCoachHref({
    intent: "analyze-deadline-risk",
    surface: "goals",
    goalId: run.goal_id ?? undefined,
    prompt: "请只分析当前目标的期限风险，包括剩余时间、任务积压、每日所需投入和可能延期的部分。不要生成或执行任何数据变更。",
  });

  return (
    <section className="companion-deadline-card" aria-labelledby={`deadline-conflict-${run.id}`}>
      <div className="companion-deadline-boundary">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>安全审查已停止本次行动，没有修改任何目标或任务。</span>
      </div>

      <div className="companion-deadline-heading">
        <CalendarClock size={19} aria-hidden="true" />
        <div>
          <h4 id={`deadline-conflict-${run.id}`}>选择一种更稳妥的继续方式</h4>
          <p>当前计划超出了目标期限。你可以先调整期限，也可以保留期限并缩小计划。</p>
        </div>
      </div>

      <ul className="companion-deadline-options">
        {alternatives.map((alternative) => {
          const Icon = alternativeIcon(alternative.id);
          return (
            <li key={alternative.id}>
              <Icon size={16} aria-hidden="true" />
              <div>
                <strong>{alternative.label}</strong>
                <span>{alternative.description}</span>
              </div>
            </li>
          );
        })}
      </ul>

      <nav className="companion-deadline-actions" aria-label="期限冲突后续操作">
        {run.goal_id && (
          <Link className="is-primary" href={`/studio/work/goals/${encodeURIComponent(run.goal_id)}/edit`}>
            调整目标期限<ArrowRight size={14} aria-hidden="true" />
          </Link>
        )}
        <Link className={run.goal_id ? "is-secondary" : "is-primary"} href={rebuildHref}>
          保持期限重新规划
        </Link>
        <Link className="is-text" href={riskHref}>只分析风险</Link>
      </nav>
    </section>
  );
}
