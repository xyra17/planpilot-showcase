import { api, apiFetch, authFetch, resolveApiAssetUrl } from "@/lib/api";

export type ApiGoal = {
  id: string;
  type: "exam" | "certification" | "skill" | "reading" | "language" | "habit";
  title: string;
  deadline: string;
  daily_hours: number;
  current_level: string;
  status: "active" | "completed" | "paused" | "abandoned";
  meta?: Record<string, unknown>;
  created_at: string;
  work_schedule?: "weekday" | "weekend" | "all";
  kb_id?: string | null;
  version?: number;
};

export type GoalProgress = {
  goal_id: string;
  total_tasks: number;
  completed_tasks: number;
  avg_completion_rate: number;
  streak_days: number;
  debt_count: number;
  days_ahead_or_behind: number | null;
};

export type ApiTask = {
  id: string;
  title: string;
  description?: string | null;
  goalId: string;
  goalTitle: string;
  done: boolean;
  status: "pending" | "in_progress" | "completed" | "skipped" | "abandoned";
  estimatedMinutes: number;
  actualMinutes: number | null;
  date: string;
  priority: "high" | "medium" | "low";
  masteryLevel: string;
};

export type ApiNote = {
  id: string;
  goalId: string;
  goalTitle: string;
  taskId: string | null;
  title: string;
  content: string;
  noteType: string;
  date: string;
  savedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiKnowledgeBase = {
  id: string;
  name: string;
  description: string;
  goal_id: string | null;
  item_count: number;
  created_at: string;
};

export type ApiKnowledgeFile = {
  id: string;
  name: string;
  size: string;
  uploadDate: string;
  type: string;
  goalIds: string[];
  kbId: string;
  kbIds: string[];
  taskId: string;
  status: string;
  error: string | null;
  retryCount: number;
  contentLength: number;
  summary: string;
  sourceUrl: string | null;
  content: string;
  contentFormat: "plain" | "markdown" | "html";
  mediaPreviewStatus: "none" | "queued" | "processing" | "ready" | "failed";
  mediaPreviewError: string | null;
  mediaMetadata: ApiMediaMetadata;
  mediaHasPlayback: boolean;
  mediaHasPoster: boolean;
  mediaHasWaveform: boolean;
};

export type ApiMediaMetadata = {
  kind?: "audio" | "video";
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  bitRate?: number | null;
  sourceFormat?: string;
  sourceSize?: number;
  previewFormat?: string;
};

export type ApiMediaPreview = {
  status: ApiKnowledgeFile["mediaPreviewStatus"];
  error: string | null;
  metadata: ApiMediaMetadata;
  hasPlayback: boolean;
  hasPoster: boolean;
  hasWaveform: boolean;
};

export type ApiKnowledgeFileVersion = {
  id: string;
  filename: string;
  size: string;
  createdAt: string;
};

export type LearnerProfile = {
  consistency_score: number | null;
  weekly_active_days: number | null;
  avg_session_duration_mins: number | null;
  avg_daily_investment_mins: number | null;
  completion_rate_30d: number | null;
  mastery_rate_30d: number | null;
  preferred_hour_start: number | null;
  preferred_hour_end: number | null;
  event_count: number;
};

export type LearnerMemories = {
  short_term: Array<{ id: string; summary: string; kind: string }>;
  episodic: Array<{ id: string; summary: string; memory_type: string; relevance: number }>;
  semantic: Array<{ id: string; summary: string; value?: Record<string, unknown>; confidence?: number }>;
};

export type AgentStreamEvent = {
  event: string;
  data: Record<string, unknown>;
};

export type AgentActionOperation = {
  operation_id: string;
  entity: string;
  entity_id: string;
  field: string;
  before: unknown;
  after: unknown;
  label: string;
  reason: string;
};

export type AgentActionApproval = {
  id: string;
  status: string;
  change_hash: string;
  change_set_version: number;
  run_state_version: number;
  policy_decision: { risk?: "low" | "medium" | "high"; reasons?: string[] };
  change_set: {
    summary?: string;
    warnings?: string[];
    operations?: AgentActionOperation[];
  };
};

export type AgentActionAlternative = {
  id: "preview_goal_deadline_extension" | "analyze_deadline_risk_only" | "rebuild_within_deadline" | string;
  label: string;
  description: string;
};

export type AgentActionResult = {
  summary?: string;
  undo_available?: boolean;
  outcome?: "safe_policy_rejection" | string;
  action_fulfilled?: boolean;
  reason_code?: "deadline_conflict" | string;
  alternatives?: AgentActionAlternative[];
};

export type AgentActionRun = {
  id: string;
  goal_id: string | null;
  request: string;
  status: "queued" | "executing" | "waiting_approval" | "retrying" | "replanning" | "paused" | "completed" | "failed" | "rejected" | "cancelled" | "compensating" | "rolled_back";
  current_step: number;
  error: string | null;
  result: AgentActionResult | null;
  created_at?: string | null;
  updated_at?: string | null;
  plan: Array<{ index?: number; title?: string; tool_name?: string }>;
  steps: Array<{ id: string; index: number; tool_name: string; status: string; risk: string; error?: string | null }>;
  approvals: AgentActionApproval[];
  events: Array<{ id: string; sequence: number; type: string; summary: string }>;
  budgets: {
    steps: { used: number; limit: number };
    tokens: { used: number; limit: number };
  };
};

export type CoachArchiveMessage = { id: string; role: "user" | "assistant"; content: string; created_at?: string };
export type CoachArchiveConversation = {
  id: string;
  session_id: string;
  goal_id: string | null;
  goal_title: string;
  title: string;
  summary: string;
  pilo_feedback: string;
  messages: CoachArchiveMessage[];
  association: string;
  is_favorite: boolean;
  created_at: string;
  updated_at: string;
};
export type CoachPreferencesPayload = {
  tone: "warm" | "direct" | "socratic";
  initiative: "quiet" | "balanced" | "proactive";
  detail: "brief" | "balanced" | "deep";
  celebrateProgress: boolean;
  motion: "calm" | "lively";
};
export type CoachArchive = {
  version: number;
  conversations: CoachArchiveConversation[];
  preferences: CoachPreferencesPayload | null;
};

export async function streamAgentMessage(
  body: {
    message: string;
    goal_id?: string;
    session_id: string;
    pilo_preferences?: {
      tone: "warm" | "direct" | "socratic";
      initiative: "quiet" | "balanced" | "proactive";
      detail: "brief" | "balanced" | "deep";
      celebrateProgress: boolean;
      motion: "calm" | "lively";
    };
  },
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
) {
  const response = await authFetch("/api/v1/agent/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`学习伙伴连接失败 (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      const raw = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!raw) continue;
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(raw) as Record<string, unknown>; }
      catch { data = { text: raw }; }
      onEvent({ event, data });
    }
  }
}

export const productApi = {
  listActionRuns: (limit = 20) => api.get<AgentActionRun[]>(`/api/v2/agent/runs?limit=${limit}`),
  getActionRun: (runId: string) => api.get<AgentActionRun>(`/api/v2/agent/runs/${encodeURIComponent(runId)}`),
  approveActionRun: (runId: string, approval: AgentActionApproval, highRiskConfirmed: boolean) => api.post<AgentActionRun>(`/api/v2/agent/runs/${encodeURIComponent(runId)}/approve`, {
    approval_id: approval.id,
    change_hash: approval.change_hash,
    change_set_version: approval.change_set_version,
    run_state_version: approval.run_state_version,
    high_risk_confirmed: highRiskConfirmed,
  }),
  rejectActionRun: (runId: string, approvalId: string) => api.post<AgentActionRun>(`/api/v2/agent/runs/${encodeURIComponent(runId)}/reject`, {
    approval_id: approvalId,
    reason: "用户在学习伙伴中选择保留原计划",
  }),
  cancelActionRun: (runId: string) => api.post<AgentActionRun>(`/api/v2/agent/runs/${encodeURIComponent(runId)}/cancel`, {}),
  retryActionRun: (runId: string) => api.post<AgentActionRun>(`/api/v2/agent/runs/${encodeURIComponent(runId)}/retry`, {}),
  undoActionRun: (runId: string) => api.post<AgentActionRun>(`/api/v2/agent/runs/${encodeURIComponent(runId)}/undo`, {}),
  listGoals: () => api.get<ApiGoal[]>("/api/v1/goals"),
  getGoal: (id: string) => api.get<ApiGoal>(`/api/v1/goals/${id}`),
  getGoalsProgress: () => api.get<GoalProgress[]>("/api/v1/goals/progress"),
  getGoalProgress: (id: string) => api.get<GoalProgress>(`/api/v1/goals/${id}/progress`),
  createGoal: (body: {
    type: ApiGoal["type"];
    title: string;
    deadline: string;
    daily_hours: number;
    current_level: string;
    work_schedule: string;
  }) => api.post<ApiGoal>("/api/v1/goals", body),
  updateGoal: (id: string, body: Partial<Pick<ApiGoal, "type" | "title" | "deadline" | "daily_hours" | "current_level" | "work_schedule" | "status">>) => api.patch<ApiGoal>(`/api/v1/goals/${id}`, body),
  getGoalPlan: (id: string) => api.get<{ plan: unknown | null }>(`/api/v1/goals/${id}/plan`),
  deleteGoal: (id: string) => api.del(`/api/v1/goals/${id}`),
  listTasks: (date?: string, range?: { dateFrom?: string; dateTo?: string }) => {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (range?.dateFrom) params.set("date_from", range.dateFrom);
    if (range?.dateTo) params.set("date_to", range.dateTo);
    const query = params.toString();
    return api.get<ApiTask[]>(`/api/v1/tasks${query ? `?${query}` : ""}`);
  },
  createTask: (body: {
    title: string;
    description?: string;
    goalId: string;
    estimatedMinutes: number;
    date: string;
    priority: ApiTask["priority"];
  }) => api.post<ApiTask>("/api/v1/tasks", body),
  createTaskWithSchedule: (body: {
    title: string;
    description?: string;
    goalId: string;
    estimatedMinutes: number;
    date: string;
    priority: ApiTask["priority"];
    blocks: Array<{
      id: string;
      label: string;
      taskId?: string | null;
      goalTitle?: string | null;
      startHour: number;
      durationMinutes: number;
      color: string;
      progress?: number;
    }>;
  }) => api.post<ApiTask>("/api/v1/tasks/with-schedule", body),
  updateTask: (id: string, body: Partial<Pick<ApiTask, "title" | "description" | "done" | "estimatedMinutes" | "date" | "priority">> & {
    rescheduleTrigger?: "user_manual" | "overload_recovery" | "deviation_recovery";
    recoveryStrategy?: "minimum" | "standard" | "sprint";
  }) => api.patch<ApiTask>(`/api/v1/tasks/${id}`, body),
  observeTaskStart: (id: string) => api.post<ApiTask>(`/api/v1/tasks/${id}/observe-start`, {}),
  deleteTask: (id: string) => api.del(`/api/v1/tasks/${id}`),
  recordActualMinutes: (id: string, actualMinutes: number) => api.patch<ApiTask>(`/api/v1/tasks/${id}`, { actual_mins: actualMinutes }),
  listNotes: () => api.get<ApiNote[]>("/api/v1/knowledge/notes"),
  createNote: (body: { goalId: string | null; title: string; content: string; noteType: string }) => api.post<ApiNote>("/api/v1/knowledge/notes", body),
  updateNote: (id: string, body: { goalId?: string | null; title?: string; content?: string }) => api.patch<ApiNote>(`/api/v1/knowledge/notes/${id}`, body),
  deleteNote: (id: string) => api.del(`/api/v1/knowledge/${id}`),
  listKnowledgeBases: async () => (await api.get<{ items: ApiKnowledgeBase[] }>("/api/v1/knowledge/kbs")).items,
  createKnowledgeBase: (body: { name: string; description?: string; goal_id?: string | null }) => api.post<ApiKnowledgeBase>("/api/v1/knowledge/kbs", body),
  updateKnowledgeBase: (id: string, body: { name?: string; description?: string; goal_id?: string | null }) => api.patch<ApiKnowledgeBase>(`/api/v1/knowledge/kbs/${id}`, body),
  deleteKnowledgeBase: (id: string) => api.del(`/api/v1/knowledge/kbs/${id}`),
  listKnowledgeFiles: async () => (await api.get<{ items: ApiKnowledgeFile[] }>("/api/v1/knowledge/files")).items,
  uploadKnowledgeFile: (file: File, body: { kbIds?: string[]; goalIds?: string[] }) => {
    const form = new FormData();
    form.append("file", file);
    body.kbIds?.forEach((kbId) => {
      if (kbId) form.append("kb_ids", kbId);
    });
    body.goalIds?.forEach((goalId) => {
      if (goalId) form.append("goal_ids", goalId);
    });
    return apiFetch<ApiKnowledgeFile>("/api/v1/knowledge/upload", { method: "POST", body: form });
  },
  importKnowledgeUrl: (body: { url: string; title?: string; kb_ids?: string[]; goal_ids?: string[] }) => api.post<ApiKnowledgeFile>("/api/v1/knowledge/url", body),
  updateKnowledgeFile: (id: string, body: { title?: string; summary?: string; kb_ids?: string[]; goal_ids?: string[]; content?: string; content_format?: "plain" | "markdown" | "html" }) => api.patch<ApiKnowledgeFile>(`/api/v1/knowledge/files/${id}`, body),
  fetchKnowledgeFile: async (id: string) => {
    const response = await authFetch(`/api/v1/knowledge/files/${id}/serve`);
    if (!response.ok) throw new Error(`文件预览加载失败 (${response.status})`);
    return response.blob();
  },
  getMediaPreview: (id: string) => api.get<ApiMediaPreview>(`/api/v1/knowledge/files/${id}/media-preview`),
  retryMediaPreview: (id: string) => api.post<ApiMediaPreview>(`/api/v1/knowledge/files/${id}/media-preview/retry`, {}),
  mediaAssetUrl: (id: string, asset: "source" | "playback" | "poster" | "waveform") => resolveApiAssetUrl(
    asset === "source"
      ? `/api/v1/knowledge/files/${id}/serve`
      : `/api/v1/knowledge/files/${id}/media/${asset}`,
  ) ?? "",
  listKnowledgeFileVersions: (id: string) => api.get<ApiKnowledgeFileVersion[]>(`/api/v1/knowledge/files/${id}/versions`),
  replaceKnowledgeFile: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiFetch<ApiKnowledgeFile>(`/api/v1/knowledge/files/${id}/replace`, { method: "POST", body: form });
  },
  restoreKnowledgeFileVersion: (id: string, versionId: string) => api.post<ApiKnowledgeFile>(`/api/v1/knowledge/files/${id}/versions/${versionId}/restore`, {}),
  retryKnowledgeFile: (id: string) => api.post<ApiKnowledgeFile>(`/api/v1/knowledge/${id}/retry`, {}),
  deleteKnowledgeFile: (id: string) => api.del(`/api/v1/knowledge/${id}`),
  getLearnerProfile: async (goalId?: string) => (await api.get<{ profile: LearnerProfile | null }>(`/api/v1/learner/profile${goalId ? `?goal_id=${encodeURIComponent(goalId)}` : ""}`)).profile,
  getLearnerMemories: (goalId?: string) => api.get<LearnerMemories>(`/api/v1/learner/memories${goalId ? `?goal_id=${encodeURIComponent(goalId)}` : ""}`),
  getCoachArchive: () => api.get<CoachArchive>("/api/v1/coach/archive"),
  saveCoachConversation: (conversation: CoachArchiveConversation) => api.put<CoachArchiveConversation>(`/api/v1/coach/conversations/${encodeURIComponent(conversation.id)}`, conversation),
  deleteCoachConversation: (conversationId: string) => api.del(`/api/v1/coach/conversations/${encodeURIComponent(conversationId)}`),
  saveCoachPreferences: (preferences: CoachPreferencesPayload) => api.put<CoachPreferencesPayload>("/api/v1/coach/preferences", preferences),
  importCoachArchive: (conversations: CoachArchiveConversation[]) => api.put<{ imported: number }>("/api/v1/coach/archive", conversations),
};
