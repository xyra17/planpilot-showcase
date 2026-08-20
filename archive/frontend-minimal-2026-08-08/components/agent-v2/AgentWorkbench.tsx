"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  History,
  Database,
  Gauge,
  Loader2,
  PauseCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { api, streamServerEvents } from "@/lib/api";
import { useGoalStore } from "@/lib/stores/goalStore";
import { useToast } from "@/components/ui/Toast";
import { useTasks } from "@/lib/tasks-context";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAuthStore } from "@/lib/stores/authStore";

type Operation = {
  entity_id: string;
  label: string;
  field: string;
  before: unknown;
  after: unknown;
  reason: string;
};

type Approval = {
  id: string;
  status: string;
  change_hash: string;
  change_set: { summary: string; operations: Operation[]; warnings: string[] };
  change_set_version: number;
  run_state_version: number;
  policy_decision?: { risk?: string; reasons?: string[]; obligations?: string[] };
};

type Step = {
  id: string;
  index: number;
  agent_role: string;
  tool_name: string;
  status: string;
  risk: string;
  output?: Record<string, unknown>;
  input_summary: DataSummary;
  output_summary: DataSummary;
  error?: string;
  error_data?: { category?: string; safe_message?: string };
  step_key: string;
  plan_version: number;
  depends_on: string[];
  rationale: string;
  attempts: number;
  tool_time_ms: number;
};

type DataSummary = {
  type: string;
  fields?: string[];
  counts?: Record<string, number>;
  summary?: string;
  count?: number;
  operation_count?: number;
  completion_rate?: number;
};

type Evidence = {
  evidence_id: string;
  source_type: string;
  source_id?: string;
  label: string;
  excerpt?: string;
};

type Conclusion = {
  text: string;
  kind: string;
  evidence_ids: string[];
  confidence: number;
};

type AuditEvent = {
  id: string;
  sequence: number;
  schema_version: number;
  step_id?: string;
  type: string;
  actor: string;
  summary?: string;
  detail?: {
    tool?: string;
    duration_ms?: number;
    data_types_read?: string[];
    data_summary?: DataSummary;
    evidence?: Evidence[];
    conclusions?: Conclusion[];
    [key: string]: unknown;
  };
  created_at: string;
};

type PlanHistory = {
  version: number;
  planner: string;
  model?: string | null;
  duration_ms?: number;
  token_usage?: number;
  reason?: string | null;
  fallback?: boolean;
  fallback_reason?: string | null;
  candidates?: Array<{ name: string; score: number }>;
  selected_tools?: string[];
  validation?: { status?: string; rejected_reason?: string };
  reused_steps?: Record<string, string>;
  steps: Array<{
    step_id?: string | null;
    title: string;
    tool_name: string;
    rationale?: string;
  }>;
};

type AgentRun = {
  id: string;
  request: string;
  plan: Array<{ title: string }>;
  plan_history: PlanHistory[];
  status: string;
  plan_version: number;
  run_kind: string;
  state_version: number;
  current_step: number;
  failure_count: number;
  objective: {
    intent?: string;
    goal_id?: string | null;
    constraints?: {
      time_granularity_note?: string | null;
      lookback_days?: number;
      excluded_weekdays?: number[];
      requires_confirmation?: boolean;
    };
  };
  result?: { summary?: string; undo_available?: boolean };
  error?: string;
  created_at: string;
  steps: Step[];
  approvals: Approval[];
  events: AuditEvent[];
  budgets: {
    steps: { used: number; limit: number };
    tokens: { used: number; limit: number };
    tool_time_ms: { used: number; limit: number };
    replans: { used: number; limit: number };
  };
  runtime: {
    worker_id?: string;
    heartbeat_at?: string;
    lease_expires_at?: string;
    deadline_at?: string;
  };
};

const roleLabel: Record<string, string> = {
  main: "主 Agent",
  learning_analyst: "学习分析 Agent",
  schedule_optimizer: "日程优化 Agent",
  knowledge_researcher: "知识检索 Agent",
  plan_reviewer: "计划审查 Agent",
};

const promptExamples = [
  "检查最近两周执行情况，把逾期任务重新安排到下周，修改前让我确认。",
  "创建两个任务“本周复习”，明天开始安排，修改前让我确认。",
  "把任务“章节练习”改到明天，修改前让我确认。",
  "删除任务“章节练习”，执行前让我确认。",
];

const statusLabel: Record<string, string> = {
  planning: "规划中",
  queued: "已排队",
  executing: "执行中",
  running: "执行中",
  waiting_approval: "等待确认",
  completed: "已完成",
  failed: "失败",
  rejected: "已拒绝",
  cancelled: "已取消",
  rolled_back: "已撤销",
  retrying: "重试中",
  replanning: "重新规划",
  blocked: "已阻塞",
  superseded: "已替代",
  paused: "已暂停",
  pending: "等待执行",
  waiting_approval_step: "等待确认",
};

const historicalRunStatuses = new Set([
  "completed",
  "failed",
  "rejected",
  "cancelled",
  "rolled_back",
  "superseded",
]);

function isHistoricalRun(run: AgentRun) {
  return historicalRunStatuses.has(run.status);
}

function StepIcon({ status }: { status: string }) {
  if (status === "completed") return <Check size={15} />;
  if (status === "running") return <Loader2 size={15} className="animate-spin" />;
  if (status === "waiting_approval") return <PauseCircle size={15} />;
  if (status === "failed") return <X size={15} />;
  return <Circle size={13} />;
}

function formatRunDate(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

function formatDuration(startedAt?: string) {
  if (!startedAt) return "";
  const elapsed = Math.max(0, Date.now() - new Date(startedAt).getTime());
  if (elapsed < 60_000) return `${Math.round(elapsed / 1000)} 秒`;
  return `${Math.round(elapsed / 60_000)} 分钟`;
}

function logicalStepId(stepKey: string | null | undefined, fallback = "unknown-step") {
  if (!stepKey) return fallback;
  return stepKey.includes(":") ? stepKey.split(":").slice(1).join(":") : stepKey;
}

function formatDataSummary(summary: DataSummary) {
  const parts: string[] = [];
  if (summary.summary) parts.push(summary.summary);
  if (summary.count !== undefined) parts.push(`${summary.count} 项`);
  if (summary.operation_count !== undefined) parts.push(`${summary.operation_count} 项变更`);
  if (summary.completion_rate !== undefined) parts.push(`完成率 ${summary.completion_rate}%`);
  if (summary.counts) {
    parts.push(
      ...Object.entries(summary.counts).map(([key, value]) => `${key} ${value}`)
    );
  }
  if (parts.length === 0 && summary.fields?.length) {
    parts.push(`字段：${summary.fields.join("、")}`);
  }
  return parts.join(" · ") || "无数据";
}

function EditableChangeSet({
  changeSet,
  disabled,
  onSave,
}: {
  changeSet: Approval["change_set"];
  disabled: boolean;
  onSave: (changeSet: Approval["change_set"]) => void;
}) {
  const [operations, setOperations] = useState<Operation[]>(changeSet.operations);

  useEffect(() => {
    setOperations(changeSet.operations);
  }, [changeSet]);

  function update(index: number, patch: Partial<Operation>) {
    setOperations((current) =>
      current.map((operation, position) =>
        position === index ? { ...operation, ...patch } : operation
      )
    );
  }

  return (
    <div>
      <div className="overflow-hidden rounded-lg border bg-white/65">
        {operations.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-gray-500">
            已移除全部修改，批准后不会更改任务。
          </p>
        )}
        {operations.map((operation, index) => {
          const created =
            operation.field === "__create__" &&
            typeof operation.after === "object" &&
            operation.after !== null;
          const createdValue = created
            ? (operation.after as Record<string, unknown>)
            : null;
          return (
            <div
              key={`${operation.entity_id}:${operation.field}`}
              className="border-b px-4 py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{operation.label}</p>
                  <p className="mt-0.5 text-xs text-gray-500">{operation.reason}</p>
                </div>
                <button
                  onClick={() =>
                    setOperations((current) =>
                      current.filter((_, position) => position !== index)
                    )
                  }
                  className="rounded-lg p-1.5 text-gray-400 hover:bg-black/5 hover:text-red-600"
                  aria-label={`移除${operation.label}的变更`}
                >
                  <X size={14} />
                </button>
              </div>
              {createdValue ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px]">
                  <input
                    value={String(createdValue.title ?? "")}
                    onChange={(event) =>
                      update(index, {
                        label: event.target.value,
                        after: { ...createdValue, title: event.target.value },
                      })
                    }
                    className="rounded-lg border bg-white/70 px-3 py-2 text-sm"
                    aria-label="新任务标题"
                  />
                  <input
                    type="date"
                    value={String(createdValue.scheduled_date ?? "")}
                    onChange={(event) =>
                      update(index, {
                        after: {
                          ...createdValue,
                          scheduled_date: event.target.value,
                        },
                      })
                    }
                    className="rounded-lg border bg-white/70 px-3 py-2 text-sm"
                    aria-label="新任务日期"
                  />
                </div>
              ) : operation.field === "scheduled_date" ? (
                <div className="mt-3 grid items-center gap-2 sm:grid-cols-[1fr_20px_1fr]">
                  <span className="text-sm text-gray-500">
                    {String(operation.before ?? "—")}
                  </span>
                  <ChevronRight size={15} className="text-gray-400" />
                  <input
                    type="date"
                    value={String(operation.after ?? "")}
                    onChange={(event) => update(index, { after: event.target.value })}
                    className="rounded-lg border bg-white/70 px-3 py-2 text-sm"
                    aria-label={`${operation.label}的新日期`}
                  />
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 text-sm">
                  <span className="text-gray-500">
                    {operation.field === "__delete__"
                      ? "将删除此任务"
                      : `${String(operation.before ?? "—")} → ${String(operation.after ?? "—")}`}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          onClick={() =>
            onSave({
              ...changeSet,
              summary: `用户调整后的方案，共 ${operations.length} 项变更`,
              operations,
            })
          }
          disabled={disabled}
          className="inline-flex items-center gap-2 rounded-lg border bg-white/70 px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          <Save size={14} /> 保存方案修改
        </button>
      </div>
    </div>
  );
}

export default function AgentWorkbench() {
  const userTimezone = useAuthStore((state) => state.user?.timezone ?? "Asia/Shanghai");
  const { goals, fetchGoals } = useGoalStore();
  const { showToast } = useToast();
  const { refresh: refreshTasks } = useTasks();
  const { confirmAction } = useConfirmDialog();
  const [request, setRequest] = useState(
    "检查我最近两周的执行情况，把落后的任务重新安排到下周。周三晚上不要排任务，修改前让我确认。"
  );
  const [goalId, setGoalId] = useState("");
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [selectedPlanVersion, setSelectedPlanVersion] = useState<number | null>(null);
  const [eventActor, setEventActor] = useState("all");
  const [eventType, setEventType] = useState("all");
  const [detailTab, setDetailTab] = useState<"evidence" | "audit">("evidence");

  useEffect(() => {
    if (window.matchMedia("(max-width: 768px)").matches) setHistoryOpen(false);
  }, []);

  const loadRuns = useCallback(async () => {
    const rows = await api.get<AgentRun[]>("/api/v2/agent/runs");
    setRuns(rows);
    setSelectedId(
      (current) =>
        current ??
        rows.find((item) => !isHistoricalRun(item))?.id ??
        rows.find(isHistoricalRun)?.id ??
        null
    );
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
    if (run) {
      setSelectedPlanVersion(run.plan_version);
      setDetailTab("evidence");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.plan_version]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    let reconnectTimer: number | undefined;
    let stopped = false;
    let cursor = run?.id === selectedId
      ? Math.max(0, ...run.events.map((event) => event.sequence))
      : 0;

    const connect = async () => {
      try {
        await streamServerEvents(
          `/api/v2/agent/runs/${selectedId}/events/stream?after=${cursor}`,
          {
            signal: controller.signal,
            lastEventId: cursor,
            onEvent: (message) => {
              const event = JSON.parse(message.data) as AuditEvent;
              if (!Number.isInteger(event.sequence) || event.sequence <= cursor) return;
              cursor = event.sequence;
              setRun((current) => {
                if (!current || current.id !== selectedId) return current;
                if (current.events.some((item) => item.sequence === event.sequence)) return current;
                return {
                  ...current,
                  events: [...current.events, event].sort(
                    (left, right) => left.sequence - right.sequence
                  ),
                };
              });
            },
          }
        );
        if (!stopped) reconnectTimer = window.setTimeout(connect, 1000);
      } catch (error) {
        if (!stopped && (error as Error).name !== "AbortError") {
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      }
    };

    connect();
    return () => {
      stopped = true;
      controller.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!run || !["planning", "queued", "running", "executing"].includes(run.status)) return;
    const timer = window.setInterval(() => {
      loadRun(run.id).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [run, loadRun]);

  useEffect(() => {
    if (run?.status === "completed" || run?.status === "rolled_back") {
      refreshTasks();
    }
  }, [run?.status, refreshTasks]);

  const pendingApproval = useMemo(
    () => run?.approvals.find((item) => item.status === "pending"),
    [run]
  );

  const currentActivity = useMemo(
    () => run?.steps.find((step) => ["running", "retrying", "waiting_approval"].includes(step.status)),
    [run]
  );

  const currentActivityStartedAt = useMemo(() => {
    if (!run || !currentActivity) return undefined;
    return run.events
      .filter((event) => event.step_id === currentActivity.id && event.type === "tool.started")
      .sort((left, right) => right.sequence - left.sequence)[0]?.created_at;
  }, [currentActivity, run]);

  const selectedPlan = useMemo(
    () => run?.plan_history.find((item) => item.version === selectedPlanVersion),
    [run, selectedPlanVersion]
  );

  const previousPlan = useMemo(() => {
    if (!run || !selectedPlan) return undefined;
    return run.plan_history
      .filter((item) => item.version < selectedPlan.version)
      .sort((left, right) => right.version - left.version)[0];
  }, [run, selectedPlan]);

  const visibleSteps = useMemo(
    () => run?.steps.filter((step) => step.plan_version === selectedPlanVersion) ?? [],
    [run, selectedPlanVersion]
  );

  const planComparison = useMemo(() => {
    if (!selectedPlan) return null;
    const currentIds = new Set(
      selectedPlan.steps.map((step, index) =>
        logicalStepId(step.step_id, `${step.tool_name}:${index}`)
      )
    );
    const previousIds = new Set(
      previousPlan?.steps.map((step, index) =>
        logicalStepId(step.step_id, `${step.tool_name}:${index}`)
      ) ?? []
    );
    return {
      added: Array.from(currentIds).filter((item) => !previousIds.has(item)).length,
      removed: Array.from(previousIds).filter((item) => !currentIds.has(item)).length,
      reused: Object.keys(selectedPlan.reused_steps ?? {}).length,
    };
  }, [previousPlan, selectedPlan]);

  const planChanges = useMemo(() => {
    if (!selectedPlan) return [];
    const previousById = new Map(
      previousPlan?.steps.map((step, index) => [
        logicalStepId(step.step_id, `${step.tool_name}:${index}`),
        step,
      ]) ?? []
    );
    const changes = selectedPlan.steps.map((step, index) => {
      const id = logicalStepId(step.step_id, `${step.tool_name}:${index}`);
      const previous = previousById.get(id);
      const reused = Boolean(selectedPlan.reused_steps?.[id]);
      const kind = reused
        ? "reused"
        : !previous
          ? "added"
          : previous.tool_name !== step.tool_name || previous.title !== step.title
            ? "changed"
            : "retained";
      return { id, title: step.title, tool: step.tool_name, kind };
    });
    const currentIds = new Set(
      selectedPlan.steps.map((step, index) =>
        logicalStepId(step.step_id, `${step.tool_name}:${index}`)
      )
    );
    previousPlan?.steps.forEach((step, index) => {
      const id = logicalStepId(step.step_id, `${step.tool_name}:${index}`);
      if (!currentIds.has(id)) {
        changes.push({ id, title: step.title, tool: step.tool_name, kind: "removed" });
      }
    });
    return changes;
  }, [previousPlan, selectedPlan]);

  const evidenceSummary = useMemo(() => {
    const dataTypes = new Map<string, { reads: number; records: number; durationMs: number }>();
    const evidence = new Map<string, Evidence>();
    const conclusions: Conclusion[] = [];
    run?.events.forEach((event) => {
      event.detail?.data_types_read?.forEach((value) => {
        const current = dataTypes.get(value) ?? { reads: 0, records: 0, durationMs: 0 };
        dataTypes.set(value, {
          reads: current.reads + 1,
          records: current.records + Number(event.detail?.data_summary?.counts?.[value] ?? 0),
          durationMs: current.durationMs + Number(event.detail?.duration_ms ?? 0),
        });
      });
      event.detail?.evidence?.forEach((item) => evidence.set(item.evidence_id, item));
      conclusions.push(...(event.detail?.conclusions ?? []));
    });
    return {
      dataTypes: Array.from(dataTypes.entries()),
      evidence: Array.from(evidence.values()),
      conclusions,
    };
  }, [run]);

  const eventActors = useMemo(
    () => Array.from(new Set(run?.events.map((event) => event.actor) ?? [])).sort(),
    [run]
  );

  const eventTypes = useMemo(
    () => Array.from(new Set(run?.events.map((event) => event.type) ?? [])).sort(),
    [run]
  );

  const filteredEvents = useMemo(
    () =>
      (run?.events ?? []).filter(
        (event) =>
          (eventActor === "all" || event.actor === eventActor) &&
          (eventType === "all" || event.type === eventType)
      ),
    [eventActor, eventType, run]
  );

  const historyRuns = useMemo(() => runs.filter(isHistoricalRun), [runs]);

  function stepTitle(step: Step) {
    return (
      selectedPlan?.steps.find((item) => item.step_id === step.step_key)?.title ??
      step.tool_name
    );
  }

  async function approvePending() {
    if (!pendingApproval) return;
    const highRisk = pendingApproval.policy_decision?.risk === "high";
    if (highRisk) {
      const confirmed = await confirmAction({
        title: "确认高风险变更",
        description: `本次操作包含 ${pendingApproval.change_set.operations.length} 项高风险变更。批准后将立即执行，执行结果只能在数据未再次变化时撤销。`,
        confirmLabel: "确认并执行",
        tone: "danger",
      });
      if (!confirmed) return;
    }
    await action("approve", {
      approval_id: pendingApproval.id,
      change_hash: pendingApproval.change_hash,
      change_set_version: pendingApproval.change_set_version,
      run_state_version: pendingApproval.run_state_version,
      high_risk_confirmed: highRisk,
    });
  }

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
      showToast("Agent 任务已进入后台队列", "success");
    } catch (error) {
      showToast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveChangeSet(changeSet: Approval["change_set"]) {
    if (!run || !pendingApproval) return;
    setBusy(true);
    try {
      const next = await api.patch<AgentRun>(
        `/api/v2/agent/runs/${run.id}/approvals/${pendingApproval.id}`,
        { change_set: changeSet }
      );
      setRun(next);
      showToast("变更方案已更新，请重新核对后批准", "success");
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

  async function deleteHistory(item: AgentRun) {
    const confirmed = await confirmAction({
      title: "删除 Agent 历史任务",
      description:
        item.result?.undo_available && item.status === "completed"
          ? "删除后会同时移除执行步骤、审计记录和撤销入口，且无法恢复。"
          : "执行步骤和审计记录将一并删除，且无法恢复。",
      confirmLabel: "删除记录",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await api.del(`/api/v2/agent/runs/${item.id}`);
      const remaining = runs.filter((candidate) => candidate.id !== item.id);
      setRuns(remaining);
      if (selectedId === item.id) {
        setRun(null);
        setSelectedId(remaining[0]?.id ?? null);
      }
      showToast("Agent 历史任务已删除", "success");
    } catch (error) {
      showToast((error as Error).message, "error");
    }
  }

  return (
    <div
      className="agent-workbench-v3 relative flex h-full min-h-0 overflow-hidden"
      style={{ background: "var(--bg)" }}
    >
      <div
        className={`agent-history-shell flex-shrink-0 transition-all duration-200 ${
          historyOpen ? "w-[236px]" : "w-12"
        } ${
          historyOpen
            ? "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-[236px] max-md:max-w-[calc(100vw-3.5rem)] max-md:shadow-xl"
            : "max-md:hidden"
        }`}
      >
        {historyOpen ? (
          <aside
            className="agent-history relative flex h-full min-h-0 flex-col border-r px-3 pb-4 pt-5"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--surface) 96%, var(--accent-light)), var(--surface))",
              borderColor: "color-mix(in srgb, var(--border) 82%, var(--accent-muted))",
            }}
          >
            <div
              className="pointer-events-none absolute bottom-0 right-0 top-0 w-px"
              style={{ background: "color-mix(in srgb, var(--accent) 20%, transparent)" }}
            />
            <div className="mb-5 flex flex-shrink-0 items-start gap-1.5 px-0.5">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-gray-900">最近协作</h2>
                  <p className="mt-1 text-[11px] text-gray-400">{historyRuns.length} 条记录</p>
                </div>
              </div>
              <button
                onClick={() => loadRuns()}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition hover:bg-black/5"
                aria-label="刷新 Agent 任务"
                title="刷新"
              >
                <RefreshCw size={15} />
              </button>
              <button
                onClick={() => setHistoryOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition hover:bg-black/5"
                title="收起历史任务"
                aria-label="收起历史任务"
              >
                <ChevronLeft size={15} />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
              {historyRuns.length === 0 && (
                <div
                  className="rounded-lg border border-dashed px-3 py-8 text-center text-xs text-gray-400"
                  style={{
                    background: "color-mix(in srgb, var(--surface) 78%, var(--accent-light))",
                    borderColor: "color-mix(in srgb, var(--border) 72%, var(--accent-muted))",
                  }}
                >
                  还没有协作记录
                </div>
              )}
              {historyRuns.map((item) => {
                const selected = selectedId === item.id;
                return (
                  <div
                    key={item.id}
                    className="agent-history-item group relative overflow-hidden rounded-lg border transition"
                    style={{
                      borderColor: selected
                        ? "color-mix(in srgb, var(--accent) 22%, var(--border))"
                        : "color-mix(in srgb, var(--border) 62%, transparent)",
                      background: selected
                        ? "color-mix(in srgb, var(--surface) 64%, var(--accent-light))"
                        : "color-mix(in srgb, var(--surface) 88%, transparent)",
                    }}
                  >
                    {selected && (
                      <span
                        className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full"
                        style={{ background: "var(--accent)" }}
                      />
                    )}
                    <button
                      onClick={() => setSelectedId(item.id)}
                      className="w-full min-w-0 px-3 pb-2.5 pl-3.5 pt-3 text-left"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span
                          className="inline-flex items-center gap-1.5 text-[11px] font-medium"
                          style={{
                            color: "var(--accent)",
                          }}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "currentColor" }} />
                          {statusLabel[item.status] ?? item.status}
                        </span>
                        <span className="text-[10px] text-gray-400">
                          {formatRunDate(item.created_at, userTimezone)}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-[13px] font-medium leading-5 text-gray-800">
                        {item.request}
                      </p>
                    </button>
                    <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                      {!["queued", "running", "executing"].includes(item.status) && (
                        <button
                          onClick={() => deleteHistory(item)}
                          className="flex h-7 w-7 items-center justify-center rounded-md bg-white/80 text-gray-400 transition hover:bg-red-50 hover:text-red-600"
                          aria-label={`删除 Agent 历史任务：${item.request}`}
                          title="删除历史任务"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        ) : (
          <div
            className="relative flex h-full justify-center border-r pt-4"
            style={{
              borderColor: "color-mix(in srgb, var(--border) 82%, var(--accent-muted))",
              background: "var(--surface)",
            }}
          >
            <button
              onClick={() => setHistoryOpen(true)}
              className="flex h-9 w-8 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
              title="展开历史任务"
              aria-label="展开历史任务"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>

      {historyOpen && (
        <button
          type="button"
          onClick={() => setHistoryOpen(false)}
          className="absolute inset-0 z-20 hidden bg-black/10 max-md:block"
          aria-label="关闭历史任务"
        />
      )}

      <section
        className="agent-main min-h-0 min-w-0 flex-1 overflow-y-auto"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--surface) 82%, var(--bg)) 0%, color-mix(in srgb, var(--surface) 76%, var(--bg)) 44%)",
        }}
      >
        <header
          className="agent-header sticky top-0 z-10 flex min-h-16 items-center justify-between gap-4 border-b px-4 sm:px-6 lg:px-8"
          style={{
            borderColor: "var(--border)",
            background: "color-mix(in srgb, var(--surface) 90%, transparent)",
          }}
        >
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setHistoryOpen(true)}
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-gray-500 transition hover:bg-black/5 md:hidden"
                  title="历史任务"
                  aria-label="展开历史任务"
                >
                  <History size={17} />
                </button>
                <span className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg sm:flex" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>
                  <Sparkles size={16} />
                </span>
                <div>
                  <h1 className="text-base font-semibold text-gray-900 sm:text-lg">任务协作</h1>
                  <p className="mt-0.5 max-w-[52vw] truncate text-xs text-gray-400">
                    {run?.request ?? "描述任务，助手会先规划步骤，再等待你确认"}
                  </p>
                </div>
              </div>
            </div>
            <span
              className="inline-flex flex-shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium"
              style={{
                background: "var(--accent-light)",
                borderColor: "color-mix(in srgb, var(--accent) 18%, var(--border))",
                color: "var(--accent)",
              }}
            >
              <Bot size={15} />
              <span className="hidden sm:inline">所有变更需确认</span>
              <span className="sm:hidden">需确认</span>
            </span>
        </header>

        <div className="mx-auto max-w-[1320px] space-y-5 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">

          <div
            className="agent-composer agent-module-tint agent-module-tint-primary overflow-hidden rounded-lg border"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--surface) 82%, var(--accent-light)), var(--surface))",
              borderColor: "color-mix(in srgb, var(--accent) 18%, var(--border))",
            }}
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                <Bot size={16} style={{ color: "var(--accent)" }} />
                告诉学习伙伴要协作什么
              </div>
              <span className="text-xs text-gray-400">{request.trim().length}/2000</span>
            </div>
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              rows={3}
              maxLength={2000}
              className="min-h-[96px] w-full resize-none border-0 bg-transparent px-4 py-3 text-sm leading-6 outline-none"
              style={{
                background: "var(--surface)",
              }}
              aria-label="告诉学习伙伴要协作完成什么"
              placeholder="例如：检查最近两周的执行情况，把落后的任务重新安排到下周；修改前先让我确认。"
            />
            <div className="flex gap-1.5 overflow-x-auto border-t px-4 py-2.5" style={{ borderColor: "var(--border)" }}>
              {promptExamples.map((example, index) => (
                <button
                  key={example}
                  onClick={() => setRequest(example)}
                  className="flex-shrink-0 rounded-md border px-2.5 py-1.5 text-left text-xs text-gray-500 transition hover:text-gray-800"
                  style={{
                    borderColor: "color-mix(in srgb, var(--border) 78%, var(--accent-muted))",
                    background: "var(--surface)",
                  }}
                >
                  {(["分析并重排", "创建任务", "调整日期", "删除任务"] as const)[index]}
                </button>
              ))}
            </div>
            <div
              className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3"
              style={{ borderColor: "var(--border)" }}
            >
              <select
                value={goalId}
                onChange={(event) => setGoalId(event.target.value)}
                className="min-h-9 max-w-[220px] rounded-lg border bg-transparent px-3 py-1.5 text-sm"
                style={{ borderColor: "var(--border)", background: "var(--surface)" }}
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
                className="inline-flex min-h-9 items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium text-white transition hover:brightness-95 disabled:opacity-50"
                style={{ background: "var(--accent)" }}
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                开始协作
              </button>
            </div>
          </div>

          {run && (
            <section
              className="agent-run-context agent-module-tint rounded-lg border p-4"
              style={{
                background:
                  "linear-gradient(90deg, color-mix(in srgb, var(--surface) 76%, var(--accent-light)), var(--surface) 62%)",
                borderColor: "color-mix(in srgb, var(--accent) 14%, var(--border))",
              }}
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span
                      className="rounded-full px-2.5 py-1 text-xs font-medium"
                      style={{ color: "var(--accent)", background: "var(--accent-light)" }}
                    >
                      {run.run_kind === "suggestion" ? "主动建议" : "用户任务"}
                    </span>
                    <span className="text-xs text-gray-400">
                      状态版本 {run.state_version} · 计划 v{run.plan_version}
                    </span>
                  </div>
                  <h2 className="text-sm font-semibold text-gray-900">当前任务上下文</h2>
                  <p className="mt-2 max-w-4xl text-sm leading-6 text-gray-700">
                    {run.request}
                  </p>
                </div>
                <dl className="grid flex-shrink-0 grid-cols-2 gap-x-5 gap-y-2 text-xs sm:min-w-[360px]">
                  <div>
                    <dt className="text-gray-400">意图</dt>
                    <dd className="mt-0.5 font-medium text-gray-700">
                      {String((run.objective as { intent?: string }).intent ?? "-")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-400">回看窗口</dt>
                    <dd className="mt-0.5 font-medium text-gray-700">
                      {run.objective.constraints?.lookback_days ?? "-"} 天
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-400">需确认</dt>
                    <dd className="mt-0.5 font-medium text-gray-700">
                      {run.objective.constraints?.requires_confirmation ? "是" : "否"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-400">排除星期</dt>
                    <dd className="mt-0.5 font-medium text-gray-700">
                      {run.objective.constraints?.excluded_weekdays?.join("、") || "无"}
                    </dd>
                  </div>
                </dl>
              </div>
            </section>
          )}

          <div className="flex flex-col gap-4">
              <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(268px,.65fr)]">
                <div
                  className="agent-module agent-module-tint agent-module-tint-plan h-fit overflow-hidden rounded-lg border"
                  style={{
                    background: "var(--surface)",
                    borderColor: "color-mix(in srgb, var(--accent) 14%, var(--border))",
                  }}
                >
                  <div className="flex items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--border)" }}>
                    <h2 className="flex items-center gap-2 font-semibold text-gray-900">
                      <Activity size={17} style={{ color: "var(--accent)" }} />
                      执行计划
                    </h2>
                    <span
                      className="rounded-full px-2.5 py-1 text-xs font-medium"
                      style={{ color: "var(--accent)", background: "var(--accent-light)" }}
                    >
                      {run ? statusLabel[run.status] ?? run.status : "待执行"}
                    </span>
                  </div>
                  <div className="px-5 py-4">
                  {run && run.plan_history.length > 0 && (
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b pb-4" style={{ borderColor: "var(--border)" }}>
                      <div className="flex flex-wrap gap-1 rounded-lg border p-1" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                        {run.plan_history.map((plan) => (
                          <button
                            key={plan.version}
                            onClick={() => setSelectedPlanVersion(plan.version)}
                            className="min-h-8 rounded-md px-3 text-xs font-medium"
                            style={selectedPlanVersion === plan.version ? { background: "var(--accent-light)", color: "var(--accent)" } : { color: "#6b7280" }}
                          >
                            v{plan.version}
                          </button>
                        ))}
                      </div>
                      {selectedPlan && (
                        <span className="text-xs text-gray-500">
                          {selectedPlan.planner === "model" ? "模型规划" : "确定性规划"} · {selectedPlan.duration_ms ?? 0} ms · {selectedPlan.token_usage ?? 0} Token
                        </span>
                      )}
                    </div>
                  )}
                  {selectedPlan && previousPlan && planComparison && (
                    <div className="mb-5 grid gap-2 text-xs sm:grid-cols-4">
                      <span className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>复用 {planComparison.reused} 步</span>
                      <span className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>新增 {planComparison.added} 步</span>
                      <span className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>移除 {planComparison.removed} 步</span>
                      <span className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>来源 v{previousPlan.version}</span>
                      {selectedPlan.reason && <p className="sm:col-span-4 text-gray-500">重规划原因：{selectedPlan.reason}</p>}
                      <div className="sm:col-span-4 flex flex-wrap gap-2">
                        {planChanges.map((change) => (
                          <span key={`${change.kind}:${change.id}`} className="rounded-full border px-2.5 py-1" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                            {change.kind === "reused" ? "复用" : change.kind === "added" ? "新增" : change.kind === "removed" ? "移除" : change.kind === "changed" ? "调整" : "保留"} · {change.title}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedPlan && (
                    <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span>校验：{selectedPlan.validation?.status ?? "unknown"}</span>
                      {selectedPlan.fallback_reason && <span>降级原因：{selectedPlan.fallback_reason}</span>}
                      {selectedPlan.candidates?.map((candidate) => (
                        <span key={candidate.name} className="rounded-full border px-2 py-1" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                          {candidate.name} · {candidate.score}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="space-y-0">
                    {run && visibleSteps.length > 0 ? (
                      visibleSteps.map((step, index) => (
                        <div
                          key={step.id}
                          className="relative grid grid-cols-[32px_minmax(0,1fr)_auto] gap-3 pb-5 last:pb-0"
                        >
                          {index < visibleSteps.length - 1 && (
                            <span
                              className="absolute bottom-0 left-4 top-8 w-px"
                              style={{ background: "var(--border)" }}
                            />
                          )}
                          <span
                            className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full"
                            style={{
                              color: step.status === "completed" ? "white" : "var(--accent)",
                              background:
                                step.status === "completed"
                                  ? "var(--accent)"
                                  : "var(--accent-light)",
                            }}
                          >
                            <StepIcon status={step.status} />
                          </span>
                          <div
                            className="min-w-0 border-b pb-4 last:border-b-0"
                            style={{ borderColor: "var(--border)" }}
                          >
                            <p className="truncate text-sm font-medium text-gray-900">
                              {stepTitle(step)}
                            </p>
                            <p className="mt-1 text-xs text-gray-500">
                              {roleLabel[step.agent_role] ?? step.agent_role} · {step.tool_name}
                            </p>
                            {step.rationale && (
                              <p className="mt-2 text-xs leading-5 text-gray-500">{step.rationale}</p>
                            )}
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400">
                              <span>计划 v{step.plan_version}</span>
                              <span>尝试 {step.attempts} 次</span>
                              <span>{step.tool_time_ms} ms</span>
                              {step.depends_on.length > 0 && <span>依赖 {step.depends_on.length} 步</span>}
                              {selectedPlan?.reused_steps?.[logicalStepId(step.step_key)] && (
                                <span style={{ color: "var(--accent)" }}>复用结果</span>
                              )}
                            </div>
                            <div className="mt-2 grid gap-1 text-xs text-gray-500 sm:grid-cols-2">
                              <p className="min-w-0 break-words"><span className="text-gray-400">输入：</span>{formatDataSummary(step.input_summary)}</p>
                              <p className="min-w-0 break-words"><span className="text-gray-400">输出：</span>{formatDataSummary(step.output_summary)}</p>
                            </div>
                            {step.error_data?.safe_message && (
                              <p className="mt-2 text-xs text-red-600">
                                {step.error_data.category}: {step.error_data.safe_message}
                              </p>
                            )}
                          </div>
                          <span className="pt-3 text-xs text-gray-400">
                            {statusLabel[step.status] ?? step.status}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="relative grid grid-cols-[32px_minmax(0,1fr)_auto] gap-3">
                        <span
                          className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full"
                          style={{
                            color: "var(--accent)",
                            background: "var(--accent-light)",
                          }}
                        >
                          <Circle size={13} />
                        </span>
                        <div
                          className="min-w-0 rounded-lg border px-4 py-3"
                          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                        >
                          <p className="text-sm font-medium text-gray-900">等待创建执行计划</p>
                          <p className="mt-1 text-xs text-gray-500">
                            输入任务后，学习伙伴会先拆解步骤，再把需要修改的内容交给你确认。
                          </p>
                        </div>
                        <span className="pt-3 text-xs text-gray-400">待执行</span>
                      </div>
                    )}
                  </div>
                  {run?.objective?.constraints?.time_granularity_note && (
                    <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      {run.objective.constraints.time_granularity_note}
                    </p>
                  )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div
                    className="agent-side-panel agent-module-tint agent-module-tint-side overflow-hidden rounded-lg border"
                    style={{
                      background:
                        "linear-gradient(180deg, color-mix(in srgb, var(--surface) 86%, var(--accent-light)), var(--surface))",
                      borderColor: "color-mix(in srgb, var(--accent) 16%, var(--border))",
                    }}
                  >
                  <h2 className="flex items-center gap-2 border-b px-4 py-4 font-semibold text-gray-900" style={{ borderColor: "var(--border)" }}>
                    <ShieldCheck size={17} style={{ color: "var(--accent)" }} />
                    执行边界
                  </h2>
                  <div className="divide-y px-4 text-sm" style={{ borderColor: "var(--border)" }}>
                    {[
                      ["计划修改", "确认后执行"],
                      ["只读步骤", "自动执行"],
                      ["任务调整", "需确认"],
                      ["失败次数", `${run?.failure_count ?? 0}/3`],
                      ["计划版本", `v${run?.plan_version ?? 1}`],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="flex items-center justify-between gap-4 py-3"
                      >
                        <span className="text-gray-500">{label}</span>
                        <span
                          className="rounded-full px-2.5 py-1 text-xs font-medium"
                          style={{
                            background: "var(--accent-light)",
                            color: "var(--accent)",
                          }}
                        >
                          {value}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="px-4 pb-4">
                  {run?.status === "failed" && (
                    <button
                      onClick={() => action("retry")}
                      disabled={busy}
                      className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border py-2 text-sm"
                    >
                      <RefreshCw size={15} /> 重试失败步骤
                    </button>
                  )}
                  {run && ["planning", "queued", "running", "executing"].includes(run.status) && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        onClick={() => action("pause")}
                        disabled={busy}
                        className="flex items-center justify-center gap-2 rounded-lg border py-2 text-sm"
                      >
                        <PauseCircle size={14} /> 暂停
                      </button>
                      <button
                        onClick={() => action("cancel")}
                        disabled={busy}
                        className="flex items-center justify-center gap-2 rounded-lg border py-2 text-sm"
                      >
                        <Square size={14} /> 取消
                      </button>
                    </div>
                  )}
                  {run?.status === "paused" && (
                    <button
                      onClick={() => action("resume")}
                      disabled={busy}
                      className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border py-2 text-sm"
                    >
                      <Play size={14} /> 继续执行
                    </button>
                  )}
                  {run?.status === "completed" && run.result?.undo_available && (
                    <button
                      onClick={() => action("undo")}
                      disabled={busy}
                      className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border py-2 text-sm"
                    >
                      <RotateCcw size={15} /> 撤销本次修改
                    </button>
                  )}
                  </div>
                  </div>

                  {run && (
                    <div
                      className="agent-activity-board agent-module-tint overflow-hidden rounded-lg border"
                      style={{
                        background: "var(--surface)",
                        borderColor: "color-mix(in srgb, var(--accent) 12%, var(--border))",
                      }}
                    >
                      <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold text-gray-900" style={{ borderColor: "var(--border)" }}>
                        <Activity size={16} style={{ color: "var(--accent)" }} />
                        Agent 活动
                      </h2>
                      <div className="space-y-3 px-4 py-3 text-sm">
                        <p className="leading-6 text-gray-700">
                          {currentActivity
                            ? `${roleLabel[currentActivity.agent_role] ?? currentActivity.agent_role} · ${currentActivity.tool_name}`
                            : "当前没有正在执行的步骤"}
                        </p>
                        <p className="text-xs text-gray-400">
                          {currentActivityStartedAt ? `已持续 ${formatDuration(currentActivityStartedAt)} · ` : ""}
                          {run.runtime.heartbeat_at
                            ? `最近心跳 ${formatRunDate(run.runtime.heartbeat_at, userTimezone)}`
                            : "当前无 Worker 心跳"}
                        </p>
                        <div className="grid gap-2">
                          {evidenceSummary.dataTypes.length > 0 ? evidenceSummary.dataTypes.map(([item, stats]) => (
                            <div key={item} className="flex items-center justify-between gap-3 text-xs">
                              <span className="rounded-full px-2.5 py-1" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>{item}</span>
                              <span className="text-gray-400">读取 {stats.reads} 次{stats.records > 0 ? ` · ${stats.records} 条` : ""}</span>
                            </div>
                          )) : <span className="text-xs text-gray-400">尚无数据读取记录</span>}
                        </div>
                      </div>
                    </div>
                  )}

                  {run && (
                    <div
                      className="agent-budget-board agent-module-tint overflow-hidden rounded-lg border"
                      style={{
                        background: "var(--surface)",
                        borderColor: "color-mix(in srgb, var(--accent) 12%, var(--border))",
                      }}
                    >
                      <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold text-gray-900" style={{ borderColor: "var(--border)" }}>
                        <Gauge size={16} style={{ color: "var(--accent)" }} />
                        运行预算
                      </h2>
                      <div className="grid gap-3 px-4 py-3 text-xs">
                        {[
                          ["步骤", run.budgets.steps],
                          ["Token", run.budgets.tokens],
                          ["工具时间", { used: Math.round(run.budgets.tool_time_ms.used / 1000), limit: Math.round(run.budgets.tool_time_ms.limit / 1000) }],
                          ["重规划", run.budgets.replans],
                        ].map(([label, value]) => {
                          const budget = value as { used: number; limit: number };
                          const percent = Math.min(100, budget.limit ? (budget.used / budget.limit) * 100 : 0);
                          return (
                            <div key={String(label)}>
                              <div className="mb-1 flex justify-between">
                                <span className="text-gray-500">{String(label)}</span>
                                <span>{budget.used}/{budget.limit}</span>
                              </div>
                              <div className="h-1.5 overflow-hidden rounded-full bg-black/5">
                                <div className="h-full rounded-full" style={{ width: `${percent}%`, background: "var(--accent)" }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {run && (
                <div
                  className="agent-detail-tabs flex items-center gap-1 overflow-x-auto rounded-lg border p-1"
                  style={{
                    background: "color-mix(in srgb, var(--surface) 82%, var(--bg))",
                    borderColor: "var(--border)",
                  }}
                  role="tablist"
                  aria-label="Agent 任务详情"
                >
                  {([
                    ["evidence", `结论与依据 ${evidenceSummary.evidence.length}`, Database],
                    ["audit", `审计记录 ${run.events.length}`, History],
                  ] as const).map(([tab, label, Icon]) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={detailTab === tab}
                      onClick={() => setDetailTab(tab)}
                      className="inline-flex min-h-9 flex-shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition"
                      style={
                        detailTab === tab
                          ? { background: "var(--accent-light)", color: "var(--accent)" }
                          : { color: "var(--text-2)" }
                      }
                    >
                      <Icon size={15} />
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {run && detailTab === "evidence" && (
                <section
                  className="agent-evidence-panel agent-module-tint rounded-lg border p-5"
                  style={{
                    background: "var(--surface)",
                    borderColor: "color-mix(in srgb, var(--accent) 14%, var(--border))",
                  }}
                >
                  {evidenceSummary.evidence.length === 0 && evidenceSummary.conclusions.length === 0 ? (
                    <div className="py-10 text-center">
                      <Database size={24} className="mx-auto text-gray-300" />
                      <p className="mt-3 text-sm text-gray-400">暂无结论与依据</p>
                    </div>
                  ) : <div className="grid gap-8 lg:grid-cols-2">
                    <div>
                      <h2 className="mb-4 text-sm font-semibold text-gray-900">Agent 结论</h2>
                      <div className="space-y-3">
                        {evidenceSummary.conclusions.map((conclusion, index) => (
                          <div key={`${conclusion.text}:${index}`} className="border-l-2 pl-3" style={{ borderColor: "var(--accent)" }}>
                            <p className="text-sm leading-6 text-gray-700">{conclusion.text}</p>
                            <p className="mt-1 text-xs text-gray-400">
                              {conclusion.kind} · 置信度 {Math.round(conclusion.confidence * 100)}% · {conclusion.evidence_ids.length} 条依据
                            </p>
                            {conclusion.evidence_ids.length > 0 && (
                              <p className="mt-1 line-clamp-2 text-xs text-gray-500">
                                {conclusion.evidence_ids
                                  .map((id) => evidenceSummary.evidence.find((item) => item.evidence_id === id)?.label)
                                  .filter(Boolean)
                                  .join("、")}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h2 className="mb-4 text-sm font-semibold text-gray-900">证据引用</h2>
                      <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                        {evidenceSummary.evidence.map((item) => (
                          <div key={item.evidence_id} className="py-2.5 first:pt-0 last:pb-0">
                            <div className="flex items-center justify-between gap-3">
                              <p className="truncate text-sm text-gray-700">{item.label}</p>
                              <span className="text-xs text-gray-400">{item.source_type}</span>
                            </div>
                            {item.excerpt && <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{item.excerpt}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>}
                </section>
              )}

              {pendingApproval && (
                <div
                  className="agent-approval-panel rounded-lg border-2 p-5"
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
                      <p className="mt-1 text-xs text-gray-500">
                        风险：{pendingApproval.policy_decision?.risk ?? "medium"}
                        {pendingApproval.policy_decision?.reasons?.length
                          ? ` · ${pendingApproval.policy_decision.reasons.join("；")}`
                          : ""}
                      </p>
                      <p className="mt-1 font-mono text-xs text-gray-400">
                        Hash {pendingApproval.change_hash.slice(0, 12)}…
                      </p>
                    </div>
                    <span className="rounded-full bg-white/70 px-3 py-1 text-xs">
                      v{pendingApproval.change_set_version} · {pendingApproval.change_set.operations.length} 项修改
                    </span>
                  </div>
                  <EditableChangeSet
                    changeSet={pendingApproval.change_set}
                    disabled={busy}
                    onSave={saveChangeSet}
                  />
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
                      className="rounded-lg border bg-white/70 px-4 py-2 text-sm font-medium"
                    >
                      拒绝
                    </button>
                    <button
                      onClick={approvePending}
                      disabled={busy}
                      className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                      style={{ background: "var(--accent)" }}
                    >
                      {pendingApproval.policy_decision?.risk === "high"
                        ? "二次确认并执行"
                        : "批准并执行"}
                    </button>
                  </div>
                </div>
              )}

              {run && detailTab === "audit" && (
                <section
                  className="agent-audit-panel agent-module-tint rounded-lg border p-5"
                  style={{
                    background: "var(--surface)",
                    borderColor: "color-mix(in srgb, var(--accent) 14%, var(--border))",
                  }}
                >
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="flex items-center gap-2 font-semibold text-gray-900">
                      <History size={17} style={{ color: "var(--accent)" }} />
                      审计 Timeline
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      <select
                        value={eventActor}
                        onChange={(event) => setEventActor(event.target.value)}
                        className="min-h-9 rounded-lg border px-2 text-xs"
                        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                        aria-label="按 Agent 角色筛选审计事件"
                      >
                        <option value="all">全部角色</option>
                        {eventActors.map((actor) => <option key={actor} value={actor}>{roleLabel[actor] ?? actor}</option>)}
                      </select>
                      <select
                        value={eventType}
                        onChange={(event) => setEventType(event.target.value)}
                        className="min-h-9 rounded-lg border px-2 text-xs"
                        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                        aria-label="按类型筛选审计事件"
                      >
                        <option value="all">全部事件</option>
                        {eventTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-0">
                    {filteredEvents.length === 0 && <p className="py-4 text-center text-sm text-gray-400">没有符合筛选条件的事件</p>}
                    {filteredEvents.slice().reverse().map((event, index) => (
                      <div key={event.id} className="relative grid grid-cols-[12px_minmax(0,1fr)_auto] gap-3 pb-4 last:pb-0">
                        {index < filteredEvents.length - 1 && <span className="absolute bottom-0 left-[5px] top-3 w-px" style={{ background: "var(--border)" }} />}
                        <span className="relative z-10 mt-1 h-3 w-3 rounded-full border-2" style={{ borderColor: "var(--accent)", background: "var(--surface)" }} />
                        <div className="min-w-0"><p className="break-words text-sm text-gray-800">{event.summary || event.type}</p><p className="mt-0.5 text-xs text-gray-400">#{event.sequence} · {roleLabel[event.actor] ?? event.actor} · {event.type}</p></div>
                        <time className="text-xs text-gray-400">{formatRunDate(event.created_at, userTimezone)}</time>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
        </div>
      </section>
    </div>
  );
}
