import type { PiloContextPhase } from "@/lib/technology/piloContext";
import type { PiloLifeActionId, PiloStateLayer, PiloSystemState } from "@/lib/technology/piloState";

export const PILO_SCENE_EVENT = "planpilot:pilo-scene";

export type PiloSceneId = "morning" | "focus" | "lunch" | "dinner" | "movement" | "review" | "night";
export type PiloMovementVariant = "walk" | "stretch";

export type PiloSceneFeatures = {
  dailyScenes: boolean;
  morningScenes: boolean;
  focusScenes: boolean;
  mealScenes: boolean;
  movementScenes: boolean;
  reviewScenes: boolean;
  nightCare: boolean;
  personalizedSceneCopy: boolean;
};

export type PiloSceneMemory = {
  dayKey: string;
  shown: Partial<Record<PiloSceneId, number>>;
  totalShown: number;
  lastShownAt: number;
};

export type PiloSceneFacts = {
  username?: string | null;
  itemCount?: number | null;
  completedCount?: number | null;
  currentObjectTitle?: string | null;
  activeMinutes?: number | null;
};

export type PiloSceneCandidateInput = {
  now: number;
  enteredAt: number;
  activeSessionStartedAt: number;
  phase: PiloContextPhase;
  activeLayer: PiloStateLayer;
  activeState: PiloSystemState;
  initiative: "quiet" | "balanced" | "present";
  quietHoursActive: boolean;
  completedCount: number;
  bedtime: { enabled: boolean; hour: number; minute: number };
  nightReminderOff: boolean;
  features: PiloSceneFeatures;
  memory: PiloSceneMemory;
};

export type PiloScenePresentation = {
  id: PiloSceneId;
  eyebrow: string;
  message: string;
  actionLabel: string;
  href?: string;
  mood: "reading" | "working" | "sitting" | "walking" | "stretching";
  lifeAction?: PiloLifeActionId;
  movementVariant?: PiloMovementVariant;
  duration: number;
  reason: string;
};

const MINUTE = 60_000;
const DAY_START_HOUR = 4;

export const DEFAULT_PILO_SCENE_MEMORY: PiloSceneMemory = {
  dayKey: "",
  shown: {},
  totalShown: 0,
  lastShownAt: 0,
};

export const PILO_SCENE_IDS: readonly PiloSceneId[] = [
  "morning",
  "focus",
  "lunch",
  "dinner",
  "movement",
  "review",
  "night",
];

export function piloSceneDayKey(now: number) {
  const date = new Date(now);
  if (date.getHours() < DAY_START_HOUR) date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function minuteOfDay(now: number) {
  const date = new Date(now);
  return date.getHours() * 60 + date.getMinutes();
}

function inWindow(value: number, start: number, end: number) {
  if (start <= end) return value >= start && value < end;
  return value >= start || value < end;
}

function wasShown(memory: PiloSceneMemory, id: PiloSceneId) {
  return (memory.shown[id] ?? 0) > 0;
}

export function normalizePiloSceneMemory(memory: Partial<PiloSceneMemory> | null | undefined, now = Date.now()): PiloSceneMemory {
  const dayKey = piloSceneDayKey(now);
  if (!memory || memory.dayKey !== dayKey) return { ...DEFAULT_PILO_SCENE_MEMORY, dayKey };
  return {
    dayKey,
    shown: memory.shown ?? {},
    totalShown: Math.max(0, memory.totalShown ?? 0),
    lastShownAt: Math.max(0, memory.lastShownAt ?? 0),
  };
}

export function recordPiloSceneShown(memory: PiloSceneMemory, id: PiloSceneId, now = Date.now()): PiloSceneMemory {
  const current = normalizePiloSceneMemory(memory, now);
  return {
    ...current,
    shown: { ...current.shown, [id]: (current.shown[id] ?? 0) + 1 },
    totalShown: current.totalShown + 1,
    lastShownAt: now,
  };
}

export function choosePiloScene(input: PiloSceneCandidateInput): PiloSceneId | null {
  if (!input.features.dailyScenes || input.initiative === "quiet") return null;
  if (input.activeLayer === "interaction" || input.activeLayer === "agent" || input.activeLayer === "feedback") return null;
  if (input.phase === "editing" || input.phase === "arriving") return null;
  if (input.now - input.enteredAt < 8_000) return null;

  const memory = normalizePiloSceneMemory(input.memory, input.now);
  // There is intentionally no global "3 or 4 scenes" ceiling. Each scene
  // type is eligible once per scene day, while a shared gap prevents a stream
  // of prompts. This lets the seven scene types participate over a day while
  // preserving a calm cadence.
  const minimumGap = input.initiative === "present" ? 60 * MINUTE : 90 * MINUTE;
  if (input.now - memory.lastShownAt < minimumGap) return null;

  const minutes = minuteOfDay(input.now);
  const sessionAge = input.now - input.activeSessionStartedAt;
  const bedtimeMinute = input.bedtime.hour * 60 + input.bedtime.minute;
  const nightWindow = input.bedtime.enabled && inWindow(minutes, (bedtimeMinute - 30 + 1_440) % 1_440, (bedtimeMinute + 45) % 1_440);

  if (input.quietHoursActive) return null;
  if (nightWindow && input.features.nightCare && !input.nightReminderOff && !wasShown(memory, "night")) return "night";
  if (input.features.morningScenes && inWindow(minutes, 6 * 60 + 30, 9 * 60 + 30) && !wasShown(memory, "morning")) return "morning";
  if (input.features.mealScenes && inWindow(minutes, 11 * 60 + 45, 12 * 60 + 30) && !wasShown(memory, "lunch")) return "lunch";
  if (input.features.mealScenes && inWindow(minutes, 17 * 60 + 30, 18 * 60 + 30) && !wasShown(memory, "dinner")) return "dinner";
  if (input.features.reviewScenes && input.completedCount > 0 && inWindow(minutes, 20 * 60, 22 * 60) && !wasShown(memory, "review")) return "review";

  const movementWindow = inWindow(minutes, 14 * 60 + 30, 17 * 60 + 30) || inWindow(minutes, 19 * 60, 20 * 60 + 30);
  if (input.features.movementScenes && movementWindow && sessionAge >= 45 * MINUTE && !wasShown(memory, "movement")) return "movement";

  const focusWindow = inWindow(minutes, 9 * 60 + 30, 11 * 60 + 45) || inWindow(minutes, 13 * 60 + 30, 17 * 60 + 30);
  const focusContext = input.phase === "paused" || input.phase === "reviewing" || input.activeState === "working";
  if (input.features.focusScenes && focusWindow && focusContext && sessionAge >= 12 * MINUTE && !wasShown(memory, "focus")) return "focus";
  return null;
}

function displayName(value?: string | null) {
  const name = value?.trim();
  if (!name || name === "访客" || name === "学习者") return "";
  return name.slice(0, 16);
}

function compactTitle(value?: string | null) {
  const title = value?.trim();
  if (!title) return "眼前这一小步";
  return title.length > 18 ? `“${title.slice(0, 18)}…”` : `“${title}”`;
}

function movementVariant(activeMinutes: number): PiloMovementVariant {
  if (activeMinutes < 60) return "stretch";
  return "walk";
}

export function createPiloScenePresentation(
  id: PiloSceneId,
  facts: PiloSceneFacts,
  personalized = true,
): PiloScenePresentation {
  const name = personalized ? displayName(facts.username) : "";
  const prefix = name ? `${name}，` : "";
  const itemCount = Math.max(0, facts.itemCount ?? 0);
  const completedCount = Math.max(0, facts.completedCount ?? 0);
  const pendingCount = Math.max(0, itemCount - completedCount);

  if (id === "morning") {
    const planCopy = personalized && itemCount > 0
      ? pendingCount > 0
        ? `今天有 ${pendingCount} 项待推进，我们先完成最重要的一件吧。`
        : `今天的 ${itemCount} 项计划已经完成，给自己一个从容的早晨吧。`
      : "今天也从最值得完成的一件事开始吧。";
    return { id, eyebrow: "清晨计划", message: `早上好呀，${prefix}${planCopy}`, actionLabel: "查看今日计划", href: "/studio/work", mood: "reading", duration: 16_000, reason: "现在是早晨，Pilo 带着真实的今日计划来问候" };
  }
  if (id === "focus") {
    const target = personalized ? compactTitle(facts.currentObjectTitle) : "眼前这一小步";
    return { id, eyebrow: "桌前陪伴", message: `${prefix}Pilo 和你一起推进${target}。不用赶，保持现在的节奏。`, actionLabel: "继续这一小步", mood: "working", duration: 14_000, reason: "你正在推进任务，Pilo 在桌前安静陪伴" };
  }
  if (id === "lunch") {
    return { id, eyebrow: "午间补给", message: `${prefix}到午饭时间啦。先补充一点能量，回来再继续也不迟。`, actionLabel: "知道啦", mood: "sitting", lifeAction: "tea-break", duration: 14_000, reason: "现在处于午餐时间窗口，Pilo 轻声提醒补充能量" };
  }
  if (id === "dinner") {
    return { id, eyebrow: "晚餐时间", message: `${prefix}忙了一下午，先好好吃饭吧。今天剩下的事可以慢慢来。`, actionLabel: "知道啦", mood: "sitting", lifeAction: "tea-break", duration: 14_000, reason: "现在处于晚餐时间窗口，Pilo 提醒先照顾好自己" };
  }
  if (id === "movement") {
    const variant = movementVariant(Math.max(45, facts.activeMinutes ?? 45));
    const copy = variant === "walk" ? "走动两分钟" : "伸展一下身体";
    return { id, eyebrow: "活动一下", message: `${prefix}已经专注一段时间啦。要不要和 Pilo 一起${copy}？`, actionLabel: "一起活动", mood: variant === "walk" ? "walking" : "stretching", movementVariant: variant, duration: 14_000, reason: "连续使用时间较长，Pilo 邀请你短暂活动" };
  }
  if (id === "review") {
    const progressCopy = personalized && completedCount > 0
      ? `今天已经完成 ${completedCount} 件事啦，要不要一起看看明天最重要的一步？`
      : "今天的节奏要收尾啦，要不要一起看看明天最重要的一步？";
    return { id, eyebrow: "晚间回顾", message: `${prefix}${progressCopy}`, actionLabel: "看看今日进度", href: "/studio/work", mood: "reading", duration: 16_000, reason: "今天已有真实完成记录，Pilo 邀请你做一次轻量回顾" };
  }
  return { id, eyebrow: "夜间休息", message: `${prefix}夜深啦，今天辛苦了。剩下的事情可以交给明天的你。`, actionLabel: "晚安", mood: "sitting", lifeAction: "sign-off", duration: 18_000, reason: "已到你设置的休息时间附近，Pilo 今晚只提醒这一次" };
}

export function signalPiloScene(scene: PiloSceneId) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<{ scene: PiloSceneId }>(PILO_SCENE_EVENT, { detail: { scene } }));
}
