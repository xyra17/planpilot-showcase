"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleDot,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";

import type {
  AgentActionApproval,
  AgentActionOperation,
  AgentActionRun,
} from "@/lib/technology/productApi";
import { GoalDeadlineChangeCard } from "@/components/technology/companion/GoalDeadlineChangeCard";

export const ACTIVE_ACTION_STATUSES = new Set<AgentActionRun["status"]>([
  "queued",
  "executing",
  "retrying",
  "replanning",
  "compensating",
]);

const ACTION_STATUS_LABEL: Record<AgentActionRun["status"], string> = {
  queued: "正在建立行动计划",
  executing: "正在分析与准备方案",
  waiting_approval: "等你确认",
  retrying: "正在重试",
  replanning: "正在重新规划",
  paused: "已暂停",
  completed: "已完成",
  failed: "未完成",
  rejected: "未执行变更",
  cancelled: "已取消",
  compensating: "正在恢复原状",
  rolled_back: "已撤销",
};

const ACTION_FIELD_LABEL: Record<string, string> = {
  deadline: "目标截止日期",
  scheduled_date: "排期调整",
  status: "状态",
  daily_hours: "每日计划投入",
  __create__: "新建任务",
  __delete__: "删除任务",
  __upsert__: "记录打卡",
};

const formatActionDate = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [, month, day] = value.split("-").map(Number);
  return `${month}月${day}日`;
};

const formatOperationValue = (operation: AgentActionOperation) => {
  if (operation.field === "scheduled_date") {
    const before = formatActionDate(operation.before);
    const after = formatActionDate(operation.after);
    if (before && after) return `原定 ${before} → 调整至 ${after}`;
    if (after) return `安排在 ${after}`;
  }
  if (operation.field === "deadline") {
    const before = formatActionDate(operation.before);
    const after = formatActionDate(operation.after);
    if (before && after) return `原截止 ${before} → 调整至 ${after}`;
    if (after) return `截止 ${after}`;
  }
  return null;
};

const actionValue = (value: unknown) => {
  if (value == null) return "无";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && value && "title" in value) {
    return String((value as { title?: unknown }).title ?? "任务");
  }
  if (typeof value === "object" && value && "completion_rate" in value) {
    const rate = Number((value as { completion_rate?: unknown }).completion_rate ?? 0);
    return `完成度 ${Math.round(rate * 100)}%`;
  }
  return "已记录";
};

function ActionOperationRow({ operation }: { operation: AgentActionOperation }) {
  const isCreate = operation.field === "__create__";
  const isDelete = operation.field === "__delete__";
  const fieldLabel = operation.field === "__create__" && operation.entity === "goal"
    ? "新建目标"
    : ACTION_FIELD_LABEL[operation.field] ?? operation.field;
  const formattedValue = formatOperationValue(operation);
  return (
    <li>
      <span>{operation.label}</span>
      <small>{fieldLabel}</small>
      <p>
        {isCreate
          ? `将创建：${actionValue(operation.after)}`
          : isDelete
            ? "将删除这项内容"
            : formattedValue || `${actionValue(operation.before)} → ${actionValue(operation.after)}`}
      </p>
    </li>
  );
}

export function ActionRunCard({
  run,
  busy,
  onApprove,
  onReject,
  onCancel,
  onRetry,
  onUndo,
}: {
  run: AgentActionRun;
  busy: boolean;
  onApprove: (approval: AgentActionApproval, highRiskConfirmed: boolean) => void;
  onReject: (approval: AgentActionApproval) => void;
  onCancel: () => void;
  onRetry: () => void;
  onUndo: () => void;
}) {
  const [highRiskConfirmed, setHighRiskConfirmed] = useState(false);
  const approval = [...run.approvals].reverse().find((item) => item.status === "pending");
  const operations = approval?.change_set.operations ?? [];
  const warnings = approval?.change_set.warnings ?? [];
  const isHighRisk = approval?.policy_decision.risk === "high";
  const completedSteps = run.steps.filter((step) => step.status === "completed").length;
  const totalSteps = Math.max(run.steps.length, run.plan.length, 1);
  const progress = Math.min(100, Math.round((completedSteps / totalSteps) * 100));
  const latestEvent = run.events.at(-1)?.summary;
  const isDeadlineConflict = run.result?.reason_code === "deadline_conflict";
  const statusLabel = isDeadlineConflict ? "需要调整期限" : ACTION_STATUS_LABEL[run.status];

  return (
    <section className={`companion-action-run is-${run.status}${isDeadlineConflict ? " is-deadline-conflict" : ""}`} aria-label="Pilo 行动任务">
      <header>
        <div>
          <small><CircleDot size={12} /> 行动任务</small>
          <h3>{approval?.change_set.summary || run.result?.summary || statusLabel}</h3>
        </div>
        <span className={`is-${run.status}`}><i />{statusLabel}</span>
      </header>

      {ACTIVE_ACTION_STATUSES.has(run.status) && (
        <div className="companion-action-progress">
          <span style={{ width: `${progress}%` }} />
          <p>{latestEvent || `已完成 ${completedSteps}/${totalSteps} 个步骤`}</p>
        </div>
      )}

      {run.status === "waiting_approval" && approval && (
        <>
          <p className="companion-action-boundary"><ShieldCheck size={13} />以下只是预览，确认前不会修改你的学习数据。</p>
          {operations.length ? (
            <ul className="companion-action-operations">
              {operations.slice(0, 8).map((operation) => <ActionOperationRow operation={operation} key={operation.operation_id} />)}
            </ul>
          ) : <p className="companion-action-empty">这次没有生成可执行的变更，可以保留原计划后换一种说法。</p>}
          {!!warnings.length && <div className="companion-action-warnings">{warnings.map((warning) => <span key={warning}><AlertTriangle size={12} />{warning}</span>)}</div>}
          {isHighRisk && (
            <label className="companion-action-risk-confirm">
              <input type="checkbox" checked={highRiskConfirmed} onChange={(event) => setHighRiskConfirmed(event.target.checked)} />
              <span>我已核对高风险提示，仍要执行</span>
            </label>
          )}
        </>
      )}

      {isDeadlineConflict && <GoalDeadlineChangeCard run={run} />}

      {run.error && !isDeadlineConflict && <p className="companion-action-error">{run.error}</p>}

      {!isDeadlineConflict && <footer>
        {run.status === "waiting_approval" && approval && (
          <>
            <button type="button" className="is-quiet" disabled={busy} onClick={() => onReject(approval)}>暂不执行</button>
            <button type="button" className="is-primary" disabled={busy || !operations.length || (isHighRisk && !highRiskConfirmed)} onClick={() => onApprove(approval, highRiskConfirmed)}><Check size={14} />确认执行</button>
          </>
        )}
        {ACTIVE_ACTION_STATUSES.has(run.status) && <button type="button" className="is-quiet" disabled={busy} onClick={onCancel}>取消行动</button>}
        {run.status === "failed" && <button type="button" className="is-primary" disabled={busy} onClick={onRetry}><RefreshCw size={14} />重试</button>}
        {run.status === "completed" && run.result?.undo_available && <button type="button" className="is-quiet" disabled={busy} onClick={onUndo}><RotateCcw size={14} />撤销这次修改</button>}
        {["completed", "rejected", "cancelled", "rolled_back"].includes(run.status) && <span><CheckCircle2 size={13} />{ACTION_STATUS_LABEL[run.status]}</span>}
      </footer>}
    </section>
  );
}
