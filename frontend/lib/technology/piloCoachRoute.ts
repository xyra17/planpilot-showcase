import type { PiloContextSurface } from "@/lib/technology/piloContext";

export type PiloCoachEntry = {
  intent?: string;
  surface?: PiloContextSurface;
  objectId?: string;
  objectTitle?: string;
  suggestionId?: string;
  observationTitle?: string;
  reason?: string;
  actionLabel?: string;
  prompt?: string;
  returnTo?: string;
  goalId?: string;
  goalIds?: string[];
  entryMode?: "object" | "observation";
  goalScope?: "linked" | "unlinked";
};

export const PILO_SURFACE_LABELS: Record<PiloContextSurface, string> = {
  today: "今日计划",
  notes: "学习笔记",
  knowledge: "知识空间",
  goals: "学习目标",
  review: "学习画像",
  settings: "设置",
  workspace: "PlanPilot 工作区",
};

const SURFACES = new Set<PiloContextSurface>(Object.keys(PILO_SURFACE_LABELS) as PiloContextSurface[]);

function appendIfPresent(params: URLSearchParams, key: keyof PiloCoachEntry, value?: string) {
  const normalized = value?.trim();
  if (normalized) params.set(key, normalized);
}

export function sanitizePiloReturnPath(value?: string | null) {
  if (!value) return undefined;
  const normalized = value.trim();
  if (
    !normalized.startsWith("/studio/")
    || normalized.startsWith("//")
    || /[\r\n\\]/.test(normalized)
  ) return undefined;
  return normalized;
}

export function buildPiloCoachHref(entry: PiloCoachEntry) {
  const params = new URLSearchParams();
  appendIfPresent(params, "intent", entry.intent);
  appendIfPresent(params, "surface", entry.surface);
  appendIfPresent(params, "objectId", entry.objectId);
  appendIfPresent(params, "objectTitle", entry.objectTitle);
  appendIfPresent(params, "suggestionId", entry.suggestionId);
  appendIfPresent(params, "observationTitle", entry.observationTitle);
  appendIfPresent(params, "reason", entry.reason);
  appendIfPresent(params, "actionLabel", entry.actionLabel);
  appendIfPresent(params, "prompt", entry.prompt);
  appendIfPresent(params, "returnTo", sanitizePiloReturnPath(entry.returnTo));
  appendIfPresent(params, "goalId", entry.goalId);
  entry.goalIds?.filter(Boolean).forEach((goalId) => params.append("goalIds", goalId));
  appendIfPresent(params, "entryMode", entry.entryMode);
  appendIfPresent(params, "goalScope", entry.goalScope);
  const query = params.toString();
  return query ? `/studio/coach?${query}` : "/studio/coach";
}

export function parsePiloCoachEntry(params: URLSearchParams): PiloCoachEntry | null {
  const rawSurface = params.get("surface");
  const surface = rawSurface && SURFACES.has(rawSurface as PiloContextSurface)
    ? rawSurface as PiloContextSurface
    : undefined;
  const goalIds = params.getAll("goalIds").map((value) => value.trim()).filter(Boolean);
  const entry: PiloCoachEntry = {
    intent: params.get("intent")?.trim() || undefined,
    surface,
    objectId: params.get("objectId")?.trim() || undefined,
    objectTitle: params.get("objectTitle")?.trim() || undefined,
    suggestionId: params.get("suggestionId")?.trim() || undefined,
    observationTitle: params.get("observationTitle")?.trim() || undefined,
    reason: params.get("reason")?.trim() || undefined,
    actionLabel: params.get("actionLabel")?.trim() || undefined,
    prompt: params.get("prompt")?.trim() || undefined,
    returnTo: sanitizePiloReturnPath(params.get("returnTo")),
    goalId: params.get("goalId")?.trim() || undefined,
    goalIds: goalIds.length ? goalIds : undefined,
    entryMode: params.get("entryMode") === "observation" ? "observation" : params.get("entryMode") === "object" ? "object" : undefined,
    goalScope: params.get("goalScope") === "linked" ? "linked" : params.get("goalScope") === "unlinked" ? "unlinked" : undefined,
  };
  return Object.values(entry).some(Boolean) ? entry : null;
}
