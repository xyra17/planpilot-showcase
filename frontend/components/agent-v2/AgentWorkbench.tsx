"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Check,
  ChevronRight,
  Circle,
  History,
  Loader2,
  PauseCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useGoalStore } from "@/lib/stores/goalStore";
import { useToast } from "@/components/ui/Toast";

type Operation = {
  entity_id: string;
  label: string;
  field: string;
  before: string;
  after: string;
  reason: string;
};

type Approval = {
  id: string;
  status: string;
  change_hash: string;
  change_set: { summary: string; operations: Operation[]; warnings: string[] };
};

type Step = {
  id: string;
  index: number;
  agent_role: string;
  tool_name: string;
  status: string;
  risk: string;
  output?: Record<string, unknown>;
  error?: string;
};

type AgentRun = {
  id: string;
  request: string;
  plan: Array<{ title: string }>;
  status: string;
  current_step: number;
  failure_count: number;
  objective: {
    constraints?: { time_granularity_note?: string | null };
  };
  result?: { summary?: string; undo_available?: boolean };
  error?: string;
  created_at: string;
  steps: Step[];
  approvals: Approval[];
};

const roleLabel: Record<string, string> = {
  main: "主 Agent",
  learning_analyst: "学习分析 Agent",
  schedule_optimizer: "日程优化 Agent",
  knowledge_researcher: "知识检索 Agent",
  plan_reviewer: "计划审查 Agent",
};

const statusLabel: Record<string, string> = {
  planning: "规划中",
  running: "执行中",
  waiting_approval: "等待确认",
  completed: "已完成",
  failed: "失败",
  rejected: "已拒绝",
  cancelled: "已取消",
  undone: "已撤销",
  paused: "已暂停",
  pending: "等待执行",
  waiting_approval_step: "等待确认",
};

function StepIcon({ status }: { status: string }) {
  if (status === "completed") return <Check size={15} />;
  if (status === "running") return <Loader2 size={15} className="animate-spin" />;
  if (status === "waiting_approval") return <PauseCircle size={15} />;
  if (status === "failed") return <X size={15} />;
  return <Circle size={13} />;
}

export default function AgentWorkbench() {
  const { goals, fetchGoals } = useGoalStore();
  const { showToast } = useToast();
  const [request, setRequest] = useState(
    "检查我最近两周的执行情况，把落后的任务重新安排到下周。周三晚上不要排任务，修改前让我确认。"
  );
  const [goalId, setGoalId] = useState("");
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);

  const loadRuns = useCallback(async () => {
    const rows = await api.get<AgentRun[]>("/api/v2/agent/runs");
    setRuns(rows);
    setSelectedId((current) => current ?? rows[0]?.id ?? null);
  }, []);

  const loadRun = useCallback(async (id: string) => {
    const detail = await api.get<AgentRun>(`/api/v2/agent/runs/${id}`);
    setRun(detail);
    return detail;
  }, []);

  useEffect(() => {
    fetchGoals();
    loadRuns().catch(() => undefined);
  }, [fetchGoals, loadRuns]);

  useEffect(() => {
    if (selectedId) loadRun(selectedId).catch(() => undefined);
  }, [selectedId, loadRun]);

  useEffect(() => {
    if (!run || !["planning", "running"].includes(run.status)) return;
    const timer = window.setInterval(() => {
      loadRun(run.id).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [run, loadRun]);

  const pendingApproval = useMemo(
    () => run?.approvals.find((item) => item.status === "pending"),
    [run]
  );

  async function createAgentRun() {
    if (request.trim().length < 2) return;
    setBusy(true);
    try {
      const created = await api.post<AgentRun>("/api/v2/agent/runs", {
        request: request.trim(),
        goal_id: goalId || null,
      });
      setRun(created);
      setSelectedId(created.id);
      await loadRuns();
      showToast("分析完成，已生成可审阅的执行方案", "success");
    } catch (error) {
      showToast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function action(
    path: string,
    body: Record<string, unknown> = {}
  ) {
    if (!run) return;
    setBusy(true);
    try {
      const next = await api.post<AgentRun>(
        `/api/v2/agent/runs/${run.id}/${path}`,
        body
      );
      setRun(next);
      await loadRuns();
      showToast("Agent 任务状态已更新", "success");
    } catch (error) {
      showToast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)]">
      <aside className="border-r border-gray-200/80 bg-white/55 p-4">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <History size={16} /> 历史任务
          </div>
          <button
            onClick={() => loadRuns()}
            className="rounded-lg p-2 text-gray-500 hover:bg-black/5"
            aria-label="刷新 Agent 任务"
          >
            <RefreshCw size={15} />
          </button>
        </div>
        <div className="space-y-2 overflow-y-auto">
          {runs.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-gray-400">
              还没有 Agent 任务
            </p>
          )}
          {runs.map((item) => (
            <button
              key={item.id}
              onClick={() => setSelectedId(item.id)}
              className="w-full rounded-xl border p-3 text-left transition hover:-translate-y-px"
              style={{
                borderColor:
                  selectedId === item.id ? "var(--accent)" : "var(--border)",
                background:
                  selectedId === item.id ? "var(--accent-light)" : "var(--card)",
              }}
            >
              <p className="line-clamp-2 text-sm font-medium">{item.request}</p>
              <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                <span>{statusLabel[item.status] ?? item.status}</span>
                <ChevronRight size={13} />
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="min-h-0 overflow-y-auto p-6 lg:p-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex items-start gap-3">
            <span
              className="flex h-10 w-10 items-center justify-center rounded-2xl text-white"
              style={{ background: "var(--accent)" }}
            >
              <Sparkles size={19} />
            </span>
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Agent 工作台</h1>
              <p className="mt-1 text-sm text-gray-500">
                主 Agent 负责审批与执行，从属 Agent 只进行分析和提出方案。
              </p>
            </div>
          </div>

          <div
            className="mb-6 rounded-2xl border p-4 shadow-sm"
            style={{ background: "var(--card)", borderColor: "var(--border)" }}
          >
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              rows={3}
              className="w-full resize-none bg-transparent text-sm leading-6 outline-none"
              aria-label="告诉 Agent 要完成什么"
              placeholder="例如：检查最近两周执行情况，生成下周调整方案，修改前让我确认。"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
              <select
                value={goalId}
                onChange={(event) => setGoalId(event.target.value)}
                className="rounded-xl border bg-transparent px-3 py-2 text-sm"
                style={{ borderColor: "var(--border)" }}
                aria-label="限制到某个目标"
              >
                <option value="">全部目标</option>
                {goals.map((goal) => (
                  <option key={goal.id} value={goal.id}>
                    {goal.title}
                  </option>
                ))}
              </select>
              <button
                onClick={createAgentRun}
                disabled={busy || request.trim().length < 2}
                className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--accent)" }}
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                开始执行
              </button>
            </div>
          </div>

          {run ? (
            <div className="space-y-5">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div
                  className="rounded-2xl border p-5"
                  style={{ background: "var(--card)", borderColor: "var(--border)" }}
                >
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 className="flex items-center gap-2 font-semibold">
                      <Activity size={17} style={{ color: "var(--accent)" }} />
                      执行计划
                    </h2>
                    <span
                      className="rounded-full px-3 py-1 text-xs font-medium"
                      style={{ color: "var(--accent)", background: "var(--accent-light)" }}
                    >
                      {statusLabel[run.status] ?? run.status}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {run.steps.map((step) => (
                      <div
                        key={step.id}
                        className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2 py-3"
                      >
                        <span
                          className="flex h-6 w-6 items-center justify-center rounded-full"
                          style={{
                            color:
                              step.status === "completed" ? "white" : "var(--accent)",
                            background:
                              step.status === "completed"
                                ? "var(--accent)"
                                : "var(--accent-light)",
                          }}
                        >
                          <StepIcon status={step.status} />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {run.plan?.[step.index]?.title ?? step.tool_name}
                          </p>
                          <p className="mt-0.5 text-xs text-gray-500">
                            {roleLabel[step.agent_role] ?? step.agent_role} · {step.tool_name}
                          </p>
                        </div>
                        <span className="text-xs text-gray-400">
                          {statusLabel[step.status] ?? step.status}
                        </span>
                      </div>
                    ))}
                  </div>
                  {run.objective?.constraints?.time_granularity_note && (
                    <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      {run.objective.constraints.time_granularity_note}
                    </p>
                  )}
                </div>

                <div
                  className="rounded-2xl border p-5"
                  style={{ background: "var(--card)", borderColor: "var(--border)" }}
                >
                  <h2 className="mb-4 flex items-center gap-2 font-semibold">
                    <ShieldCheck size={17} style={{ color: "var(--accent)" }} />
                    权限与状态
                  </h2>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">写操作入口</span>
                      <span className="font-medium">仅主 Agent</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">只读步骤</span>
                      <span className="font-medium">自动执行</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">任务调整</span>
                      <span className="font-medium">需确认</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">失败次数</span>
                      <span className="font-medium">{run.failure_count ?? 0}/3</span>
                    </div>
                  </div>
                  {run.status === "failed" && (
                    <button
                      onClick={() => action("retry")}
                      disabled={busy}
                      className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border py-2 text-sm"
                    >
                      <RefreshCw size={15} /> 重试失败步骤
                    </button>
                  )}
                  {["planning", "running", "waiting_approval"].includes(run.status) && (
                    <div className="mt-5 grid grid-cols-2 gap-2">
                      <button
                        onClick={() => action("pause")}
                        disabled={busy}
                        className="flex items-center justify-center gap-2 rounded-xl border py-2 text-sm"
                      >
                        <PauseCircle size={14} /> 暂停
                      </button>
                      <button
                        onClick={() => action("cancel")}
                        disabled={busy}
                        className="flex items-center justify-center gap-2 rounded-xl border py-2 text-sm"
                      >
                        <Square size={14} /> 取消
                      </button>
                    </div>
                  )}
                  {run.status === "paused" && (
                    <button
                      onClick={() => action("resume")}
                      disabled={busy}
                      className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border py-2 text-sm"
                    >
                      <Play size={14} /> 继续执行
                    </button>
                  )}
                  {run.status === "completed" && run.result?.undo_available && (
                    <button
                      onClick={() => action("undo")}
                      disabled={busy}
                      className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border py-2 text-sm"
                    >
                      <RotateCcw size={15} /> 撤销本次修改
                    </button>
                  )}
                </div>
              </div>

              {pendingApproval && (
                <div
                  className="rounded-2xl border-2 p-5"
                  style={{
                    background: "var(--accent-light)",
                    borderColor: "var(--accent)",
                  }}
                >
                  <div className="mb-4 flex items-start justify-between gap-4">
                    <div>
                      <h2 className="font-semibold">等待你的确认</h2>
                      <p className="mt-1 text-sm text-gray-600">
                        {pendingApproval.change_set.summary}
                      </p>
                    </div>
                    <span className="rounded-full bg-white/70 px-3 py-1 text-xs">
                      {pendingApproval.change_set.operations.length} 项修改
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-xl border bg-white/65">
                    {pendingApproval.change_set.operations.map((operation) => (
                      <div
                        key={operation.entity_id}
                        className="grid gap-2 border-b px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_130px_20px_130px]"
                      >
                        <div>
                          <p className="text-sm font-medium">{operation.label}</p>
                          <p className="mt-0.5 text-xs text-gray-500">{operation.reason}</p>
                        </div>
                        <span className="text-sm text-gray-500">{operation.before}</span>
                        <ChevronRight size={15} className="text-gray-400" />
                        <span className="text-sm font-medium">{operation.after}</span>
                      </div>
                    ))}
                  </div>
                  {pendingApproval.change_set.warnings?.map((warning) => (
                    <p key={warning} className="mt-2 text-xs text-amber-800">
                      {warning}
                    </p>
                  ))}
                  <div className="mt-5 flex justify-end gap-3">
                    <button
                      onClick={() =>
                        action("reject", {
                          approval_id: pendingApproval.id,
                          reason: "用户拒绝此变更方案",
                        })
                      }
                      disabled={busy}
                      className="rounded-xl border bg-white/70 px-4 py-2 text-sm font-medium"
                    >
                      拒绝
                    </button>
                    <button
                      onClick={() =>
                        action("approve", {
                          approval_id: pendingApproval.id,
                          change_hash: pendingApproval.change_hash,
                        })
                      }
                      disabled={busy}
                      className="rounded-xl px-4 py-2 text-sm font-medium text-white"
                      style={{ background: "var(--accent)" }}
                    >
                      批准并执行
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-20 text-center text-gray-400">
              <Bot size={34} className="mx-auto mb-3 opacity-60" />
              <p>输入目标后，主 Agent 会组织多个从属 Agent 完成分析。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
