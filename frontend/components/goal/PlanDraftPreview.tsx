"use client";

import { BookOpen, Check, ChevronDown, ChevronRight, Clock3, Loader2, RotateCcw, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";

export type PlanSourceRef = {
  source_key: string;
  item_id: string;
  item_title: string;
  content_version: number;
  chunk_id?: string | null;
  locator: string;
  snippet: string;
};

export type PlanExecutionGuide = {
  why_now: string;
  steps: string[];
  deliverable: string;
  done_criteria: string[];
  prerequisites: string[];
  source_refs: PlanSourceRef[];
};

export type MacroPlanDraft = {
  plan_id: string;
  status: "draft" | "active" | "cancelled" | "undone";
  goal_intent_version: number;
  phases: Array<{
    name: string;
    focus: string;
    days: number;
    start_date: string;
    end_date: string;
    tasks: Array<{
      title: string;
      objective: string;
      estimated_mins: number;
      type: string;
      scheduled_date: string;
      execution_guide: PlanExecutionGuide;
    }>;
  }>;
  total_tasks: number;
  start_date: string;
  estimated_completion_date: string;
  source_summary: {
    mode: string;
    items_read: number;
    excerpts_read: number;
    excerpts_cited: number;
  };
  replacement_summary: {
    current_plan_id?: string | null;
    pending_tasks_to_replace: number;
    completed_tasks_preserved: boolean;
  };
};

function shortDate(value: string) {
  if (!value) return "待安排";
  const date = new Date(`${value}T00:00:00`);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export default function PlanDraftPreview({
  draft,
  goalTitle,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  draft: MacroPlanDraft;
  goalTitle: string;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set(["0-0"]));
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, onCancel]);

  const replaceCount = draft.replacement_summary?.pending_tasks_to_replace ?? 0;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="goal-plan-draft-backdrop" onMouseDown={busy ? undefined : onCancel}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-plan-draft-title"
        className="goal-plan-draft-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="goal-plan-draft-header">
          <div>
            <small>PLAN DRAFT · 尚未写入今日任务</small>
            <h2 id="goal-plan-draft-title">确认「{goalTitle}」的行动计划</h2>
            <p>先检查为什么做、怎么做和如何验收。只有采用后，任务才会进入每日安排。</p>
          </div>
          <button type="button" aria-label="放弃计划草案" disabled={busy} onClick={onCancel}><X size={18} /></button>
        </header>

        <div className="goal-plan-draft-facts">
          <span><Clock3 size={15} /><strong>{draft.total_tasks}</strong> 个行动 · {shortDate(draft.start_date)}—{shortDate(draft.estimated_completion_date)}</span>
          <span><BookOpen size={15} />已阅读 {draft.source_summary?.items_read ?? 0} 份资料、引用 {draft.source_summary?.excerpts_cited ?? 0} 个片段</span>
          <span><RotateCcw size={15} />采用后替换 {replaceCount} 个未完成旧任务；完成记录保留</span>
        </div>

        <div className="goal-plan-draft-phases">
          {draft.phases.map((phase, phaseIndex) => (
            <section className="goal-plan-draft-phase" key={`${phase.name}-${phaseIndex}`}>
              <header>
                <span>{phaseIndex + 1}</span>
                <div><h3>{phase.name}</h3><p>{phase.focus}</p></div>
                <small>{shortDate(phase.start_date)}—{shortDate(phase.end_date)}</small>
              </header>
              <div>
                {phase.tasks.map((task, taskIndex) => {
                  const key = `${phaseIndex}-${taskIndex}`;
                  const expanded = expandedTasks.has(key);
                  const guide = task.execution_guide;
                  return (
                    <article className="goal-plan-draft-task" key={key}>
                      <button
                        type="button"
                        className="goal-plan-draft-task-trigger"
                        aria-expanded={expanded}
                        onClick={() => setExpandedTasks((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key); else next.add(key);
                          return next;
                        })}
                      >
                        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        <span><strong>{task.title}</strong><small>{task.objective}</small></span>
                        <em>{shortDate(task.scheduled_date)} · {task.estimated_mins} 分钟</em>
                      </button>
                      {expanded && (
                        <div className="goal-plan-draft-task-detail">
                          <dl>
                            <div><dt>为什么现在做</dt><dd>{guide.why_now}</dd></div>
                            <div><dt>怎么执行</dt><dd><ol>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol></dd></div>
                            <div><dt>本次产出</dt><dd>{guide.deliverable}</dd></div>
                            <div><dt>完成标准</dt><dd><ul>{guide.done_criteria.map((criterion) => <li key={criterion}><Check size={13} />{criterion}</li>)}</ul></dd></div>
                          </dl>
                          {guide.source_refs.length > 0 && (
                            <div className="goal-plan-draft-sources">
                              <strong>依据资料</strong>
                              {guide.source_refs.map((source) => <span key={source.source_key} title={source.snippet}>{source.locator}</span>)}
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        {error && <p className="goal-plan-draft-error" role="alert">{error}</p>}
        <footer className="goal-plan-draft-actions">
          <button type="button" disabled={busy} onClick={onCancel}>放弃草案</button>
          <button type="button" disabled={busy} onClick={onConfirm}>
            {busy ? <><Loader2 size={15} className="animate-spin" />正在写入并回读…</> : <><Check size={15} />采用并写入任务</>}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
