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
  model_roles: Record<"interactive" | "structured" | "critical" | "embedding", {
    purpose: string;
    primary: string;
    primary_model: string;
    fallback: string | null;
    fallback_model: string | null;
    fallback_policy: string;
    result: string;
    max_concurrency: number;
  }>;
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

export interface BetaMetrics {
  metric_version: string;
  measurement_start: string;
  measurement_end: string;
  cohort: "beta" | "stable" | "all";
  source: "conversation" | "insight" | "scheduler" | "api" | "internal" | "legacy_unattributed" | "all";
  sample_size: number;
  insufficient_data: boolean;
  counts: Record<string, number>;
  rates: Record<string, number | null>;
  rate_details: Record<string, { numerator: number; denominator: number; value: number | null }>;
  source_funnel: Record<string, number>;
  latency: { preview_p50_ms: number | null; preview_p95_ms: number | null };
  safety: BetaSafetyStatus;
  expansion_blocked: boolean;
}

export interface BetaSafetyStatus {
  status: "unknown" | "stale" | "observed_clear" | "violated";
  counts: Record<string, number> | null;
  observed_at: string | null;
  expires_at: string | null;
  source: string | null;
  source_gate_id?: string | null;
  audit_window?: { start: string; end: string };
  deployed_revision?: number | null;
  migration_head?: string | null;
  dataset_hash?: string | null;
  metric_version?: string;
  blockers: string[];
}

export interface BetaOverview {
  control: {
    id: string;
    beta_enabled: boolean;
    new_action_runs_enabled: boolean;
    cohort_mode: "allowlist" | "percentage";
    traffic_percent: 0 | 5 | 20 | 50;
    allowlisted_user_ids: string[];
    metric_version: string;
    measurement_started_at: string;
    paused_reason: string | null;
    safety_snapshot: Record<string, unknown>;
    updated_at: string | null;
  };
  metrics: BetaMetrics;
  review_queue_has_pending: boolean;
  runtime_gate: {
    id?: string;
    status: "missing" | "valid" | "invalid";
    valid: boolean;
    blockers: string[];
    critical_safety_pass_rate?: number | null;
    dataset_hash?: string;
    decided_at?: string;
    expires_at?: string | null;
    proof?: Record<string, unknown>;
  };
  safety: BetaSafetyStatus;
  evidence_state: "infrastructure_ready_no_beta_conclusion";
}

export interface BetaReviewSample {
  id: string;
  source_kind: string;
  run_id: string | null;
  conversation_turn_id: string | null;
  pseudonymous_user_key: string;
  sample_type: string;
  structured_context: Record<string, unknown>;
  redacted_summary: string | null;
  status: "pending" | "reviewed" | "confirmed" | "dismissed";
  reviewer_note: string | null;
  candidate_dataset_id: string | null;
  created_at: string;
  retention_expires_at: string;
}

export type ProductValidationStatus = "insufficient_data" | "supported" | "not_supported";

export interface ProductMetricDetail {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface ProductValidationReport {
  snapshot_id?: string;
  schema_version: string;
  status: ProductValidationStatus;
  generated_at: string;
  consented_user_count: number;
  metrics: {
    survey_count: number;
    very_disappointed_rate: number | null;
    goal_creation_10m_cohort: number;
    goal_created_10m_rate: number | null;
    activation_cohort: number;
    first_task_started_24h_rate: number | null;
    activation_24h_rate: number | null;
    first_action_evidence_rate: number | null;
    first_action_evidence_cohort: number;
    week4_wvlu_cohort: number;
    week4_wvlu_retention_rate: number | null;
    week8_wvlu_cohort: number;
    week8_wvlu_retention_rate: number | null;
    recovery_72h_cohort: number;
    recovery_selected_rate: number | null;
    recovery_72h_rate: number | null;
    task_outcome_28d_count: number;
    overload_event_28d_count: number;
    overload_rate_28d: number | null;
    quality_ready_rate: number | null;
  };
  rate_details: Record<string, ProductMetricDetail>;
  thresholds: Record<string, number>;
  metric_definitions: Record<string, string>;
  measurement_policy: Record<string, string>;
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
  getLatestProductValidation: () =>
    api.get<ProductValidationReport | null>("/api/v1/agent-control/admin/product-validation/latest"),
  getProductValidationHistory: (limit = 30) =>
    api.get<ProductValidationReport[]>(`/api/v1/agent-control/admin/product-validation/history?limit=${limit}`),
  aggregateProductValidation: () =>
    api.post<ProductValidationReport>("/api/v1/agent-control/admin/product-validation/aggregate", {}),
  getBetaOverview: () =>
    api.get<BetaOverview>("/api/v1/agent-control/admin/beta/overview"),
  getBetaMetrics: (params: {
    cohort?: "beta" | "stable" | "all";
    source?: "conversation" | "insight" | "scheduler" | "api" | "internal" | "legacy_unattributed" | "all";
    capability?: string;
    resolution_quality?: string;
    start?: string;
    end?: string;
  }) => {
    const query = new URLSearchParams({ metric_version: "action-beta-funnel-v2" });
    Object.entries(params).forEach(([key, value]) => { if (value) query.set(key, value); });
    return api.get<BetaMetrics>(`/api/v1/agent-control/admin/beta/metrics?${query.toString()}`);
  },
  getBetaReviewSamples: (status = "pending") =>
    api.get<BetaReviewSample[]>(`/api/v1/agent-control/admin/beta/review-samples?status=${status}`),
  normalizeBetaReviewSamples: () =>
    api.post<{ created: number }>("/api/v1/agent-control/admin/beta/review-samples/normalize", {}),
  scanBetaSafety: () =>
    api.post<BetaSafetyStatus>("/api/v1/agent-control/admin/beta/safety/scan", {}),
  updateBetaControl: (body: {
    beta_enabled?: boolean;
    new_action_runs_enabled?: boolean;
    cohort_mode?: "allowlist" | "percentage";
    traffic_percent?: 0 | 5 | 20 | 50;
    allowlisted_user_ids?: string[];
    reason: string;
  }) => api.patch<BetaOverview["control"]>("/api/v1/agent-control/admin/beta/control", body),
  reviewBetaSample: (sampleId: string, status: "reviewed" | "confirmed" | "dismissed", note: string) =>
    api.patch<BetaReviewSample>(`/api/v1/agent-control/admin/beta/review-samples/${sampleId}`, { status, note }),
  promoteBetaSample: (sampleId: string, datasetKind: "intent-routing" | "action-changeset") =>
    api.post<{ dataset_id: string; status: string; version: string }>(
      `/api/v1/agent-control/admin/beta/review-samples/${sampleId}/candidate`,
      { dataset_kind: datasetKind }
    ),
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
    provider: "local" | "smart";
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
