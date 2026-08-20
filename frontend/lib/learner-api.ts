import { api } from "@/lib/api";

export interface LearnerProfile {
  id: string;
  goal_id: string | null;
  consistency_score: number | null;
  weekly_active_days: number | null;
  avg_session_duration_mins: number | null;
  avg_daily_investment_mins: number | null;
  completion_rate_30d: number | null;
  mastery_rate_30d: number | null;
  mastery_velocity: number | null;
  preferred_hour_start: number | null;
  preferred_hour_end: number | null;
  preferred_weekdays: number[] | null;
  estimation_accuracy: number | null;
  debt_tendency: number | null;
  reschedule_rate: number | null;
  observation_window_days: number;
  event_count: number;
  last_computed_at: string | null;
}

export interface LearnerCognitiveProfile {
  id: string;
  goal_id: string | null;
  learning_speed: number | null;
  retention_rate: number | null;
  forgetting_rate: number | null;
  transfer_score: number | null;
  persistence_score: number | null;
  procrastination_score: number | null;
  recovery_score: number | null;
  difficulty_preference: number | null;
  challenge_tolerance: number | null;
  feedback_acceptance: number | null;
  observation_window_days: number;
  sample_count: number;
  confidence: number;
  retention_curve: Array<{ day: number; retention: number }>;
  last_computed_at: string | null;
}

export interface LearningMemoryLayers {
  short_term: Array<{ kind: string; id: string; summary: string; occurred_at: string | null }>;
  episodic: Array<{
    id: string;
    memory_type: string;
    summary: string;
    importance: number;
    relevance: number;
    source_event_id: string | null;
    occurred_at: string;
  }>;
  semantic: Array<{
    id: string;
    memory_type: string;
    summary: string;
    value: Record<string, unknown>;
    confidence: number;
    scope: string;
  }>;
}

export interface KnowledgeGap {
  id: string;
  goal_id: string | null;
  name: string;
  mastery_score: number;
  retention: number;
  gap_score: number;
  forgetting_rate: number;
  evidence_count: number;
  missing_prerequisites: string[];
}

export interface AdaptiveAssessment {
  goal_id: string;
  high_risk_count: number;
  generated_at: string;
  risks: Array<{
    task_id: string;
    title: string;
    failure_probability: number;
    risk_level: "low" | "medium" | "high";
    factors: string[];
  }>;
  knowledge_gaps: KnowledgeGap[];
}

export interface PatternEvidence {
  event_id: string | null;
  event_type: string;
  occurred_at: string | null;
  contribution: number;
  direction?: "supporting" | "opposing" | "neutral";
  source?: string | null;
  aggregate_type?: string | null;
  aggregate_id?: string | null;
}

export interface ActivePattern {
  id: string;
  goal_id: string | null;
  scope: string;
  pattern_type: string;
  pattern_value: Record<string, unknown>;
  confidence: number;
  evidence_count: number;
  last_confirmed_at: string | null;
  evidence: PatternEvidence[];
  evidence_summary?: {
    supporting_count: number;
    opposing_count: number;
    neutral_count: number;
    first_observed_at: string | null;
    last_observed_at: string | null;
    timezone?: string | null;
    observation_window_days?: number | null;
    last_impacted_proposal_id?: string | null;
  };
  user_review_status?: string | null;
  user_reviewed_at?: string | null;
  explanation: string;
}

export interface ManagedPattern {
  id: string;
  goal_id: string | null;
  scope: string;
  pattern_type: string;
  status: "candidate" | "active" | "decayed" | "paused" | "archived";
  confidence: number;
  evidence_count: number;
  explanation: string;
  user_review_status: string | null;
  user_reviewed_at: string | null;
  paused_at: string | null;
  first_observed_at: string;
  last_confirmed_at: string | null;
}

export interface PatternAudit {
  id: string;
  pattern_id: string;
  action: "confirm" | "correct" | "set_scope" | "pause" | "restore" | "forget" | "undo";
  actor_type: string;
  reason: string | null;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  reversible: boolean;
  undone_at: string | null;
  created_at: string;
}

export interface DecisionContext {
  profile: LearnerProfile | null;
  cognitive_profile: LearnerCognitiveProfile | null;
  memories: LearningMemoryLayers;
  knowledge_gaps: KnowledgeGap[];
  active_patterns: ActivePattern[];
  recent_events: Array<{
    id: string;
    event_type: string;
    occurred_at: string;
    payload: Record<string, unknown>;
  }>;
  goal_context: {
    goal: { id: string; title: string; daily_hours: number; deadline: string; status: string };
    task_summary: {
      total: number;
      completed: number;
      completion_rate: number | null;
      overdue_count: number;
      upcoming_count: number;
    };
  } | null;
  data_quality: {
    profile_event_count: number;
    profile_scope: "goal" | "user" | "default";
    pattern_count: number;
    memory_count: number;
    cognitive_confidence: number;
    knowledge_gap_count: number;
    low_confidence_fields: string[];
    level: "low" | "medium" | "high";
  };
}

export type ValidationStatus = "supported" | "not_supported" | "insufficient_data" | "not_configured";

export interface CoreValidationReport {
  experiment_key: "pattern_validity" | "prediction_calibration" | "proposal_utility" | "personalization_lift";
  status: ValidationStatus;
  generated_at: string;
  provenance?: {
    schema_version: string;
    environment: string;
    data_origin: string;
    window_days: number | null;
    synthetic_data_allowed: boolean;
    stale: boolean;
  };
  result: {
    question?: string;
    buckets?: Record<string, { sample_count: number; completion_rate: number | null }>;
    evening_minus_afternoon?: number | null;
    difference_95_ci?: [number, number] | null;
    minimum_samples_per_bucket?: number;
    outcome_count?: number;
    brier_score?: number | null;
    expected_calibration_error?: number | null;
    thresholds?: { minimum_outcomes?: number; max_brier?: number; max_ece?: number };
    seven_day?: { sample_count: number; completion_rate: number | null; mean_delta: number | null };
    minimum_seven_day_outcomes?: number;
    treatment_minus_control?: Record<"completion" | "recovery" | "mastery" | "retention" | "overload", number | null>;
    minimum_users_per_variant?: number;
    variants?: Array<{ user_count: number; is_control: boolean }>;
  };
}

export interface ValidationSnapshot {
  schema_version: string;
  generated_at: string | null;
  reports: CoreValidationReport[];
  viewer_evidence?: {
    cohort: "real_user" | "internal_or_test";
    environment: string;
    experiments_enabled: boolean;
    product_analytics_enabled: boolean;
    quality_score: number | null;
    quality_schema_version: string | null;
    quality_sampled_at: string | null;
    eligible_for_real_evidence: boolean;
  };
}

export type ProposalStatus = "pending" | "accepted" | "rejected" | "applied" | "expired";

export interface DecisionProposal {
  id: string;
  goal_id: string | null;
  proposal_type: string;
  title: string;
  summary: string;
  reasoning: string[];
  proposed_changes: Record<string, unknown>;
  evidence_references: string[];
  confidence: number;
  status: ProposalStatus;
  rejection_reason: string | null;
  expires_at: string | null;
  reviewed_at: string | null;
  applied_at: string | null;
  created_at: string | null;
  has_feedback: boolean;
  source: string;
  model_name: string | null;
  agent_trace: {
    invocation_id?: string;
    fallback?: boolean;
    latency_ms?: number;
  };
}

export interface FeedbackSummary {
  total_proposals: number;
  pending_count: number;
  accepted_count: number;
  rejected_count: number;
  applied_count: number;
  accept_rate: number | null;
  reject_rate: number | null;
  apply_rate: number | null;
  feedback_count: number;
  outcomes: { helpful: number; neutral: number; unhelpful: number };
  pattern_accuracy: number | null;
  patterns: Array<{
    pattern_id: string;
    pattern_type: string;
    accuracy: number;
    feedback_count: number;
    current_confidence: number | null;
  }>;
}

const goalQuery = (goalId: string | null) =>
  goalId ? `?goal_id=${encodeURIComponent(goalId)}` : "";

export const learnerApi = {
  getProfile: (goalId: string | null) =>
    api.get<{ profile: LearnerProfile | null; scope: string }>(
      `/api/v1/learner/profile${goalQuery(goalId)}`
    ),
  getCognitiveProfile: (goalId: string | null) =>
    api.get<{ profile: LearnerCognitiveProfile | null; scope: string }>(
      `/api/v1/learner/cognitive-profile${goalQuery(goalId)}`
    ),
  getMemories: (goalId: string | null, query?: string) => {
    const params = new URLSearchParams();
    if (goalId) params.set("goal_id", goalId);
    if (query) params.set("query", query);
    const suffix = params.size ? `?${params.toString()}` : "";
    return api.get<LearningMemoryLayers>(`/api/v1/learner/memories${suffix}`);
  },
  getAdaptiveAssessment: (goalId: string) =>
    api.get<AdaptiveAssessment>(`/api/v1/learner/adaptive-plan/${goalId}/assessment`),
  generateAdaptiveProposal: (goalId: string) =>
    api.post<DecisionProposal>(`/api/v1/learner/adaptive-plan/${goalId}/proposal`, {}),
  rebuildProfile: () =>
    api.post<{ processed_goals: number; event_count: number; elapsed_ms: number }>(
      "/api/v1/learner/profile/rebuild",
      {}
    ),
  getDecisionContext: (goalId: string | null) =>
    api.get<DecisionContext>(`/api/v1/learner/decision-context${goalQuery(goalId)}`),
  getValidationStatus: () =>
    api.get<ValidationSnapshot>("/api/v1/learner/validation-status"),
  listManagedPatterns: (goalId: string | null) =>
    api.get<ManagedPattern[]>(`/api/v1/learner/patterns/manage${goalQuery(goalId)}`),
  applyPatternAction: (
    patternId: string,
    body: {
      action: "confirm" | "correct" | "set_scope" | "pause" | "restore" | "forget";
      reason?: string;
      summary?: string;
      scope?: "user" | "goal";
      goal_id?: string | null;
    },
  ) => api.post<{ pattern?: ManagedPattern; deleted: boolean; audit_id: string }>(
    `/api/v1/learner/patterns/${patternId}/actions`, body,
  ),
  listPatternAudits: (patternId?: string) => {
    const suffix = patternId ? `?pattern_id=${encodeURIComponent(patternId)}` : "";
    return api.get<PatternAudit[]>(`/api/v1/learner/pattern-audits${suffix}`);
  },
  undoPatternAudit: (auditId: string) =>
    api.post(`/api/v1/learner/pattern-audits/${auditId}/undo`, {}),
  listProposals: (goalId: string | null) =>
    api.get<DecisionProposal[]>(`/api/v1/learner/proposals${goalQuery(goalId)}`),
  generateProposal: (goalId: string | null) =>
    api.post<DecisionProposal[]>("/api/v1/learner/proposals/generate", { goal_id: goalId }),
  acceptProposal: (proposalId: string) =>
    api.post<DecisionProposal>(`/api/v1/learner/proposals/${proposalId}/accept`, {}),
  rejectProposal: (proposalId: string, reason: string) =>
    api.post<DecisionProposal>(`/api/v1/learner/proposals/${proposalId}/reject`, { reason }),
  adjustProposal: (
    proposalId: string,
    proposedChanges: Record<string, unknown>,
    reason: string
  ) =>
    api.patch<DecisionProposal>(`/api/v1/learner/proposals/${proposalId}`, {
      proposed_changes: proposedChanges,
      reason,
    }),
  applyProposal: (proposalId: string) =>
    api.post<DecisionProposal>(`/api/v1/learner/proposals/${proposalId}/apply`, {}),
  recordFeedback: (
    proposalId: string,
    outcome: "helpful" | "neutral" | "unhelpful"
  ) =>
    api.post(`/api/v1/learner/proposals/${proposalId}/feedback`, { outcome }),
  getFeedbackSummary: (goalId: string | null) =>
    api.get<FeedbackSummary>(`/api/v1/learner/feedback/summary${goalQuery(goalId)}`),
};
