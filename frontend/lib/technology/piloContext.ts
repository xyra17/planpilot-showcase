"use client";

import { scopedStorageKey } from "@/lib/technology/scopedStorage";

export const PILO_CONTEXT_EVENT = "planpilot:pilo-context";
const PILO_CONTEXT_CONTINUITY_KEY = "planpilot:pilo-context-continuity-v1";
const PILO_CONTEXT_CONTINUITY_MS = 30 * 60 * 1000;

function contextStorageKey() {
  if (typeof window === "undefined") return scopedStorageKey("pilo-context-continuity-v1", null);
  let userId: string | null = null;
  try {
    const cachedUser = JSON.parse(window.localStorage.getItem("user_info") ?? "null") as { id?: string } | null;
    userId = cachedUser?.id ?? null;
  } catch {
    userId = null;
  }
  return scopedStorageKey("pilo-context-continuity-v1", userId);
}

function readContextContinuity(): string | null {
  if (typeof window === "undefined") return null;
  const key = contextStorageKey();
  const current = window.sessionStorage.getItem(key);
  if (current !== null) return current;
  // The old key is a guest-only migration source. Never import it into an account.
  if (key.includes(":guest:")) {
    const legacy = window.sessionStorage.getItem(PILO_CONTEXT_CONTINUITY_KEY);
    if (legacy !== null) window.sessionStorage.setItem(key, legacy);
    return legacy;
  }
  return null;
}

export type PiloContextSurface = "today" | "notes" | "knowledge" | "goals" | "review" | "settings" | "workspace";
export type PiloContextPhase = "arriving" | "browsing" | "reading" | "editing" | "paused" | "reviewing" | "completed";
export type PiloContextSignalKind = "scope" | "object-opened" | "editing" | "saved" | "completed" | "reviewing";

export type PiloContextDetail = {
  kind: PiloContextSignalKind;
  surface?: PiloContextSurface;
  objectId?: string;
  objectTitle?: string;
  goalIds?: string[];
  itemCount?: number;
  completedCount?: number;
  reviewDueCount?: number;
  progress?: number;
  message?: string;
};

export type PiloRecentObject = {
  id: string;
  title: string;
  at: number;
  goalIds?: string[];
};

export type PiloContextSnapshot = {
  pathname: string;
  surface: PiloContextSurface;
  phase: PiloContextPhase;
  enteredAt: number;
  lastSignalAt: number;
  lastObjectAt: number | null;
  lastEditAt: number | null;
  lastSavedAt: number | null;
  lastCompletedAt: number | null;
  currentObjectId: string | null;
  currentObjectTitle: string | null;
  currentGoalIds: string[];
  recentObjects: PiloRecentObject[];
  objectSwitches: number;
  editEvents: number;
  itemCount: number | null;
  completedCount: number | null;
  reviewDueCount: number | null;
  progress: number | null;
  completionMessage: string | null;
};

export type PiloSuggestionKind =
  | "intro-today"
  | "intro-notes"
  | "intro-knowledge"
  | "intro-goals"
  | "intro-review"
  | "intro-workspace"
  | "notes-organize"
  | "knowledge-summarize"
  | "knowledge-compare"
  | "goal-first-step"
  | "goal-review"
  | "today-plan";

export type PiloSuggestion = {
  id: string;
  kind: PiloSuggestionKind;
  level: "introduction" | "nudge";
  category: "capability" | "observation" | "action";
  message: string;
  actionLabel: string;
  prompt?: string;
  evidence: string;
  confidence: "medium" | "high";
  cooldownMs: number;
  score: number;
};

export type PiloSuggestionMemoryEntry = {
  shown: number;
  accepted: number;
  ignored: number;
  dismissed: number;
  snoozed: number;
  lastShownAt: number | null;
  nextEligibleAt: number;
};

export type PiloSuggestionMemory = Partial<Record<PiloSuggestionKind, PiloSuggestionMemoryEntry>>;
export type PiloSuggestionInteraction = "shown" | "accepted" | "ignored" | "dismissed" | "snoozed";

let latestContextSignal: { detail: PiloContextDetail; at: number } | null = null;

type PiloContextContinuity = Partial<Record<PiloContextSurface, PiloRecentObject>>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function surfaceForPath(pathname: string): PiloContextSurface {
  if (pathname.startsWith("/studio/work/notes")) return "notes";
  if (pathname.startsWith("/studio/work/knowledge")) return "knowledge";
  if (pathname.startsWith("/studio/work/goals")) return "goals";
  if (pathname.startsWith("/studio/coach/memory")) return "review";
  if (pathname.startsWith("/studio/settings")) return "settings";
  if (pathname === "/studio/work") return "today";
  return "workspace";
}

export function createPiloContextSnapshot(pathname: string, now = Date.now()): PiloContextSnapshot {
  const surface = surfaceForPath(pathname);
  let remembered: PiloRecentObject | undefined;
  if (typeof window !== "undefined") {
    try {
      const continuity = JSON.parse(readContextContinuity() ?? "{}") as PiloContextContinuity;
      const candidate = continuity[surface];
      if (candidate && now - candidate.at <= PILO_CONTEXT_CONTINUITY_MS) remembered = candidate;
    } catch {
      // Invalid session continuity should never block the companion.
    }
  }
  return {
    pathname,
    surface,
    phase: "arriving",
    enteredAt: now,
    lastSignalAt: now,
    lastObjectAt: remembered?.at ?? null,
    lastEditAt: null,
    lastSavedAt: null,
    lastCompletedAt: null,
    currentObjectId: remembered?.id ?? null,
    currentObjectTitle: remembered?.title ?? null,
    currentGoalIds: remembered?.goalIds ?? [],
    recentObjects: remembered ? [remembered] : [],
    objectSwitches: 0,
    editEvents: 0,
    itemCount: null,
    completedCount: null,
    reviewDueCount: null,
    progress: null,
    completionMessage: null,
  };
}

export function reducePiloContextSnapshot(
  current: PiloContextSnapshot,
  detail: PiloContextDetail,
  now = Date.now(),
): PiloContextSnapshot {
  const objectId = detail.objectId ?? current.currentObjectId;
  const objectTitle = detail.objectTitle ?? current.currentObjectTitle;
  const currentGoalIds = detail.goalIds ?? current.currentGoalIds;
  const objectChanged = Boolean(detail.objectId && detail.objectId !== current.currentObjectId);
  const recentObjects = detail.objectId
    ? [
        { id: detail.objectId, title: detail.objectTitle?.trim() || "当前内容", at: now, goalIds: detail.goalIds },
        ...current.recentObjects.filter((item) => item.id !== detail.objectId),
      ].slice(0, 6)
    : current.recentObjects;
  const phase: PiloContextPhase = detail.kind === "editing"
    ? "editing"
    : detail.kind === "object-opened"
      ? "reading"
      : detail.kind === "reviewing"
        ? "reviewing"
        : detail.kind === "completed"
          ? "completed"
          : detail.kind === "saved"
            ? "browsing"
            : current.phase === "arriving" ? "browsing" : current.phase;

  return {
    ...current,
    surface: detail.surface ?? current.surface,
    phase,
    lastSignalAt: now,
    lastObjectAt: detail.kind === "object-opened" ? now : current.lastObjectAt,
    lastEditAt: detail.kind === "editing" ? now : current.lastEditAt,
    lastSavedAt: detail.kind === "saved" ? now : current.lastSavedAt,
    lastCompletedAt: detail.kind === "completed" ? now : current.lastCompletedAt,
    currentObjectId: objectId ?? null,
    currentObjectTitle: objectTitle ?? null,
    currentGoalIds,
    recentObjects,
    objectSwitches: current.objectSwitches + (objectChanged && current.currentObjectId ? 1 : 0),
    editEvents: current.editEvents + (detail.kind === "editing" ? 1 : 0),
    itemCount: detail.itemCount ?? current.itemCount,
    completedCount: detail.completedCount ?? current.completedCount,
    reviewDueCount: detail.reviewDueCount ?? current.reviewDueCount,
    progress: detail.progress ?? current.progress,
    completionMessage: detail.kind === "completed" ? detail.message ?? "这一小步已经完成。" : current.completionMessage,
  };
}

export function signalPiloContext(detail: PiloContextDetail) {
  if (typeof window === "undefined") return;
  const at = Date.now();
  latestContextSignal = { detail, at };
  if (detail.surface && detail.objectId) {
    try {
      const continuity = JSON.parse(readContextContinuity() ?? "{}") as PiloContextContinuity;
      continuity[detail.surface] = {
        id: detail.objectId,
        title: detail.objectTitle?.trim() || "当前内容",
        at,
        goalIds: detail.goalIds,
      };
      window.sessionStorage.setItem(contextStorageKey(), JSON.stringify(continuity));
    } catch {
      // Browsing can continue without cross-page continuity storage.
    }
  }
  window.dispatchEvent(new CustomEvent<PiloContextDetail>(PILO_CONTEXT_EVENT, { detail }));
}

export function readLatestPiloContextSignal() {
  return latestContextSignal;
}

function introSuggestion(surface: PiloContextSurface, variant: number): PiloSuggestion | null {
  const suggestions: Partial<Record<PiloContextSurface, [PiloSuggestion, PiloSuggestion]>> = {
    today: [
      { id: "intro-today-a", kind: "intro-today", level: "introduction", category: "capability", message: "在今日计划里，我可以帮你找出先做哪一件。", actionLabel: "看看能做什么", evidence: "你刚进入今日计划，我先说明在这里能怎样配合你。", confidence: "high", cooldownMs: 30 * MINUTE, score: .42 },
      { id: "intro-today-b", kind: "intro-today", level: "introduction", category: "capability", message: "任务排不开时，我可以帮你调整顺序和时间。", actionLabel: "看看能做什么", evidence: "你刚进入今日计划，我先说明在这里能怎样配合你。", confidence: "high", cooldownMs: 30 * MINUTE, score: .42 },
    ],
    notes: [
      { id: "intro-notes-a", kind: "intro-notes", level: "introduction", category: "capability", message: "在笔记里，我可以帮你收拢要点和补出复习线索。", actionLabel: "看看能做什么", evidence: "你刚进入笔记，我先说明在这里能怎样配合你。", confidence: "high", cooldownMs: 30 * MINUTE, score: .42 },
      { id: "intro-notes-b", kind: "intro-notes", level: "introduction", category: "capability", message: "写到一半停下来时，我可以帮你把内容整理成下一步。", actionLabel: "看看能做什么", evidence: "你刚进入笔记，我先说明在这里能怎样配合你。", confidence: "high", cooldownMs: 30 * MINUTE, score: .42 },
    ],
    knowledge: [
      { id: "intro-knowledge-a", kind: "intro-knowledge", level: "introduction", category: "capability", message: "在知识空间里，我可以提炼资料，也能安排一次短复习。", actionLabel: "看看能做什么", evidence: "你刚进入知识空间，我先说明在这里能怎样配合你。", confidence: "high", cooldownMs: 30 * MINUTE, score: .42 },
      { id: "intro-knowledge-b", kind: "intro-knowledge", level: "introduction", category: "capability", message: "查看多份资料时，我可以帮你对照它们的差异。", actionLabel: "看看能做什么", evidence: "你刚进入知识空间，我先说明在这里能怎样配合你。", confidence: "high", cooldownMs: 30 * MINUTE, score: .42 },
    ],
    goals: [
      { id: "intro-goals-a", kind: "intro-goals", level: "introduction", category: "capability", message: "在目标里，我可以帮你检查进度和找出容易开始的一步。", actionLabel: "看看能做什么", evidence: "你刚进入目标，我先说明在这里能怎样配合你。", confidence: "high", cooldownMs: 30 * MINUTE, score: .42 },
      { id: "intro-goals-b", kind: "intro-goals", level: "introduction", category: "capability", message: "目标节奏变乱时，我可以陪你只调整最关键的一步。", actionLabel: "看看能做什么", evidence: "你刚进入目标，我先说明在这里能怎样配合你。", confidence: "high", cooldownMs: 30 * MINUTE, score: .42 },
    ],
    review: [
      { id: "intro-review-a", kind: "intro-review", level: "introduction", category: "capability", message: "在复习判断里，我可以解释依据，也接受你的校正。", actionLabel: "看看能做什么", evidence: "你刚进入学习判断，我先说明在这里能怎样配合你。", confidence: "high", cooldownMs: 30 * MINUTE, score: .42 },
      { id: "intro-review-b", kind: "intro-review", level: "introduction", category: "capability", message: "哪条判断不准确，可以直接告诉我从哪里改。", actionLabel: "看看能做什么", evidence: "你刚进入学习判断，我先说明在这里能怎样配合你。", confidence: "high", cooldownMs: 30 * MINUTE, score: .42 },
    ],
    workspace: [
      { id: "intro-workspace-a", kind: "intro-workspace", level: "introduction", category: "capability", message: "在这里，我会先观察你正在推进什么，再决定要不要提醒。", actionLabel: "看看能做什么", evidence: "你刚进入新的工作区域，Pilo 会先说明能够怎样配合你。", confidence: "medium", cooldownMs: 30 * MINUTE, score: .38 },
      { id: "intro-workspace-b", kind: "intro-workspace", level: "introduction", category: "capability", message: "需要梳理下一步时，我可以结合当前页面陪你一起判断。", actionLabel: "看看能做什么", evidence: "你刚进入新的工作区域，Pilo 会先说明能够怎样配合你。", confidence: "medium", cooldownMs: 30 * MINUTE, score: .38 },
    ],
  };
  const options = suggestions[surface];
  return options?.[variant % options.length] ?? null;
}

function memoryEntry(memory: PiloSuggestionMemory, kind: PiloSuggestionKind): PiloSuggestionMemoryEntry {
  return memory[kind] ?? { shown: 0, accepted: 0, ignored: 0, dismissed: 0, snoozed: 0, lastShownAt: null, nextEligibleAt: 0 };
}

export function choosePiloSuggestion(
  snapshot: PiloContextSnapshot,
  memory: PiloSuggestionMemory,
  initiative: "quiet" | "balanced" | "present",
  now = Date.now(),
  options: { forceIntroduction?: boolean } = {},
): PiloSuggestion | null {
  if (initiative === "quiet") return null;
  const candidates: PiloSuggestion[] = [];
  const elapsed = now - snapshot.enteredAt;
  const editPause = snapshot.lastEditAt ? now - snapshot.lastEditAt : null;
  const objectDwell = snapshot.lastObjectAt ? now - snapshot.lastObjectAt : null;
  const introDelay = initiative === "present" ? 1_800 : 2_800;
  const editDelay = initiative === "present" ? 10_000 : 14_000;
  const readingDelay = initiative === "present" ? 45_000 : 60_000;

  const introductionAllowed = options.forceIntroduction || snapshot.phase !== "editing";
  if (elapsed >= introDelay && introductionAllowed && snapshot.surface !== "settings") {
    const kind = `intro-${snapshot.surface}` as PiloSuggestionKind;
    const entry = memoryEntry(memory, kind);
    const intro = introSuggestion(snapshot.surface, entry.shown);
    if (intro && options.forceIntroduction) return intro;
    if (intro) candidates.push(intro);
  }

  if (snapshot.surface === "notes" && snapshot.editEvents >= 3 && editPause !== null && editPause >= editDelay) {
    const title = snapshot.currentObjectTitle && snapshot.currentObjectTitle !== "无标题笔记" ? `“${snapshot.currentObjectTitle}”` : "这篇笔记";
    candidates.push({
      id: `notes-organize-${snapshot.lastEditAt}`,
      kind: "notes-organize",
      level: "nudge",
      category: "observation",
      message: `${title}刚补了不少内容。要不要先收成 3 个复习要点？`,
      actionLabel: "整理成 3 个要点",
      prompt: `请把笔记${snapshot.currentObjectTitle ? `“${snapshot.currentObjectTitle}”` : "当前内容"}整理成 3 个便于复习的要点，先给我预览，不要直接修改原文。`,
      evidence: "因为你刚完成一轮编辑，并停下来了一会儿。Pilo 只会先生成预览，由你确认后再决定是否采用。",
      confidence: "high",
      cooldownMs: 45 * MINUTE,
      score: .92,
    });
  }

  if (snapshot.surface === "knowledge" && snapshot.objectSwitches >= 3 && snapshot.recentObjects.length >= 2) {
    const [current, previous] = snapshot.recentObjects;
    candidates.push({
      id: `knowledge-compare-${snapshot.objectSwitches}`,
      kind: "knowledge-compare",
      level: "nudge",
      category: "observation",
      message: "你刚在几份资料之间来回查看。要不要把差异并排整理？",
      actionLabel: "对照这两份资料",
      prompt: `请比较“${current?.title ?? "当前资料"}”与“${previous?.title ?? "上一份资料"}”，并排整理共同点、差异和各自适用场景。`,
      evidence: "因为你最近在多份资料之间反复切换。Pilo 会先整理比较结果，不会改动资料。",
      confidence: "high",
      cooldownMs: 60 * MINUTE,
      score: .96,
    });
  } else if (snapshot.surface === "knowledge" && objectDwell !== null && objectDwell >= readingDelay) {
    const title = snapshot.currentObjectTitle ? `“${snapshot.currentObjectTitle}”` : "这份资料";
    candidates.push({
      id: `knowledge-summarize-${snapshot.lastObjectAt}`,
      kind: "knowledge-summarize",
      level: "nudge",
      category: "observation",
      message: `你已经读了${title}一会儿。要不要先提炼最值得记住的部分？`,
      actionLabel: "提炼关键内容",
      prompt: `请从${title}中提炼最值得记住的内容，并给出 3 个简短复习问题。`,
      evidence: "因为你在当前资料停留了一段时间。Pilo 会先给出提炼结果，不会改动原资料。",
      confidence: "medium",
      cooldownMs: 60 * MINUTE,
      score: .78,
    });
  }

  if (snapshot.surface === "goals" && snapshot.currentObjectId && snapshot.progress === 0 && objectDwell !== null && objectDwell >= 25_000) {
    const title = snapshot.currentObjectTitle ? `“${snapshot.currentObjectTitle}”` : "这个目标";
    candidates.push({
      id: `goal-first-step-${snapshot.currentObjectId}`,
      kind: "goal-first-step",
      level: "nudge",
      category: "action",
      message: `${title}还没有迈出第一步。要不要先拆出一个 20 分钟的小任务？`,
      actionLabel: "拆出第一步",
      prompt: `请为目标${title}拆出一个今天可以在 20 分钟内完成的第一步，只给一个动作，并说明完成标准。`,
      evidence: "因为这个目标目前还没有完成记录。Pilo 只提供一个容易开始的方案，由你决定是否加入计划。",
      confidence: "high",
      cooldownMs: 90 * MINUTE,
      score: .9,
    });
  }

  if ((snapshot.surface === "goals" || snapshot.surface === "review") && (snapshot.reviewDueCount ?? 0) > 0 && elapsed >= 20_000) {
    candidates.push({
      id: `goal-review-${snapshot.reviewDueCount}`,
      kind: "goal-review",
      level: "nudge",
      category: "action",
      message: `有 ${snapshot.reviewDueCount} 项知识待复习。要不要先安排最短的一次？`,
      actionLabel: "安排一次短复习",
      prompt: `根据当前待复习内容，帮我安排一次不超过 15 分钟的轻量复习，只选择最值得先处理的一项。`,
      evidence: "因为当前目标记录了待复习内容。Pilo 会先给出时间与内容建议，不会自动改动计划。",
      confidence: "high",
      cooldownMs: 90 * MINUTE,
      score: .86,
    });
  }

  const pendingCount = Math.max(0, (snapshot.itemCount ?? 0) - (snapshot.completedCount ?? 0));
  if (snapshot.surface === "today" && pendingCount >= 3 && elapsed >= 25_000) {
    candidates.push({
      id: `today-plan-${snapshot.itemCount}-${snapshot.completedCount}`,
      kind: "today-plan",
      level: "nudge",
      category: "action",
      message: `今天还有 ${pendingCount} 项任务。要不要只选出最适合先做的一件？`,
      actionLabel: "找出第一件事",
      prompt: "请结合我今天的任务、优先级和可用时间，只推荐最适合现在开始的一项，并说明理由。",
      evidence: "因为今天仍有多项任务待完成。Pilo 只帮助缩小选择，不会替你调整计划。",
      confidence: "medium",
      cooldownMs: 60 * MINUTE,
      score: .72,
    });
  }

  return candidates
    .filter((candidate) => memoryEntry(memory, candidate.kind).nextEligibleAt <= now)
    .map((candidate) => {
      const entry = memoryEntry(memory, candidate.kind);
      const learnedAdjustment = Math.min(.12, entry.accepted * .03) - Math.min(.32, entry.ignored * .06 + entry.dismissed * .1);
      return { ...candidate, score: candidate.score + learnedAdjustment };
    })
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

export function recordPiloSuggestionInteraction(
  memory: PiloSuggestionMemory,
  suggestion: PiloSuggestion,
  interaction: PiloSuggestionInteraction,
  now = Date.now(),
): PiloSuggestionMemory {
  const current = memoryEntry(memory, suggestion.kind);
  const next = {
    ...current,
    [interaction]: current[interaction] + 1,
    lastShownAt: interaction === "shown" ? now : current.lastShownAt,
  };
  if (interaction === "accepted") next.nextEligibleAt = now + suggestion.cooldownMs;
  if (interaction === "snoozed") next.nextEligibleAt = now + 10 * MINUTE;
  if (interaction === "dismissed") next.nextEligibleAt = now + (current.dismissed >= 1 ? 24 * HOUR : 4 * HOUR);
  if (interaction === "ignored") {
    const silenceMultiplier = Math.min(16, 2 ** Math.min(4, current.ignored));
    next.nextEligibleAt = now + silenceMultiplier * suggestion.cooldownMs;
  }
  return { ...memory, [suggestion.kind]: next };
}
