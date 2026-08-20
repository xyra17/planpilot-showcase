import { api } from "@/lib/api";

export interface RuntimeOverview {
  strategy: {
    prompt: string;
    model: string;
    policy: string;
    deployment_revision: number;
  };
  metrics: {
    invocation_count: number;
    success_rate: number | null;
    proposal_count: number;
    helpful_rate: number | null;
  };
  safety: {
    requires_user_confirmation: boolean;
    direct_mutation_allowed: boolean;
  };
  monitoring: MonitoringOverview;
  feedback_learning: {
    event_count: number;
    delayed_outcome_count: number;
    metric_version: string;
  };
  latest_evaluation: EvaluationRun | null;
  canary: CanaryRelease | null;
  calibration: CalibrationOverview;
}

export interface MonitoringOverview {
  current: {
    date: string;
    health_status: "healthy" | "warning" | "critical";
    metrics: Record<string, number | null>;
  } | null;
  history: Array<{
    date: string;
    health_status: string;
    metrics: Record<string, number | null>;
  }>;
  drift: {
    status: "insufficient_data" | "stable" | "warning";
    success_rate_delta: number | null;
  };
  open_incidents: Array<{
    id: string;
    severity: string;
    status: string;
    trigger_metric: Record<string, unknown>;
    created_at: string;
  }>;
}

export interface AgentInvocation {
  id: string;
  user_id?: string | null;
  username?: string | null;
  goal_id?: string | null;
  goal_title?: string | null;
  proposal_id: string | null;
  prompt_version: string | null;
  model_name: string | null;
  policy_version: string | null;
  experiment_id: string | null;
  variant_id: string | null;
  success: boolean;
  fallback: boolean;
  latency_ms: number;
  total_tokens: number | null;
  trace_id: string;
  created_at: string;
}

export interface EvaluationRun {
  id: string;
  dataset_id: string;
  status: string;
  summary_metrics: {
    total?: number;
    passed?: number;
    pass_rate?: number;
    safety_pass_rate?: number;
    categories?: Record<string, number>;
  };
  started_at: string | null;
  finished_at: string | null;
}

export interface OnlineExperiment {
  id: string;
  name: string;
  hypothesis: string;
  status: string;
  allocation_percent: number;
  primary_metric: string;
  minimum_sample_size: number;
  variants: Array<{
    id: string;
    key: string;
    display_name: string;
    traffic_weight: number;
    is_control: boolean;
  }>;
}

export interface OfflineGate {
  id: string;
  evaluation_run_id: string;
  status: "passed" | "failed";
  criteria_version: string;
  metrics: {
    total: number;
    passed: number;
    pass_rate: number;
    safety_pass_rate: number;
    categories: Record<string, number>;
  };
  failures: Array<Record<string, unknown>>;
  dataset_hash: string;
  decided_at: string;
}

export interface CanaryVariantMetrics {
  id: string;
  key: string;
  display_name: string;
  is_control: boolean;
  exposures: number;
  accept_rate: number | null;
  completion_uplift: number | null;
  error_rate: number | null;
  fallback_rate: number | null;
  p95_latency_ms: number | null;
  estimated_cost: number | null;
}

export interface CanaryRelease {
  id: string;
  experiment_id: string;
  offline_gate_id: string;
  baseline_deployment_id: string;
  status: "running" | "paused" | "rolled_back" | "completed";
  current_stage: "internal" | "1" | "5" | "20" | "50" | "100";
  traffic_percent: number;
  stages: string[];
  guardrails: Record<string, number>;
  metrics: {
    exposures: number;
    acceptance_rate: number | null;
    completion_uplift: number | null;
    error_rate: number | null;
    fallback_rate: number | null;
    p95_latency_ms: number | null;
    total_tokens: number;
    estimated_cost: number | null;
    critical_safety_incidents: number;
    variants: CanaryVariantMetrics[];
  };
  observations: {
    total: number;
    exposures: number;
    decisions: number;
    outcomes: number;
    outcome_coverage: number | null;
    average_completion_after_advice: number | null;
  };
  advance_ready: boolean;
  advance_blockers: string[];
  transitions: Array<{
    id: string;
    from_stage: string | null;
    to_stage: string;
    action: string;
    reason: string;
    occurred_at: string;
  }>;
}

export interface AgentTrace {
  trace_id: string;
  invocation_id: string;
  user_id?: string | null;
  username?: string | null;
  goal_id?: string | null;
  goal_title?: string | null;
  total_latency_ms: number;
  total_tokens: number | null;
  estimated_cost: number | null;
  spans: Array<{
    span_id: string;
    parent_span_id: string | null;
    name: string;
    span_kind: string;
    status: string;
    latency_ms: number;
    attributes: Record<string, unknown>;
    error_category: string | null;
  }>;
}

export interface GatewayCircuit {
  route: string;
  storage: "redis" | "local_fallback";
  state: "closed" | "open" | "half_open";
  consecutive_failures: number;
  retry_after: number | null;
}

export interface CalibrationOverview {
  prediction_type: string;
  algorithm_version: string;
  sample_count: number;
  outcome_count: number;
  outcome_coverage: number | null;
  brier_score: number | null;
  expected_calibration_error: number | null;
  status: "insufficient_data" | "analysis_ready" | "calibration_ready";
  calculated_at: string | null;
}

export interface FeedbackEvent {
  id: string;
  proposal_id: string | null;
  feedback_type: string;
  value: Record<string, unknown>;
  attribution_window: string;
  occurred_at: string;
}

export interface AgentVersions {
  prompts: Array<{
    id: string;
    agent_type: string;
    name: string;
    version: string;
    status: string;
    change_note: string;
    content_hash: string;
    template: string;
    variables_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
  }>;
  models: Array<{
    id: string;
    name: string;
    version: string;
    provider: string;
    model_name: string;
    status: string;
    temperature: number;
    max_tokens: number;
  }>;
  policies: Array<{
    id: string;
    agent_type: string;
    name: string;
    version: string;
    status: string;
    rules: Record<string, unknown>;
    change_note: string;
  }>;
  deployments: Array<{
    id: string;
    environment: string;
    status: string;
    revision: number;
    prompt_version_id: string;
    model_config_id: string;
    policy_version_id: string;
    deployed_at: string;
  }>;
}

export const agentControlApi = {
  getOverview: () => api.get<RuntimeOverview>("/api/v1/agent-control/overview"),
  getInvocations: (limit = 30) =>
    api.get<AgentInvocation[]>(`/api/v1/agent-control/invocations?limit=${limit}`),
  getAdminInvocations: (limit = 100) =>
    api.get<AgentInvocation[]>(`/api/v1/agent-control/admin/invocations?limit=${limit}`),
  getTrace: (traceId: string) =>
    api.get<AgentTrace>(`/api/v1/agent-control/traces/${traceId}`),
  getGatewayCircuits: () =>
    api.get<GatewayCircuit[]>("/api/v1/agent-control/gateway/circuits"),
  getEvaluations: () =>
    api.get<EvaluationRun[]>("/api/v1/agent-control/evaluations"),
  getExperiments: () =>
    api.get<OnlineExperiment[]>("/api/v1/agent-control/experiments"),
  getFeedbackHistory: () =>
    api.get<FeedbackEvent[]>("/api/v1/agent-control/feedback-history"),
  getVersions: () => api.get<AgentVersions>("/api/v1/agent-control/versions"),
  getOfflineGates: () =>
    api.get<OfflineGate[]>("/api/v1/agent-control/offline-gates"),
  runEvaluation: () =>
    api.post<EvaluationRun>("/api/v1/agent-control/evaluations/run", {}),
  runOfflineGate: () =>
    api.post<OfflineGate>("/api/v1/agent-control/offline-gates/run", {}),
  createCanary: (body: {
    name: string;
    hypothesis: string;
    offline_gate_id: string;
    prompt_version_id: string;
    model_config_id: string;
    policy_version_id: string;
  }) => api.post<CanaryRelease>("/api/v1/agent-control/canary", body),
  advanceCanary: (releaseId: string) =>
    api.post<CanaryRelease>(`/api/v1/agent-control/canary/${releaseId}/advance`, {}),
  pauseCanary: (releaseId: string, reason: string) =>
    api.post<CanaryRelease>(`/api/v1/agent-control/canary/${releaseId}/pause`, { reason }),
  resumeCanary: (releaseId: string) =>
    api.post<CanaryRelease>(`/api/v1/agent-control/canary/${releaseId}/resume`, {}),
  rollbackCanary: (releaseId: string, reason: string) =>
    api.post<CanaryRelease>(`/api/v1/agent-control/canary/${releaseId}/rollback`, { reason }),
  aggregateCalibration: () =>
    api.post<CalibrationOverview>("/api/v1/agent-control/calibration/aggregate", {}),
  aggregateMonitoring: () =>
    api.post<{ date: string; health_status: string; metrics: Record<string, number | null> }>(
      "/api/v1/agent-control/monitoring/aggregate",
      {}
    ),
  createPromptVersion: (body: {
    agent_type: string;
    name: string;
    version: string;
    template: string;
    variables_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    change_note: string;
  }) => api.post<{ id: string; version: string; status: string }>("/api/v1/agent-control/prompts", body),
  createModelConfig: (body: {
    name: string;
    version: string;
    provider: "configured-router" | "local" | "smart";
    model_name: string;
    temperature: number;
    max_tokens: number;
  }) => api.post<{ id: string; version: string; status: string }>("/api/v1/agent-control/models", body),
  createPolicyVersion: (body: {
    agent_type: string;
    name: string;
    version: string;
    rules: Record<string, unknown>;
    change_note: string;
  }) => api.post<{ id: string; version: string; status: string }>("/api/v1/agent-control/policies", body),
  approveVersion: (kind: "prompt" | "model" | "policy", versionId: string) =>
    api.post<{ id: string; status: string }>(`/api/v1/agent-control/versions/${kind}/${versionId}/approve`, {}),
  deployVersions: (body: {
    agent_type: string;
    environment: string;
    prompt_version_id: string;
    model_config_id: string;
    policy_version_id: string;
  }) => api.post<{ id: string; revision: number; status: string }>("/api/v1/agent-control/deployments", body),
  rollbackDeployment: (targetDeploymentId: string, reason: string) =>
    api.post<{ deployment_id: string; revision: number; status: string }>(
      "/api/v1/agent-control/deployments/rollback",
      { target_deployment_id: targetDeploymentId, reason }
    ),
};
