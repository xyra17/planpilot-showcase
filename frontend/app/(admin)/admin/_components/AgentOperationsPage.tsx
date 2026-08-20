"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Beaker,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FlaskConical,
  Gauge,
  History,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import {
  agentControlApi,
  type AgentInvocation,
  type AgentTrace,
  type AgentVersions,
  type EvaluationRun,
  type FeedbackEvent,
  type OfflineGate,
  type OnlineExperiment,
  type RuntimeOverview,
  type GatewayCircuit,
} from "@/lib/agent-control-api";
import { StrategyManagerModal } from "@/components/admin/StrategyManagerModal";
import { useAuthStore } from "@/lib/stores/authStore";
import { cn } from "@/lib/utils";

const percent = (value: number | null | undefined) =>
  value == null ? "暂无数据" : `${Math.round(value * 100)}%`;

const dateTime = (value: string, timeZone: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(value));

const HEALTH_LABEL: Record<string, string> = {
  healthy: "运行健康",
  warning: "需要关注",
  critical: "严重异常",
  insufficient_data: "数据积累中",
  stable: "策略稳定",
};

const FEEDBACK_LABEL: Record<string, string> = {
  proposal_accepted: "接受建议",
  proposal_rejected: "拒绝建议",
  proposal_applied: "应用建议",
  proposal_adjusted: "调整建议",
  proposal_feedback: "建议评价",
  completion_rate_7d: "7 日效果回看",
};

const EXPERIMENT_STATUS: Record<string, string> = {
  draft: "草稿",
  approved: "已批准",
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
};

const CANARY_STATUS: Record<string, string> = {
  running: "运行中",
  paused: "已暂停",
  rolled_back: "已回滚",
  completed: "已完成",
};

const ENVIRONMENT_LABEL: Record<string, string> = {
  development: "开发环境",
  staging: "预发布环境",
  production: "生产环境",
};

function StatCard({
  label,
  value,
  note,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Activity;
  tone: "indigo" | "emerald" | "violet" | "amber";
}) {
  return (
    <div className={cn("pp-admin-stat-card rounded-2xl p-4", `pp-admin-stat-${tone}`)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500">{label}</span>
        <span className="pp-admin-stat-icon flex h-8 w-8 items-center justify-center rounded-xl">
          <Icon size={16} />
        </span>
      </div>
      <div className="mt-4 text-2xl font-semibold tracking-tight text-gray-900">{value}</div>
      <p className="mt-1 text-xs text-gray-400">{note}</p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/50 px-4 text-center">
      <Sparkles size={18} className="mb-2 text-gray-300" />
      <p className="text-xs leading-5 text-gray-400">{text}</p>
    </div>
  );
}

function CanaryMetricGroup({
  title,
  tone,
  items,
}: {
  title: string;
  tone: "violet" | "emerald";
  items: Array<[string, string]>;
}) {
  const violet = tone === "violet";
  return (
    <section className={cn("rounded-2xl border p-4", violet ? "border-violet-100 bg-violet-50/60" : "border-emerald-100 bg-emerald-50/60")}>
      <h3 className={cn("text-xs font-semibold", violet ? "text-violet-700" : "text-emerald-700")}>{title}</h3>
      <dl className="mt-3 divide-y divide-gray-100 rounded-xl bg-white px-4">
        {items.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 py-3">
            <dt className="text-[11px] text-gray-500">{label}</dt>
            <dd className="text-sm font-semibold text-gray-800">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function DeploymentDetailsModal({
  deployment,
  versions,
  busy,
  onClose,
  onRollback,
}: {
  deployment: AgentVersions["deployments"][number];
  versions: AgentVersions;
  busy: string | null;
  onClose: () => void;
  onRollback: (deploymentId: string) => void;
}) {
  const prompt = versions.prompts.find((item) => item.id === deployment.prompt_version_id);
  const model = versions.models.find((item) => item.id === deployment.model_config_id);
  const policy = versions.policies.find((item) => item.id === deployment.policy_version_id);
  const isActive = deployment.status === "active";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="deployment-details-title" className="w-full max-w-2xl overflow-hidden rounded-3xl border border-indigo-100 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 bg-gradient-to-r from-indigo-50/80 to-white px-6 py-5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[.16em] text-indigo-500">DEPLOYMENT DETAILS</div>
            <h2 id="deployment-details-title" className="mt-1 text-xl font-semibold text-gray-900">修订 {deployment.revision}</h2>
            <p className="mt-1 text-xs text-gray-500">该修订绑定了当时的提示词、模型与安全策略，历史调用不会被后续版本覆盖。</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭修订详情" className="rounded-xl p-2 text-gray-400 transition hover:bg-white hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cn("rounded-full px-2.5 py-1 font-semibold", isActive ? "bg-emerald-50 text-emerald-700" : deployment.status === "rolled_back" ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-600")}>
              {isActive ? "使用中" : deployment.status === "rolled_back" ? "已回滚" : "已停用"}
            </span>
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-500">{ENVIRONMENT_LABEL[deployment.environment] ?? deployment.environment}</span>
            <span className="text-gray-400">{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(deployment.deployed_at))}</span>
          </div>

          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4">
              <dt className="text-[11px] font-medium text-indigo-500">提示词</dt>
              <dd className="mt-2 break-words text-sm font-semibold text-gray-900">{prompt?.name ?? "版本已归档"}</dd>
              <dd className="mt-1 text-[11px] text-gray-500">{prompt ? `${prompt.version} · ${prompt.change_note || "无变更说明"}` : deployment.prompt_version_id}</dd>
            </div>
            <div className="rounded-2xl border border-cyan-100 bg-cyan-50/60 p-4">
              <dt className="text-[11px] font-medium text-cyan-600">模型</dt>
              <dd className="mt-2 break-words text-sm font-semibold text-gray-900">{model?.model_name ?? "配置已归档"}</dd>
              <dd className="mt-1 text-[11px] text-gray-500">{model ? `${model.provider} · ${model.version}` : deployment.model_config_id}</dd>
            </div>
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
              <dt className="text-[11px] font-medium text-emerald-600">安全策略</dt>
              <dd className="mt-2 break-words text-sm font-semibold text-gray-900">{policy?.name ?? "策略已归档"}</dd>
              <dd className="mt-1 text-[11px] text-gray-500">{policy ? `${policy.version} · ${policy.change_note || "无变更说明"}` : deployment.policy_version_id}</dd>
            </div>
          </dl>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50/70 px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-600 transition hover:border-gray-300 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">关闭</button>
          {!isActive && (
            <button type="button" onClick={() => onRollback(deployment.id)} disabled={busy != null} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
              <RotateCcw size={13} className="mr-1.5 inline" />{busy === `rollback:${deployment.id}` ? "回滚中…" : "回滚到此版本"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function GatewayDetailsModal({
  circuit,
  onClose,
}: {
  circuit: GatewayCircuit;
  onClose: () => void;
}) {
  const stateLabel = circuit.state === "closed" ? "健康" : circuit.state === "half_open" ? "半开探测" : "已熔断";
  const stateTone = circuit.state === "closed" ? "emerald" : circuit.state === "half_open" ? "amber" : "red";
  const retryAt = circuit.retry_after ? new Date(circuit.retry_after * 1000) : null;
  const retryLabel = retryAt && !Number.isNaN(retryAt.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(retryAt)
    : "当前没有冷却计时";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="gateway-details-title" className="w-full max-w-2xl overflow-hidden rounded-3xl border border-cyan-100 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 bg-gradient-to-r from-cyan-50/80 to-white px-6 py-5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[.16em] text-cyan-600">ROUTE HEALTH</div>
            <h2 id="gateway-details-title" className="mt-1 break-all text-xl font-semibold text-gray-900">{circuit.route}</h2>
            <p className="mt-1 text-xs text-gray-500">模型网关会在调用前保护这条路由，避免连续失败扩散到所有 Agent 请求。</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭网关详情" className="rounded-xl p-2 text-gray-400 transition hover:bg-white hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div className={cn("flex items-center gap-3 rounded-2xl border px-4 py-3", stateTone === "emerald" ? "border-emerald-100 bg-emerald-50/70" : stateTone === "amber" ? "border-amber-100 bg-amber-50/70" : "border-red-100 bg-red-50/70")}>
            <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", stateTone === "emerald" ? "bg-emerald-100 text-emerald-700" : stateTone === "amber" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700")}>
              {circuit.state === "closed" ? <CheckCircle2 size={18} /> : circuit.state === "half_open" ? <Activity size={18} /> : <AlertTriangle size={18} />}
            </span>
            <div>
              <div className="text-sm font-semibold text-gray-900">当前状态：{stateLabel}</div>
              <p className="mt-0.5 text-xs text-gray-500">{circuit.state === "closed" ? "请求可以正常通过，网关正在持续记录健康状态。" : circuit.state === "half_open" ? "网关只放行一个探测请求，成功后会恢复健康。" : "请求暂时被拦截，等待冷却结束后再进行探测。"}</p>
            </div>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4">
              <dt className="text-[11px] font-medium text-gray-500">状态来源</dt>
              <dd className="mt-2 text-sm font-semibold text-gray-900">{circuit.storage === "redis" ? "Redis 共享状态" : "本地应急状态"}</dd>
              <p className="mt-1 text-[11px] leading-5 text-gray-500">{circuit.storage === "redis" ? "多 Worker 读取同一份熔断状态，避免重复探测。" : "Redis 暂不可用，当前由本机临时维护状态。"}</p>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4">
              <dt className="text-[11px] font-medium text-gray-500">连续失败</dt>
              <dd className="mt-2 text-sm font-semibold text-gray-900">{circuit.consecutive_failures} 次</dd>
              <p className="mt-1 text-[11px] leading-5 text-gray-500">达到阈值后会自动暂停请求，防止模型服务雪崩。</p>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4 sm:col-span-2">
              <dt className="text-[11px] font-medium text-gray-500">下次探测时间</dt>
              <dd className="mt-2 text-sm font-semibold text-gray-900">{retryLabel}</dd>
              <p className="mt-1 text-[11px] leading-5 text-gray-500">冷却结束后网关会自动进行一次受控探测，不需要手动刷新或重启服务。</p>
            </div>
          </dl>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-100 bg-gray-50/70 px-6 py-4">
          <p className="text-[11px] text-gray-400">状态由 Agent 调用实时写入，详情页只读。</p>
          <button type="button" onClick={onClose} className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-600 transition hover:border-gray-300 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">关闭</button>
        </div>
      </div>
    </div>
  );
}

function CanaryRollbackModal({
  busy,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busy) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/25 p-4 backdrop-blur-sm" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="canary-rollback-title" aria-describedby="canary-rollback-description" className="w-full max-w-md overflow-hidden rounded-3xl border border-red-100 bg-white shadow-[0_24px_80px_rgba(15,23,42,.18)]">
        <div className="flex items-start justify-between gap-4 border-b border-red-100 bg-gradient-to-r from-red-50/80 to-white px-6 py-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-red-100 text-red-600"><RotateCcw size={17} /></span>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[.16em] text-red-500">ROLLBACK CONTROL</div>
              <h2 id="canary-rollback-title" className="mt-1 text-lg font-semibold text-gray-900">确认回滚当前 Canary？</h2>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭回滚确认" className="rounded-xl p-2 text-gray-400 transition hover:bg-white hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 px-6 py-5">
          <p id="canary-rollback-description" className="text-sm leading-6 text-gray-600">回滚会立即停止当前 Canary 流量，并恢复到当前生产基线版本。</p>
          <div className="rounded-2xl border border-red-100 bg-red-50/60 px-4 py-3 text-xs leading-5 text-red-700">
            回滚操作会写入审计记录；如需再次放量，需要重新创建一次 Canary 发布。
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50/70 px-6 py-4">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs font-semibold text-gray-600 transition hover:border-gray-300 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50">取消</button>
          <button type="button" onClick={onConfirm} disabled={busy} className="rounded-xl bg-red-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "回滚中…" : "确认回滚"}</button>
        </div>
      </div>
    </div>
  );
}

function TraceDetailsModal({
  trace,
  onClose,
}: {
  trace: AgentTrace;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="trace-details-title"
        data-testid="agent-trace-panel"
        className="flex max-h-[min(760px,calc(100vh-32px))] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-indigo-100 bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-100 bg-gradient-to-r from-indigo-50/80 to-white px-6 py-5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[.16em] text-indigo-500">TRACE DETAILS</div>
            <h2 id="trace-details-title" className="mt-1 text-xl font-semibold text-gray-900">调用审计详情</h2>
            <p className="mt-1 break-all text-xs text-gray-500">
              {trace.trace_id} · {trace.username ?? "未知账户"}
              {trace.goal_title ? ` · ${trace.goal_title}` : ""} · 脱敏执行时间线
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭调用审计详情"
            className="rounded-xl p-2 text-gray-400 transition hover:bg-white hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50/45 p-3">
              <div className="text-[10px] text-indigo-700">总耗时</div>
              <div className="mt-1 text-sm font-semibold text-gray-900">{trace.total_latency_ms} ms</div>
            </div>
            <div className="rounded-2xl border border-cyan-100 bg-cyan-50/45 p-3">
              <div className="text-[10px] text-cyan-700">Token 使用</div>
              <div className="mt-1 text-sm font-semibold text-gray-900">{trace.total_tokens ?? "暂无记录"}</div>
            </div>
          </div>

          {trace.spans.length === 0 ? (
            <div className="mt-4"><EmptyState text="这条调用还没有可展示的执行步骤。" /></div>
          ) : (
            <div className="mt-4 space-y-2">
              {trace.spans.map((span) => (
                <div key={span.span_id} className={cn("flex items-center gap-3 rounded-2xl border p-3", span.status === "ok" ? "border-emerald-100 bg-emerald-50/35" : "border-red-100 bg-red-50/45")}>
                  <span className={cn("h-2.5 w-2.5 rounded-full", span.status === "ok" ? "bg-emerald-500" : "bg-red-500")} />
                  <div className="flex-1">
                    <div className="text-xs font-semibold text-gray-700">
                      {span.name === "coach_agent_run" ? "Agent 运行" : span.name === "retrieve_decision_context" ? "读取决策上下文" : span.name === "model_call" ? "模型调用" : span.name === "tool_call" ? "工具调用" : span.name === "user_action" ? "用户操作" : "生成 Proposal"}
                    </div>
                    <div className="mt-0.5 text-[10px] text-gray-400">{span.error_category ?? span.span_kind}</div>
                  </div>
                  <span className="text-[11px] text-gray-400">{span.latency_ms} ms</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end border-t border-gray-100 bg-gray-50/70 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-600 transition hover:border-gray-300 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function AdminHeadingActions({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(document.getElementById("pp-admin-heading-actions"));
  }, []);

  return target ? createPortal(children, target) : null;
}

export type AdminOperationsView = "overview" | "canary" | "experiments" | "gateway" | "traces";

export default function AgentOperationsPage() {
  const pathname = usePathname();
  const view: AdminOperationsView = pathname.endsWith("/canary")
    ? "canary"
    : pathname.endsWith("/experiments")
      ? "experiments"
      : pathname.endsWith("/gateway")
        ? "gateway"
        : pathname.endsWith("/traces")
          ? "traces"
          : "overview";
  const user = useAuthStore((state) => state.user);
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [invocations, setInvocations] = useState<AgentInvocation[]>([]);
  const [evaluations, setEvaluations] = useState<EvaluationRun[]>([]);
  const [experiments, setExperiments] = useState<OnlineExperiment[]>([]);
  const [feedback, setFeedback] = useState<FeedbackEvent[]>([]);
  const [versions, setVersions] = useState<AgentVersions | null>(null);
  const [offlineGates, setOfflineGates] = useState<OfflineGate[]>([]);
  const [gatewayCircuits, setGatewayCircuits] = useState<GatewayCircuit[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<AgentTrace | null>(null);
  const [selectedDeployment, setSelectedDeployment] = useState<AgentVersions["deployments"][number] | null>(null);
  const [selectedGateway, setSelectedGateway] = useState<GatewayCircuit | null>(null);
  const [gateHistoryOpen, setGateHistoryOpen] = useState(false);
  const [canaryRollbackOpen, setCanaryRollbackOpen] = useState(false);
  const [strategyModalOpen, setStrategyModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextOverview, nextInvocations, nextEvaluations, nextExperiments, nextFeedback, nextVersions, nextGates, nextCircuits] =
        await Promise.all([
          agentControlApi.getOverview(),
          user?.is_admin ? agentControlApi.getAdminInvocations(100) : agentControlApi.getInvocations(30),
          agentControlApi.getEvaluations(),
          agentControlApi.getExperiments(),
          agentControlApi.getFeedbackHistory(),
          user?.is_admin ? agentControlApi.getVersions() : Promise.resolve(null),
          agentControlApi.getOfflineGates(),
          user?.is_admin ? agentControlApi.getGatewayCircuits() : Promise.resolve([]),
        ]);
      setOverview(nextOverview);
      setInvocations(nextInvocations);
      setEvaluations(nextEvaluations);
      setExperiments(nextExperiments);
      setFeedback(nextFeedback);
      setVersions(nextVersions);
      setOfflineGates(nextGates);
      setGatewayCircuits(nextCircuits);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "智能运营数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [user?.is_admin]);

  useEffect(() => {
    void load();
  }, [load]);

  const adminAction = async (action: "evaluation" | "gate" | "metrics" | "calibration") => {
    setBusy(action);
    setError(null);
    try {
      if (action === "evaluation") await agentControlApi.runEvaluation();
      else if (action === "gate") await agentControlApi.runOfflineGate();
      else if (action === "calibration") await agentControlApi.aggregateCalibration();
      else await agentControlApi.aggregateMonitoring();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(null);
    }
  };

  const inspectTrace = async (traceId: string) => {
    setBusy(`trace:${traceId}`);
    try {
      setSelectedTrace(await agentControlApi.getTrace(traceId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "调用审计读取失败");
    } finally {
      setBusy(null);
    }
  };

  const createCanary = async () => {
    const gate = offlineGates.find((row) => row.status === "passed");
    const prompt = versions?.prompts.find((row) => row.status === "approved");
    const model = versions?.models.find((row) => row.status === "approved");
    const policy = versions?.policies.find((row) => row.status === "approved");
    if (!gate || !prompt || !model || !policy) {
      setError("请先通过生产离线门禁，并确认候选版本均已批准。");
      return;
    }
    setBusy("create-canary");
    setError(null);
    try {
      await agentControlApi.createCanary({
        name: `Coach Canary ${new Date().toISOString()}`,
        hypothesis: "候选 Coach 策略在保持安全与可靠性基线的同时提升建议完成效果",
        offline_gate_id: gate.id,
        prompt_version_id: prompt.id,
        model_config_id: model.id,
        policy_version_id: policy.id,
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Canary 创建失败");
    } finally {
      setBusy(null);
    }
  };

  const executeCanaryAction = async (action: "advance" | "pause" | "resume" | "rollback") => {
    const canary = overview?.canary;
    if (!canary) return;
    setBusy(`canary:${action}`);
    setError(null);
    try {
      if (action === "advance") await agentControlApi.advanceCanary(canary.id);
      else if (action === "pause") await agentControlApi.pauseCanary(canary.id, "管理员从生产看板暂停");
      else if (action === "resume") await agentControlApi.resumeCanary(canary.id);
      else await agentControlApi.rollbackCanary(canary.id, "管理员从生产看板执行受控回滚");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Canary 操作失败");
    } finally {
      setBusy(null);
    }
  };

  const canaryAction = (action: "advance" | "pause" | "resume" | "rollback") => {
    if (action === "rollback") {
      setCanaryRollbackOpen(true);
      return;
    }
    void executeCanaryAction(action);
  };

  const rollback = async (deploymentId: string) => {
    setBusy(`rollback:${deploymentId}`);
    setError(null);
    try {
      await agentControlApi.rollbackDeployment(deploymentId, "从智能运营页面执行受控回滚");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "回滚失败");
    } finally {
      setBusy(null);
    }
  };

  const openGateHistory = () => {
    setGateHistoryOpen(true);
    requestAnimationFrame(() => {
      document.getElementById("production-gate-history")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  if (loading && !overview) {
    return (
      <div className="flex min-h-full items-center justify-center text-sm text-gray-400">
        <RefreshCw size={16} className="mr-2 animate-spin" />正在读取 Agent 运行状态…
      </div>
    );
  }

  const health = overview?.monitoring.current?.health_status ?? "insufficient_data";
  const drift = overview?.monitoring.drift.status ?? "insufficient_data";
  const latestEvaluation = evaluations[0] ?? overview?.latest_evaluation;
  const canary = overview?.canary;
  const hasCanaryObservations = Boolean(
    canary && (canary.metrics.exposures > 0 || canary.observations.total > 0)
  );
  const gatewayHealthyCount = gatewayCircuits.filter((circuit) => circuit.state === "closed").length;
  const gatewayAttentionCount = gatewayCircuits.length - gatewayHealthyCount;
  const traceSuccessCount = invocations.filter((invocation) => invocation.success).length;
  const traceFailureCount = invocations.length - traceSuccessCount;
  const traceAverageLatency = invocations.length > 0
    ? Math.round(invocations.reduce((total, invocation) => total + invocation.latency_ms, 0) / invocations.length)
    : 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-5 pb-8 sm:px-8" data-admin-view={view}>
      <AdminHeadingActions>
        <div className="pp-admin-heading-action-group">
          {user?.is_admin && (
            <>
              {view === "experiments" && (
                <button
                  onClick={() => void adminAction("evaluation")}
                  disabled={busy != null}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
                >
                  <FlaskConical size={14} className="mr-1.5 inline" />
                  {busy === "evaluation" ? "评估中…" : "运行离线评估"}
                </button>
              )}
              {view === "canary" && (
                <button
                  onClick={() => void adminAction("gate")}
                  disabled={busy != null}
                  data-testid="run-production-gate"
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
                >
                  <ShieldCheck size={14} className="mr-1.5 inline" />
                  {busy === "gate" ? "门禁执行中…" : "运行生产门禁"}
                </button>
              )}
              {view === "overview" && (
                <button
                  onClick={() => void adminAction("metrics")}
                  disabled={busy != null}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
                >
                  <Gauge size={14} className="mr-1.5 inline" />
                  {busy === "metrics" ? "聚合中…" : "刷新运行指标"}
                </button>
              )}
            </>
          )}
          <button
            onClick={() => void load()}
            disabled={loading}
            className="rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            <RefreshCw size={14} className={cn("mr-1.5 inline", loading && "animate-spin")} />刷新
          </button>
        </div>
      </AdminHeadingActions>

      {error && (
        <div className="mt-5 flex items-center gap-2 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
          <AlertTriangle size={16} />{error}
        </div>
      )}

      {view === "overview" && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Agent 调用"
          value={String(overview?.metrics.invocation_count ?? 0)}
          note={`成功率 ${percent(overview?.metrics.success_rate)}`}
          icon={Activity}
          tone="indigo"
        />
        <StatCard
          label="建议有效性"
          value={percent(overview?.metrics.helpful_rate)}
          note={`${overview?.metrics.proposal_count ?? 0} 条建议已进入审阅流程`}
          icon={CheckCircle2}
          tone="emerald"
        />
        <StatCard
          label="离线评估"
          value={percent(latestEvaluation?.summary_metrics.pass_rate)}
          note={`${latestEvaluation?.summary_metrics.passed ?? 0}/${latestEvaluation?.summary_metrics.total ?? 0} 个基准案例通过`}
          icon={FlaskConical}
          tone="violet"
        />
        <StatCard
          label="反馈学习事件"
          value={String(overview?.feedback_learning.event_count ?? 0)}
          note={`${overview?.feedback_learning.delayed_outcome_count ?? 0} 条延迟效果已归因`}
          icon={RotateCcw}
          tone="amber"
        />
      </div>}

      {view === "canary" && <section data-testid="production-canary-dashboard" className="pp-admin-panel pp-admin-panel-violet rounded-3xl border border-violet-100 bg-gradient-to-br from-white to-violet-50/50 p-5 shadow-[var(--shadow-xs)]">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck size={18} className="text-violet-600" />
              <h2 className="text-base font-semibold text-gray-900">生产 Canary 发布</h2>
            </div>
            <p className="mt-1 text-xs text-gray-500">离线门禁通过后，按内部、1%、5%、20%、50%、100% 逐级放量。</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {offlineGates[0] ? (
              <button type="button" data-testid="latest-production-gate" onClick={openGateHistory} className="group min-w-[270px] rounded-lg px-1.5 py-1 text-right transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">
                <span className={cn("flex items-center justify-end gap-2 text-[11px] font-semibold", offlineGates[0].status === "passed" ? "text-emerald-700" : "text-red-700")}>
                  {offlineGates[0].status === "passed" ? "允许进入 Canary" : "已阻止发布"}
                  <span className="text-sm font-semibold text-gray-400 transition group-hover:text-emerald-700">→</span>
                </span>
                <span className="mt-1 flex items-baseline justify-end gap-1 whitespace-nowrap text-[11px]">
                  <span className="font-medium text-gray-500">最近生产门禁：</span>
                  <span className={cn("font-semibold tracking-tight", offlineGates[0].status === "passed" ? "text-emerald-700" : "text-red-700")}>
                    {offlineGates[0].metrics.passed}/{offlineGates[0].metrics.total}
                  </span>
                  <span className="font-medium text-gray-500">个案例通过</span>
                </span>
              </button>
            ) : (
              <span className="text-[11px] font-medium text-gray-400">尚未运行生产门禁</span>
            )}
            {!canary && <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-500">尚未发布</span>}
          </div>
        </div>

        {canary ? (
          <>
            <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(250px,.55fr)]">
              <div className="rounded-2xl border border-violet-100 bg-white/80 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div><h3 className="text-xs font-semibold text-gray-800">放量进度</h3><p className="mt-1 text-[10px] text-gray-400">由管理员确认下一阶段，系统会先校验真实观测与安全护栏</p></div>
                  <span className="text-[10px] font-medium text-violet-600">当前：{canary.current_stage === "internal" ? "内部" : `${canary.current_stage}%`}</span>
                </div>
                <div className="mt-4 grid grid-cols-6 gap-1.5">
                  {canary.stages.map((stage) => {
                    const currentIndex = canary.stages.indexOf(canary.current_stage);
                    const stageIndex = canary.stages.indexOf(stage);
                    const isCurrent = stage === canary.current_stage;
                    const isNext = stageIndex === currentIndex + 1;
                    const isPausedNext = isNext && canary.status === "paused";
                    const stageLabel = stage === "internal" ? "内部" : `${stage}%`;
                    const stageState = isCurrent ? "当前" : stageIndex < currentIndex ? "已完成" : isPausedNext ? "已暂停" : isNext ? (canary.advance_ready ? "可升阶" : "等待护栏") : "待确认";
                    const stageClass = cn("rounded-xl border px-2 py-2.5 text-center transition", isCurrent ? "border-violet-300 bg-violet-100 text-violet-700 shadow-sm" : stageIndex < currentIndex ? "border-emerald-100 bg-emerald-50 text-emerald-700" : isPausedNext ? "border-amber-200 bg-amber-50 text-amber-700" : isNext ? "border-violet-200 bg-violet-50 text-violet-600" : "border-gray-100 bg-gray-50 text-gray-400");
                    const stageBody = <><div className="text-[11px] font-semibold">{stageLabel}</div><div className="mt-1 text-[9px] font-medium opacity-75">{stageState}</div><div className={cn("mx-auto mt-1.5 h-1.5 w-1.5 rounded-full", isCurrent ? "bg-violet-600" : stageIndex < currentIndex ? "bg-emerald-500" : isPausedNext ? "bg-amber-400" : isNext ? "bg-violet-400" : "bg-gray-200")} /></>;
                    return user?.is_admin && canary.status === "running" && isNext ? (
                      <button key={stage} type="button" data-testid="advance-canary" onClick={() => void canaryAction("advance")} disabled={busy != null || !canary.advance_ready} title={canary.advance_ready ? `确认放量至${stageLabel}` : "等待真实观测与安全护栏通过"} className={cn(stageClass, "cursor-pointer hover:-translate-y-0.5 hover:border-violet-400 hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:cursor-not-allowed disabled:opacity-50")}>
                        {stageBody}
                      </button>
                    ) : <div key={stage} className={stageClass}>{stageBody}</div>;
                  })}
                </div>
                {user?.is_admin && canary.status === "running" && (
                  <p className="mt-3 text-[10px] text-violet-600/80">{canary.advance_ready ? "点击“可升阶”阶段即可确认放量；每次只推进一个阶段。" : `暂不能升阶：${canary.advance_blockers.join("、") || "等待数据积累"}`}</p>
                )}
                {user?.is_admin && canary.status === "paused" && (
                  <p className="mt-3 text-[10px] text-amber-700/80">当前阶段已暂停；请确认指标后使用“继续放量”恢复，或回滚到基线。</p>
                )}
              </div>

              <div className={cn("rounded-2xl border p-4", canary.status === "running" ? "border-violet-200 bg-violet-50" : canary.status === "paused" ? "border-amber-200 bg-amber-50" : canary.status === "completed" ? "border-emerald-100 bg-emerald-50" : "border-red-100 bg-red-50")}>
                <span className="text-[10px] font-semibold uppercase tracking-[.12em] text-gray-500">Release status</span>
                <div className="mt-3 text-xl font-semibold text-gray-900">{CANARY_STATUS[canary.status] ?? canary.status}</div>
                <p className="mt-2 text-xs leading-5 text-gray-500">{canary.status === "running" ? `正在向${canary.current_stage === "internal" ? "内部用户" : `${canary.current_stage}% 用户`}开放，等待观测窗口完成。` : canary.status === "rolled_back" ? "本次发布已停止，生产流量已恢复到基线版本。" : canary.status === "paused" ? "流量放量已暂停，可在确认指标后继续或回滚。" : "本次渐进发布已完成全部阶段。"}</p>
              </div>
            </div>

            {hasCanaryObservations ? (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <CanaryMetricGroup title="效果指标" tone="violet" items={[["暴露用户", String(canary.metrics.exposures)], ["建议接受率", percent(canary.metrics.acceptance_rate)], ["完成率提升", percent(canary.metrics.completion_uplift)]]} />
                <CanaryMetricGroup title="风险护栏" tone="emerald" items={[["错误率", percent(canary.metrics.error_rate)], ["P95 延迟", canary.metrics.p95_latency_ms == null ? "暂无数据" : `${canary.metrics.p95_latency_ms} ms`], ["安全事件", String(canary.metrics.critical_safety_incidents)]]} />
              </div>
            ) : (
              <div className="mt-4 flex flex-col gap-4 rounded-2xl border border-dashed border-violet-200 bg-white/70 p-5 sm:flex-row sm:items-center">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-100 text-violet-600"><Activity size={19} /></span>
                <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-gray-800">尚未形成真实观测窗口</h3><p className="mt-1 text-xs leading-5 text-gray-400">不再展示六个重复的“暂无数据”指标。Canary 产生真实流量后，这里会自动拆分为效果指标和风险护栏。</p></div>
                <div className="flex shrink-0 gap-4 rounded-xl bg-gray-50 px-4 py-3 text-center"><div><strong className="block text-sm text-gray-800">{canary.observations.exposures}</strong><span className="text-[9px] text-gray-400">暴露</span></div><div><strong className="block text-sm text-gray-800">{canary.observations.decisions}</strong><span className="text-[9px] text-gray-400">决策</span></div><div><strong className="block text-sm text-gray-800">{canary.observations.outcomes}</strong><span className="text-[9px] text-gray-400">结果</span></div></div>
              </div>
            )}

            <div className="mt-5 flex flex-col gap-4 border-t border-violet-100 pt-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", canary.advance_ready ? "bg-emerald-100 text-emerald-700" : "bg-amber-50 text-amber-700")}><ShieldCheck size={15} /></span>
                <div><p className="text-xs font-semibold text-gray-700">{canary.status === "paused" ? "当前已暂停：确认指标后可继续放量" : canary.advance_ready ? "满足下一阶段条件" : `暂不可升阶：${canary.advance_blockers.join("、") || "当前发布状态不支持升阶"}`}</p><p className="mt-1 text-[10px] text-gray-400">校准状态：{overview.calibration.status === "insufficient_data" ? "数据积累中" : overview.calibration.status === "analysis_ready" ? "可离线分析" : "可创建新版本"}</p></div>
              </div>
              {user?.is_admin && ["running", "paused"].includes(canary.status) && <div className="flex shrink-0 flex-wrap gap-2">{canary.status === "running" && <button onClick={() => void canaryAction("pause")} disabled={busy != null} className="rounded-xl border border-amber-200 bg-white px-3 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-50 disabled:opacity-40">暂停放量</button>}{canary.status === "paused" && <button data-testid="resume-canary" onClick={() => void canaryAction("resume")} disabled={busy != null} className="rounded-xl bg-violet-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:opacity-40">{busy === "canary:resume" ? "恢复中…" : "继续放量"}</button>}<button data-testid="rollback-canary" onClick={() => void canaryAction("rollback")} disabled={busy != null} className="rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-40">回滚到基线</button></div>}
              {user?.is_admin && ["rolled_back", "completed"].includes(canary.status) && <button data-testid="create-canary" onClick={() => void createCanary()} disabled={busy != null || !offlineGates.some((row) => row.status === "passed")} className="shrink-0 rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-40">{busy === "create-canary" ? "创建中…" : "创建下一次 Coach Canary"}</button>}
            </div>
          </>
        ) : (
          <div className="mt-5 rounded-2xl border border-dashed border-violet-200 bg-white/70 p-5 text-center">
            <p className="text-sm font-medium text-gray-700">当前没有 Coach Canary</p>
            <p className="mt-1 text-xs text-gray-400">最近生产门禁：{offlineGates[0] ? `${offlineGates[0].status === "passed" ? "已通过" : "未通过"} · ${offlineGates[0].metrics.total} 个案例` : "尚未运行"}</p>
            {user?.is_admin && (
              <button data-testid="create-canary" onClick={() => void createCanary()} disabled={busy != null || !offlineGates.some((row) => row.status === "passed")} className="mt-4 rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">
                {busy === "create-canary" ? "创建中…" : "创建 Coach Canary"}
              </button>
            )}
          </div>
        )}
      </section>}

      {view === "canary" && (
        <details id="production-gate-history" open={gateHistoryOpen} onToggle={(event) => setGateHistoryOpen((event.currentTarget as HTMLDetailsElement).open)} className="pp-admin-panel pp-admin-panel-emerald pp-admin-collapsible mt-5 scroll-mt-6 rounded-3xl border border-gray-100 bg-white shadow-[var(--shadow-xs)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck size={17} className="text-emerald-600" />
              <div>
                <h2 className="text-base font-semibold text-gray-900">生产门禁记录</h2>
                <p className="text-xs text-gray-500">Canary 发布前的质量判定和基准数据版本，历史记录集中在这里。</p>
              </div>
            </div>
            <ChevronDown size={18} className="shrink-0 text-gray-400" />
          </summary>
          <div className="px-5 pb-5">
            {offlineGates.length === 0 ? (
              <EmptyState text="尚无生产门禁记录。运行生产门禁后会在这里显示结果。" />
            ) : (
              <div className="space-y-3">
                {offlineGates.slice(0, 6).map((gate) => (
                  <div key={gate.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/45 p-4">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">{gate.metrics.passed}/{gate.metrics.total} 个基准案例通过</div>
                      <p className="mt-1 text-[11px] text-gray-500">标准 {gate.criteria_version} · {dateTime(gate.decided_at, user?.timezone ?? "Asia/Shanghai")}</p>
                    </div>
                    <span className={cn("rounded-full px-2.5 py-1 text-[10px] font-semibold", gate.status === "passed" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700")}>{gate.status === "passed" ? "已通过" : "未通过"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      )}

      {view === "overview" && <div className="mt-5 grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
        <section id="strategy" className="pp-admin-panel pp-admin-panel-indigo scroll-mt-24 rounded-3xl border border-gray-100 bg-white p-5 shadow-[var(--shadow-xs)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">当前生产策略</h2>
              <p className="mt-1 text-xs text-gray-400">每次生成建议都会记录本次实际使用的版本。</p>
            </div>
            <button type="button" onClick={() => setStrategyModalOpen(true)} className="flex items-center gap-1.5 rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:border-indigo-200 hover:bg-indigo-100">
              <Settings2 size={14} />管理策略 · 修订 {overview?.strategy.deployment_revision ?? "—"}
            </button>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {[
              ["提示词", overview?.strategy.prompt],
              ["模型", overview?.strategy.model],
              ["安全策略", overview?.strategy.policy],
            ].map(([label, value]) => (
              <button type="button" onClick={() => setStrategyModalOpen(true)} key={label} className="group rounded-2xl bg-gray-50 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-sm">
                <div className="text-[11px] font-medium text-gray-400">{label}</div>
                <div className="mt-2 break-words text-sm font-semibold text-gray-800">{value ?? "—"}</div>
                <div className="mt-2 text-[9px] font-medium text-indigo-500 opacity-0 transition group-hover:opacity-100">查看详情与版本管理</div>
              </button>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
            <ShieldCheck size={20} className="shrink-0 text-emerald-600" />
            <div>
              <div className="text-sm font-semibold text-emerald-800">用户审阅网关已开启</div>
              <p className="mt-0.5 text-xs text-emerald-700/70">
                Agent 只能创建建议，不能绕过接受、应用和反馈流程直接修改业务数据。
              </p>
            </div>
          </div>
        </section>

        <section id="health" className="pp-admin-panel pp-admin-panel-emerald scroll-mt-24 rounded-3xl border border-gray-100 bg-white p-5 shadow-[var(--shadow-xs)]">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-900">在线健康与漂移</h2>
              <p className="mt-1 text-xs text-gray-400">每日聚合延迟、回退率、接受率和策略变化。</p>
            </div>
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-semibold",
                health === "healthy"
                  ? "bg-emerald-50 text-emerald-700"
                  : health === "critical"
                    ? "bg-red-50 text-red-700"
                    : "bg-amber-50 text-amber-700"
              )}
            >
              {HEALTH_LABEL[health] ?? health}
            </span>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-gray-50 p-4">
              <div className="text-[11px] text-gray-400">漂移状态</div>
              <div className="mt-2 text-sm font-semibold text-gray-800">{HEALTH_LABEL[drift] ?? drift}</div>
              <div className="mt-1 text-xs text-gray-400">
                成功率变化 {overview?.monitoring.drift.success_rate_delta == null ? "—" : percent(overview.monitoring.drift.success_rate_delta)}
              </div>
            </div>
            <div className="rounded-2xl bg-gray-50 p-4">
              <div className="text-[11px] text-gray-400">开放事件</div>
              <div className="mt-2 text-sm font-semibold text-gray-800">{overview?.monitoring.open_incidents.length ?? 0} 个</div>
              <div className="mt-1 text-xs text-gray-400">异常可追踪，并支持受控回滚</div>
            </div>
          </div>
          {!overview?.monitoring.current && (
            <div className="mt-3 rounded-xl bg-accent-light px-3 py-2 text-xs text-accent">
              指标将在后台每日自动聚合；当前正在积累首个完整观察窗口。
            </div>
          )}
        </section>
      </div>}

      {view === "experiments" && user?.is_admin && versions && (
        <section className="pp-admin-panel pp-admin-panel-indigo rounded-3xl border border-gray-100 bg-white p-5 shadow-[var(--shadow-xs)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">版本与发布</h2>
              <p className="mt-1 text-xs text-gray-500">仅管理员可见；点击修订查看完整配置，回滚会创建新修订，不改写历史调用。</p>
            </div>
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold text-gray-500">
              {versions.prompts.length} 个提示词版本 · {versions.models.length} 个模型配置
            </span>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {versions.deployments.slice(0, 6).map((deployment) => (
              <div key={deployment.id} className="rounded-2xl border border-gray-200 bg-white/80 p-3 transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-[0_10px_24px_rgba(79,70,229,.08)]">
                <button type="button" onClick={() => setSelectedDeployment(deployment)} className="w-full rounded-xl p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-gray-900">修订 {deployment.revision}</span>
                    <span className={cn("rounded-full px-2 py-1 text-[10px] font-semibold", deployment.status === "active" ? "bg-emerald-50 text-emerald-700" : deployment.status === "rolled_back" ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-500")}>
                      {deployment.status === "active" ? "使用中" : deployment.status === "rolled_back" ? "已回滚" : "已停用"}
                    </span>
                  </div>
                  <div className="mt-2 text-[11px] text-gray-500">环境：{ENVIRONMENT_LABEL[deployment.environment] ?? "自定义环境"} · {dateTime(deployment.deployed_at, user?.timezone ?? "Asia/Shanghai")}</div>
                  <div className="mt-3 text-[11px] font-semibold text-indigo-600">查看修订详情 <span aria-hidden="true">→</span></div>
                </button>
                {deployment.status !== "active" && (
                  <button
                    onClick={() => void rollback(deployment.id)}
                    disabled={busy != null}
                    className="mt-3 w-full rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 transition hover:border-amber-300 hover:text-amber-700 disabled:opacity-50"
                  >
                    <RotateCcw size={13} className="mr-1.5 inline" />
                    {busy === `rollback:${deployment.id}` ? "回滚中…" : "回滚到此版本"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {view === "experiments" && (
        <div className="mt-5 grid gap-5">
          <details open className="pp-admin-panel pp-admin-panel-violet pp-admin-collapsible rounded-3xl border border-gray-100 bg-white shadow-[var(--shadow-xs)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
              <div className="flex items-center gap-2">
                <FlaskConical size={17} className="text-violet-600" />
                <div>
                  <h2 className="text-base font-semibold text-gray-900">最近离线评估</h2>
                  <p className="text-xs text-gray-500">候选策略需先通过固定基准案例，才能进入生产门禁。</p>
                </div>
              </div>
              <ChevronDown size={18} className="shrink-0 text-gray-400" />
            </summary>
            <div className="px-5 pb-5">
              {evaluations.length === 0 ? (
                <EmptyState text="尚无离线评估记录。运行评估后会在这里显示通过率和安全指标。" />
              ) : (
                <div className="space-y-3">
                  {evaluations.slice(0, 4).map((evaluation) => (
                    <div key={evaluation.id} className="flex items-center justify-between rounded-2xl border border-violet-100 bg-violet-50/45 p-4">
                      <div>
                        <div className="text-sm font-semibold text-gray-900">通过率 {percent(evaluation.summary_metrics.pass_rate)}</div>
                        <p className="mt-1 text-[11px] text-gray-500">{evaluation.summary_metrics.passed ?? 0}/{evaluation.summary_metrics.total ?? 0} 个案例 · 安全通过率 {percent(evaluation.summary_metrics.safety_pass_rate)}</p>
                      </div>
                      <span className={cn("rounded-full px-2.5 py-1 text-[10px] font-semibold", evaluation.status === "completed" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>{evaluation.status === "completed" ? "已完成" : "运行中"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        </div>
      )}

      {view === "gateway" && user?.is_admin && (
        <section className="pp-admin-panel pp-admin-panel-cyan rounded-3xl border border-gray-100 bg-white p-5 shadow-[var(--shadow-xs)]">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
            <div>
              <div className="flex items-center gap-2">
                <Activity size={18} className="text-cyan-600" />
                <h2 className="text-base font-semibold text-gray-900">模型网关状态</h2>
              </div>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-gray-500">这里用于监控 Agent 调用模型时的路由健康度。网关会记录连续失败，在异常时自动熔断并保护其它请求。</p>
            </div>
            <span className="shrink-0 rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-semibold text-cyan-700">{gatewayCircuits.length} 条路由 · Redis 共享</span>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-cyan-100 bg-cyan-50/55 p-4"><div className="text-[11px] font-medium text-cyan-700">监控路由</div><div className="mt-2 text-2xl font-semibold text-gray-900">{gatewayCircuits.length}</div><p className="mt-1 text-[11px] text-gray-500">模型调用入口</p></div>
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50/55 p-4"><div className="text-[11px] font-medium text-emerald-700">健康路由</div><div className="mt-2 text-2xl font-semibold text-gray-900">{gatewayHealthyCount}</div><p className="mt-1 text-[11px] text-gray-500">当前可正常调用</p></div>
            <div className={cn("rounded-2xl border p-4", gatewayAttentionCount > 0 ? "border-amber-100 bg-amber-50/60" : "border-gray-200 bg-gray-50/70")}><div className={cn("text-[11px] font-medium", gatewayAttentionCount > 0 ? "text-amber-700" : "text-gray-500")}>需要关注</div><div className="mt-2 text-2xl font-semibold text-gray-900">{gatewayAttentionCount}</div><p className="mt-1 text-[11px] text-gray-500">半开探测或熔断中</p></div>
          </div>
          <div className="mt-5 flex items-center justify-between gap-3">
            <div><h3 className="text-sm font-semibold text-gray-900">路由健康列表</h3><p className="mt-1 text-xs text-gray-500">点击任一路由查看熔断详情和自动恢复策略。</p></div>
            <span className="hidden text-[11px] text-gray-400 sm:block">只读监控</span>
          </div>
          {gatewayCircuits.length === 0 ? (
            <div className="mt-3"><EmptyState text="暂时没有可监控的模型路由。请先配置模型版本。" /></div>
          ) : (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {gatewayCircuits.map((circuit) => (
                <button type="button" key={circuit.route} onClick={() => setSelectedGateway(circuit)} className="group rounded-2xl border border-cyan-100 bg-white/80 p-4 text-left transition hover:-translate-y-0.5 hover:border-cyan-300 hover:bg-cyan-50/35 hover:shadow-[0_10px_24px_rgba(14,116,144,.1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-semibold text-gray-900">{circuit.route}</span>
                    <span className={cn("shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold", circuit.state === "closed" ? "bg-emerald-100 text-emerald-700" : circuit.state === "half_open" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700")}>{circuit.state === "closed" ? "健康" : circuit.state === "half_open" ? "半开探测" : "熔断中"}</span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div><div className="text-[10px] text-gray-400">连续失败</div><div className="mt-1 text-sm font-semibold text-gray-800">{circuit.consecutive_failures} 次</div></div>
                    <div><div className="text-[10px] text-gray-400">状态来源</div><div className="mt-1 text-sm font-semibold text-gray-800">{circuit.storage === "redis" ? "Redis" : "本地应急"}</div></div>
                  </div>
                  <div className="mt-4 text-[11px] font-semibold text-cyan-700 opacity-80 transition group-hover:opacity-100">查看路由详情 <span aria-hidden="true">→</span></div>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {view === "traces" && (
        <section className="pp-admin-panel pp-admin-panel-cyan rounded-3xl border border-gray-100 bg-white p-5 shadow-[var(--shadow-xs)]">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
            <div>
              <div className="flex items-center gap-2">
                <History size={18} className="text-cyan-600" />
                <h2 className="text-base font-semibold text-gray-900">Agent 调用审计用于什么</h2>
              </div>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-gray-500">这里用于排查全体账户的 Agent 调用：读取决策上下文、模型请求、工具调用和 Proposal 创建。仅展示脱敏运行元数据，不保存原始 Prompt 或输入内容。</p>
            </div>
            <span className="shrink-0 rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-semibold text-cyan-700">全系统 · 只读审计</span>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-cyan-100 bg-cyan-50/55 p-4"><div className="text-[11px] font-medium text-cyan-700">已采集调用</div><div className="mt-2 text-2xl font-semibold text-gray-900">{invocations.length}</div><p className="mt-1 text-[11px] text-gray-500">最近 100 条系统记录</p></div>
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50/55 p-4"><div className="text-[11px] font-medium text-emerald-700">成功调用</div><div className="mt-2 text-2xl font-semibold text-gray-900">{traceSuccessCount}</div><p className="mt-1 text-[11px] text-gray-500">正常完成的生成</p></div>
            <div className={cn("rounded-2xl border p-4", traceFailureCount > 0 ? "border-amber-100 bg-amber-50/60" : "border-gray-200 bg-gray-50/70")}><div className={cn("text-[11px] font-medium", traceFailureCount > 0 ? "text-amber-700" : "text-gray-500")}>平均延迟</div><div className="mt-2 text-2xl font-semibold text-gray-900">{traceAverageLatency} <span className="text-sm font-medium">ms</span></div><p className="mt-1 text-[11px] text-gray-500">失败调用 {traceFailureCount} 条</p></div>
          </div>
        </section>
      )}

      {(view === "experiments" || view === "traces") && <div className="mt-5 grid gap-5">
        {view === "experiments" && <details className="pp-admin-panel pp-admin-panel-amber pp-admin-collapsible rounded-3xl border border-gray-100 bg-white shadow-[var(--shadow-xs)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
            <div className="flex items-center gap-2">
              <Beaker size={17} className="text-amber-600" />
              <div>
                <h2 className="text-base font-semibold text-gray-900">在线实验</h2>
                <p className="text-xs text-gray-500">固定分流，同一用户始终进入同一变体。</p>
              </div>
            </div>
            <ChevronDown size={18} className="shrink-0 text-gray-400" />
          </summary>
          <div className="px-5 pb-5">
            {experiments.length === 0 ? (
              <EmptyState text="目前没有在线实验。新策略会先经过离线评估和审批，再逐步分流。" />
            ) : (
              <div className="space-y-3">
                {experiments.slice(0, 4).map((experiment) => (
                  <div key={experiment.id} className="rounded-2xl border border-amber-100 bg-amber-50/35 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-gray-900">{experiment.name}</div>
                        <p className="mt-1 text-xs leading-5 text-gray-500">{experiment.hypothesis}</p>
                      </div>
                      <span className="rounded-full bg-accent-light px-2 py-1 text-[10px] font-semibold text-accent-dark">
                        {EXPERIMENT_STATUS[experiment.status] ?? "未知状态"}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {experiment.variants.map((variant) => (
                        <span key={variant.id} className="rounded-lg bg-white/80 px-2 py-1 text-[11px] text-gray-600">
                          {variant.display_name}{variant.is_control ? " · 对照" : ""} · {Math.round(variant.traffic_weight * 100)}%
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>}

        {view === "traces" && <section className="pp-admin-panel pp-admin-panel-indigo rounded-3xl border border-gray-100 bg-white p-5 shadow-[var(--shadow-xs)]">
          <div className="mb-4 flex items-center gap-2">
            <History size={17} className="text-[var(--accent)]" />
            <div>
              <h2 className="text-base font-semibold text-gray-900">最近系统调用</h2>
              <p className="text-xs text-gray-400">按时间列出各账户的运行结果；点击记录查看脱敏 Trace 详情。</p>
            </div>
          </div>
          {invocations.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-cyan-200 bg-cyan-50/45 px-5 py-8 text-center">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-700"><History size={19} /></span>
              <h3 className="mt-3 text-sm font-semibold text-gray-900">暂时没有系统调用记录</h3>
              <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-gray-500">当任一账户触发学习伙伴建议后，这里会按时间列出脱敏调用链。原始 Prompt 和跨用户上下文不会在后台页面展示。</p>
            </div>
          ) : (
            <div className="space-y-2">
              {invocations.slice(0, 6).map((invocation) => (
                <button type="button" onClick={() => void inspectTrace(invocation.trace_id)} disabled={busy?.startsWith("trace:")} key={invocation.id} aria-label={`查看 ${invocation.username ?? "未知账户"} 的调用详情`} className="group flex w-full items-center gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/40 px-4 py-3 text-left transition hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-indigo-50/70 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:cursor-wait disabled:opacity-60">
                  <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", invocation.success ? "bg-emerald-500" : "bg-amber-400")} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-gray-700">
                      {invocation.fallback ? "安全回退生成" : "模型生成完成"}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-gray-400">
                      {invocation.username ?? "未知账户"}
                      {invocation.goal_title ? ` · ${invocation.goal_title}` : ""}
                      {invocation.variant_id ? " · 实验变体" : ""}
                    </div>
                  </div>
                  <div className="text-right text-[10px] text-gray-400">
                    <div>{invocation.latency_ms} ms</div>
                    <div>{dateTime(invocation.created_at, user?.timezone ?? "Asia/Shanghai")}</div>
                  </div>
                  <span className="hidden text-[11px] font-semibold text-indigo-600 opacity-70 transition group-hover:opacity-100 sm:block">{busy === `trace:${invocation.trace_id}` ? "读取中…" : "查看详情 →"}</span>
                </button>
              ))}
            </div>
          )}
        </section>}
      </div>}

      {view === "overview" && <section className="pp-admin-panel pp-admin-panel-amber mt-5 rounded-3xl border border-gray-100 bg-white p-5 shadow-[var(--shadow-xs)]">
        <div className="flex items-center gap-2">
          <RotateCcw size={17} className="text-[var(--accent)]" />
          <div>
            <h2 className="text-base font-semibold text-gray-900">反馈学习链路</h2>
            <p className="text-xs text-gray-400">即时选择与后续完成效果分别记录，避免把相关性误当因果。</p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          {["建议", "用户选择", "延迟效果", "策略评估"].map((label, index) => (
            <div key={label} className="relative rounded-2xl bg-gray-50 p-4">
              <div className="text-[10px] font-semibold text-[var(--accent)]">0{index + 1}</div>
              <div className="mt-2 text-sm font-semibold text-gray-800">{label}</div>
              {index < 3 && <span className="absolute -right-2 top-1/2 hidden h-px w-4 bg-gray-200 md:block" />}
            </div>
          ))}
        </div>
        {feedback.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {feedback.slice(0, 8).map((event) => (
              <span key={event.id} className="rounded-full border border-gray-100 bg-white px-3 py-1.5 text-[11px] text-gray-500">
                {FEEDBACK_LABEL[event.feedback_type] ?? event.feedback_type} · {event.attribution_window === "immediate" ? "即时" : event.attribution_window}
              </span>
            ))}
          </div>
        )}
      </section>}

      <div className="mt-5 flex items-center gap-2 text-[11px] text-gray-400">
        <LockKeyhole size={13} />版本发布与回滚仅对管理员开放，所有操作均保留审计记录。
        <Clock3 size={13} className="ml-2" />后台任务每日聚合运行指标与延迟反馈。
      </div>

      {user?.is_admin && versions && (
        <StrategyManagerModal
          open={strategyModalOpen}
          versions={versions}
          onClose={() => setStrategyModalOpen(false)}
          onChanged={load}
        />
      )}

      {user?.is_admin && versions && selectedDeployment && (
        <DeploymentDetailsModal
          deployment={selectedDeployment}
          versions={versions}
          busy={busy}
          onClose={() => setSelectedDeployment(null)}
          onRollback={(deploymentId) => void rollback(deploymentId)}
        />
      )}

      {user?.is_admin && selectedGateway && (
        <GatewayDetailsModal
          circuit={selectedGateway}
          onClose={() => setSelectedGateway(null)}
        />
      )}

      {user?.is_admin && canaryRollbackOpen && (
        <CanaryRollbackModal
          busy={busy === "canary:rollback"}
          onClose={() => setCanaryRollbackOpen(false)}
          onConfirm={() => {
            setCanaryRollbackOpen(false);
            void executeCanaryAction("rollback");
          }}
        />
      )}

      {view === "traces" && selectedTrace && (
        <TraceDetailsModal
          trace={selectedTrace}
          onClose={() => setSelectedTrace(null)}
        />
      )}
    </div>
  );
}
