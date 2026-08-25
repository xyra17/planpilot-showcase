"use client";

import {
  Activity,
  ArrowRight,
  BookOpen,
  BrainCircuit,
  ChevronDown,
  Clock3,
  Check,
  Focus,
  Info,
  Laptop,
  MessageCircle,
  Moon,
  MoreHorizontal,
  Move,
  Pause,
  PersonStanding,
  Play,
  Settings2,
  ShieldCheck,
  Shirt,
  Sparkles,
  Star,
  Square,
  SunMedium,
  SunMoon,
  TimerReset,
  Utensils,
  X,
  type LucideIcon,
} from "lucide-react";
import { animate as animateMotion, AnimatePresence, motion, type MotionStyle, useDragControls, useMotionValue, useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { PiloAvatar, type PiloMood } from "@/components/technology/PiloAvatar";
import { PiloSceneStage } from "@/components/technology/PiloSceneStage";
import { useAuth } from "@/components/technology/AuthProvider";
import { PILO_ACCESSORY_LABELS, PILO_ACCESSORY_MATRIX } from "@/lib/technology/piloAssets";
import { buildPiloCoachHref, type PiloCoachEntry } from "@/lib/technology/piloCoachRoute";
import {
  PILO_CONTEXT_EVENT,
  choosePiloSuggestion,
  createPiloContextSnapshot,
  readLatestPiloContextSignal,
  recordPiloSuggestionInteraction,
  reducePiloContextSnapshot,
  surfaceForPath,
  type PiloContextDetail,
  type PiloContextSnapshot,
  type PiloSuggestion,
  type PiloSuggestionInteraction,
  type PiloSuggestionMemory,
} from "@/lib/technology/piloContext";
import { capturePiloCoachTransition } from "@/lib/technology/piloTransition";
import {
  normalizePiloInterruptionBudget,
  piloAccessoryReason,
  piloDayKey,
  piloNudgeLimit,
  piloModePolicy,
  piloPresentationDelay,
  PILO_ACTION_PHASE_DURATION_MS,
  PILO_LIFE_ACTIONS,
  type PiloActionPhase,
  type PiloInterruptionBudget,
  type PiloLifeActionDefinition,
} from "@/lib/technology/piloRhythm";
import {
  PILO_STATE_EVENT,
  signalPiloState,
  type PiloAccessory,
  type PiloStateDetail,
  type PiloSystemState,
} from "@/lib/technology/piloState";
import { scopedStorageKey } from "@/lib/technology/scopedStorage";
import {
  PILO_LAYER_LABEL,
  PiloStateScheduler,
  type PiloSchedulerSnapshot,
  type PiloTimelineAction,
} from "@/lib/technology/piloScheduler";
import {
  DEFAULT_PILO_SCENE_MEMORY,
  PILO_SCENE_EVENT,
  PILO_SCENE_IDS,
  choosePiloScene,
  createPiloScenePresentation,
  normalizePiloSceneMemory,
  piloSceneDayKey,
  recordPiloSceneShown,
  type PiloSceneId,
  type PiloSceneMemory,
  type PiloScenePresentation,
} from "@/lib/technology/piloScenes";
import {
  PILO_PRESENCE_LOG_KEY,
  normalizePiloPresenceLog,
  piloPresenceSummary,
  recordPiloPresence,
  type PiloPresenceEntry,
  type PiloPresenceLog,
} from "@/lib/technology/piloPresence";

type ActivityMode = "docked" | "gentle" | "active";
type PiloCompanionMode = "quiet" | "balanced" | "focus" | "coach" | "custom";
type PiloOutfit = "auto" | PiloAccessory;
type PiloSettingsTab = "overview" | "scenes" | "functions";
type PiloLifeActionTab = "basic" | "props";
type PiloSettingsSection = "overview" | "presence" | "lifeActions" | "outfits" | "scenePreviews" | "activity" | "automatic" | "scenes" | "rhythm";

const PILO_SETTINGS_TABS: readonly PiloSettingsTab[] = ["overview", "scenes", "functions"];
type PiloPoint = { x: number; y: number };
type PiloFocusTimer = {
  durationMinutes: number;
  remainingSeconds: number;
  endsAt: number | null;
  status: "idle" | "running" | "paused";
  completionNotified: boolean;
};
type PiloFeatures = {
  proactiveHints: boolean;
  stretchReminders: boolean;
  lifestyleStates: boolean;
  contextAwareness: boolean;
  adaptiveTiming: boolean;
  stateExplanations: boolean;
  dailyScenes: boolean;
  morningScenes: boolean;
  focusScenes: boolean;
  mealScenes: boolean;
  movementScenes: boolean;
  reviewScenes: boolean;
  nightCare: boolean;
  personalizedSceneCopy: boolean;
};
type PiloPreferences = {
  activity: ActivityMode;
  activityDefaultVersion: number;
  mode: PiloCompanionMode;
  outfit: PiloOutfit;
  outfits: PiloAccessory[];
  outfitDefaultVersion: number;
  particles: boolean;
  suggestionInitiative: "quiet" | "balanced" | "present";
  sceneFrequency: "quiet" | "balanced" | "present";
  features: PiloFeatures;
  quietHours: { enabled: boolean; start: number; end: number };
  bedtime: { enabled: boolean; hour: number; minute: number };
  home: PiloPoint;
  pausedUntil: number;
};

type PiloLearnedPreferences = {
  opened: number;
  ignored: number;
  reminderAffinity: number;
  lastInteractionAt: number | null;
  suggestions: PiloSuggestionMemory;
};

const PREFERENCES_KEY = "pp-pilo-preferences-v2";
const ACTIVITY_DEFAULT_VERSION = 1;
const OUTFIT_DEFAULT_VERSION = 3;
const SESSION_HIDDEN_KEY = "pp-pilo-hidden-session";
const SESSION_SLEEP_KEY = "pp-pilo-sleep-session";
const HOVER_DISCOVERY_KEY = "pp-pilo-hover-discovered-v2";
const LEARNED_PREFERENCES_KEY = "pp-pilo-learned-preferences-v2";
const RANDOM_SEED_KEY = "pp-pilo-random-seed-v2";
const INTERRUPTION_BUDGET_KEY = "pp-pilo-interruption-budget-v1";
const DAILY_GREETING_KEY = "pp-pilo-daily-greeting-v1";
const SCENE_MEMORY_KEY = "pp-pilo-scene-memory-v1";
const NIGHT_SCENE_OFF_KEY = "pp-pilo-night-scene-off-v1";
const FOCUS_SESSION_KEY = "pp-pilo-focus-session-v1";
const HYDRATION_NEXT_AT_KEY = "pp-pilo-hydration-next-at-v1";

function piloScopedKey(key: string, userId?: string | null) {
  return scopedStorageKey(`pilo:${key}`, userId);
}

function readPiloValue(key: string, userId?: string | null): string | null {
  if (typeof window === "undefined") return null;
  const namespacedKey = piloScopedKey(key, userId);
  const current = window.localStorage.getItem(namespacedKey);
  if (current !== null) return current;
  if (!userId) {
    const legacy = window.localStorage.getItem(key);
    if (legacy !== null) window.localStorage.setItem(namespacedKey, legacy);
    return legacy;
  }
  return null;
}

function writePiloValue(key: string, value: string, userId?: string | null) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(piloScopedKey(key, userId), value);
  // Legacy Pilo keys remain a guest-only compatibility layer for existing
  // local demos. Account-scoped writes never touch those keys.
  if (!userId) window.localStorage.setItem(key, value);
}

function removePiloValue(key: string, userId?: string | null) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(piloScopedKey(key, userId));
  if (!userId) window.localStorage.removeItem(key);
}

function piloSessionKey(key: string, userId?: string | null) {
  return piloScopedKey(`session:${key}`, userId);
}
const FOCUS_DURATION_OPTIONS = [15, 25, 45, 60] as const;
const DEFAULT_FOCUS_TIMER: PiloFocusTimer = {
  durationMinutes: 25,
  remainingSeconds: 25 * 60,
  endsAt: null,
  status: "idle",
  completionNotified: true,
};
const INACTIVE_THRESHOLD_MS = 75_000;
const EDIT_PAUSE_THRESHOLD_MS = 12_000;
const STRETCH_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const HYDRATION_REMINDER_INTERVAL_MS = 90 * 60 * 1000;
const FOCUS_TIMER_CHECK_MS = 24 * 60 * 1000;
const STRETCH_REMINDER_CHECK_MS = 30_000;
const NAVIGATION_REMINDER_QUIET_MS = 30_000;
const STRETCH_REMINDER_MESSAGE = "坐久啦，起来伸个懒腰、活动一下吧。";
const HYDRATION_REMINDER_MESSAGE = "已经专注一阵子了，喝几口水再继续吧。";
const READING_AMBIENT_GUARD_CHANCE = 0.88;
const DEFAULT_PREFERENCES: PiloPreferences = {
  activity: "docked",
  activityDefaultVersion: ACTIVITY_DEFAULT_VERSION,
  mode: "custom",
  outfit: "auto",
  outfits: [],
  outfitDefaultVersion: OUTFIT_DEFAULT_VERSION,
  particles: true,
  suggestionInitiative: "present",
  sceneFrequency: "present",
  features: {
    proactiveHints: true,
    stretchReminders: true,
    lifestyleStates: true,
    contextAwareness: true,
    adaptiveTiming: true,
    stateExplanations: true,
    dailyScenes: true,
    morningScenes: true,
    focusScenes: true,
    mealScenes: true,
    movementScenes: true,
    reviewScenes: true,
    nightCare: true,
    personalizedSceneCopy: true,
  },
  quietHours: { enabled: false, start: 22, end: 8 },
  bedtime: { enabled: false, hour: 22, minute: 30 },
  home: { x: 0, y: 0 },
  pausedUntil: 0,
};

const DEFAULT_LEARNED_PREFERENCES: PiloLearnedPreferences = {
  opened: 0,
  ignored: 0,
  reminderAffinity: 0,
  lastInteractionAt: null,
  suggestions: {},
};

const ACTIVITY_LABELS: Record<ActivityMode, string> = {
  docked: "原地陪伴",
  gentle: "轻轻漫游",
  active: "自由漫游",
};

const PILO_SCENE_OPTIONS: ReadonlyArray<{ id: PiloSceneId; label: string; description: string; asset: string }> = [
  { id: "morning", label: "清晨计划", description: "Pilo 在暖阳里翻开今日计划", asset: "/pilo/scenes/v4/morning-01.webp" },
  { id: "focus", label: "桌前陪伴", description: "Pilo 坐在桌前和你一起推进", asset: "/pilo/scenes/v4/focus-01.webp" },
  { id: "lunch", label: "午间补给", description: "Pilo 放慢节奏，陪你喝水休息", asset: "/pilo/scenes/v4/lunch-01.webp" },
  { id: "dinner", label: "晚餐时间", description: "Pilo 在暖灯下认真吃晚餐", asset: "/pilo/scenes/v4/dinner-01.webp" },
  { id: "movement", label: "活动一下", description: "Pilo 在阳光房里舒展身体", asset: "/pilo/scenes/v4/movement-01.webp" },
  { id: "review", label: "晚间回顾", description: "Pilo 在暮色里写下今日观察", asset: "/pilo/scenes/v4/review-01.webp" },
];

const PILO_BASIC_LIFE_ACTION_OPTIONS = PILO_LIFE_ACTIONS.filter((action) => action.readiness === "loop-ready");
const PILO_PROP_LIFE_ACTION_OPTIONS = PILO_LIFE_ACTIONS.filter((action) => action.readiness === "complete");

const MODE_OPTIONS: ReadonlyArray<{
  id: Exclude<PiloCompanionMode, "custom">;
  label: string;
  description: string;
}> = [
  { id: "coach", label: "学习伙伴", description: "更主动地提醒关键节点，但不会替你做决定" },
  { id: "focus", label: "原地陪伴", description: "保持当前位置，不漫游，只保留完成与休息节点" },
];

const OUTFIT_OPTIONS: ReadonlyArray<{
  id: PiloOutfit;
  label: string;
  description: string;
  previewMood: PiloMood;
  previewAccessory: PiloAccessory;
}> = [
  { id: "auto", label: "随状态变化", description: "配饰只在能说明当前状态时出现", previewMood: "idle", previewAccessory: "none" },
  { id: "none", label: "经典造型", description: "只使用动作需要的基础造型", previewMood: "idle", previewAccessory: "none" },
  { id: "glasses", label: "圆框眼镜", description: "在阅读、思考和检查时优先出现", previewMood: "idle", previewAccessory: "glasses" },
  { id: "scarf", label: "短围巾", description: "待机和休息时温暖陪伴", previewMood: "idle", previewAccessory: "scarf" },
  { id: "headband", label: "运动头带", description: "伸展与活动提醒时出现", previewMood: "idle", previewAccessory: "headband" },
  { id: "earmuffs", label: "低轮廓耳机", description: "共同专注时隔开一点喧闹", previewMood: "idle", previewAccessory: "earmuffs" },
  { id: "laurel", label: "月桂花环", description: "普通陪伴时带一点轻盈仪式感", previewMood: "idle", previewAccessory: "laurel" },
  { id: "beltbag", label: "探索腰包", description: "普通陪伴时准备和你一起出发", previewMood: "idle", previewAccessory: "beltbag" },
  { id: "wristwarmers", label: "云朵护腕", description: "普通陪伴时保持柔软和轻松", previewMood: "idle", previewAccessory: "wristwarmers" },
];

const EXCLUSIVE_HEAD_OUTFITS = new Set<PiloAccessory>(["headband", "earmuffs", "laurel"]);
const OUTFIT_ORDER: readonly PiloAccessory[] = ["glasses", "scarf", "headband", "earmuffs", "laurel", "beltbag", "wristwarmers"];

function normalizeOutfits(value: unknown): PiloAccessory[] {
  if (!Array.isArray(value)) return [];
  const valid = new Set<PiloAccessory>(OUTFIT_OPTIONS
    .map((option) => option.id)
    .filter((id): id is PiloAccessory => id !== "auto" && id !== "none"));
  const selected = Array.from(new Set(value.filter((item): item is PiloAccessory => valid.has(item as PiloAccessory))));
  const selectedHead = OUTFIT_ORDER.find((item) => EXCLUSIVE_HEAD_OUTFITS.has(item) && selected.includes(item));
  return OUTFIT_ORDER.filter((item) => selected.includes(item) && (!EXCLUSIVE_HEAD_OUTFITS.has(item) || item === selectedHead));
}

function PiloSettingSwitch({
  icon: Icon,
  label,
  description,
  checked,
  onToggle,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="pilo-companion__setting-row"
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
    >
      <span className="pilo-companion__setting-icon"><Icon size={16} /></span>
      <span className="pilo-companion__setting-copy"><strong>{label}</strong><small>{description}</small></span>
      <i className={checked ? "is-on" : ""} aria-hidden="true"><b /></i>
    </button>
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function normalizeFocusTimer(value: unknown, now = Date.now()): PiloFocusTimer {
  if (!value || typeof value !== "object") return DEFAULT_FOCUS_TIMER;
  const candidate = value as Partial<PiloFocusTimer>;
  const durationMinutes = FOCUS_DURATION_OPTIONS.includes(candidate.durationMinutes as (typeof FOCUS_DURATION_OPTIONS)[number])
    ? candidate.durationMinutes as number
    : DEFAULT_FOCUS_TIMER.durationMinutes;
  const status = candidate.status === "running" || candidate.status === "paused" ? candidate.status : "idle";
  if (status === "running" && typeof candidate.endsAt === "number") {
    const remainingSeconds = Math.max(0, Math.ceil((candidate.endsAt - now) / 1_000));
    if (remainingSeconds > 0) return { durationMinutes, remainingSeconds, endsAt: candidate.endsAt, status, completionNotified: false };
    return { durationMinutes, remainingSeconds: 0, endsAt: null, status: "idle", completionNotified: false };
  }
  const remainingSeconds = status === "paused" && Number.isFinite(candidate.remainingSeconds)
    ? clamp(Math.round(candidate.remainingSeconds as number), 1, durationMinutes * 60)
    : durationMinutes * 60;
  return { durationMinutes, remainingSeconds, endsAt: null, status, completionNotified: status === "paused" ? false : true };
}

function formatFocusTime(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getViewportBounds() {
  if (typeof window === "undefined") return { minX: -900, maxX: 0, minY: -560, maxY: 0 };
  const compact = window.innerWidth <= 620;
  return {
    minX: Math.min(0, -window.innerWidth + (compact ? 114 : 162)),
    maxX: 0,
    minY: Math.min(0, -window.innerHeight + (compact ? 122 : 196)),
    maxY: 0,
  };
}

function keepInBounds(point: PiloPoint): PiloPoint {
  const bounds = getViewportBounds();
  return {
    x: clamp(point.x, bounds.minX, bounds.maxX),
    y: clamp(point.y, bounds.minY, bounds.maxY),
  };
}

function contextualStates(context: PiloContextSnapshot): readonly PiloSystemState[] {
  if (context.phase === "editing") return ["working", "thinking"];
  if (context.phase === "reviewing") return ["checking", "reading"];
  if (context.phase === "reading") return ["reading", "thinking"];
  if (context.surface === "goals") return ["checking", "thinking"];
  if (context.surface === "notes" || context.surface === "knowledge") return ["reading", "thinking"];
  return ["idle", "thinking"];
}

function pickAmbientContextState(context: PiloContextSnapshot, random: () => number): PiloSystemState {
  const states = contextualStates(context);
  const alternatives = states.filter((state) => state !== "reading");
  const candidates = states.includes("reading") && alternatives.length > 0 && random() < READING_AMBIENT_GUARD_CHANCE
    ? alternatives
    : states;
  return candidates[Math.floor(random() * candidates.length)] ?? "idle";
}

function contextReason(context: PiloContextSnapshot, state: PiloSystemState) {
  const object = context.currentObjectTitle ? `“${context.currentObjectTitle}”` : "当前内容";
  if (context.phase === "editing") return `你正在编辑${object}，Pilo 暂不打断`;
  if (context.phase === "reviewing") return "你正在检查学习记录与复习线索";
  if (context.surface === "notes") return state === "reading" ? `你正在查看${object}` : "你停下来整理刚才的想法";
  if (context.surface === "knowledge") return state === "reading" ? `你正在阅读${object}` : "你正在几份资料之间核对内容";
  if (context.surface === "goals") return state === "checking" ? "你正在查看目标进展" : "你正在考虑目标的下一步";
  if (context.surface === "today") return "你正在安排或完成今天的学习任务";
  return state === "idle" ? "当前没有需要打断你的学习情境" : "Pilo 正在理解当前工作区";
}

function moodForSystemState(state: PiloSystemState): PiloMood {
  const mood: Record<PiloSystemState, PiloMood> = {
    idle: "idle",
    listening: "listening",
    thinking: "thinking",
    working: "working",
    checking: "checking",
    waiting: "waiting",
    success: "success",
    failure: "failure",
    greeting: "greeting",
    reading: "reading",
    resting: "sitting",
    walking: "walking",
    stretching: "stretching",
  };
  return mood[state];
}

const PILO_STATE_COPY: Record<PiloSystemState, string> = {
  idle: "安静待机",
  listening: "倾听",
  thinking: "思考",
  working: "整理内容",
  checking: "检查结果",
  waiting: "等待确认",
  success: "完成回应",
  failure: "遇到阻碍",
  greeting: "问候",
  reading: "阅读",
  resting: "休息",
  walking: "慢慢走动",
  stretching: "伸展",
};

const PILO_TIMELINE_ACTION_COPY: Record<PiloTimelineAction, string> = {
  requested: "收到状态请求",
  activated: "开始回应",
  resumed: "恢复回应",
  interrupted: "暂时让位",
  released: "结束回应",
  expired: "自然结束",
  "cooled-down": "处于冷却期",
};

const PILO_PRESENCE_KIND_COPY: Record<PiloPresenceEntry["kind"], string> = {
  scene: "陪伴场景",
  suggestion: "学习建议",
  action: "状态回应",
};

function contextForPath(pathname: string, context: PiloContextSnapshot) {
  const currentTitle = context.currentObjectTitle?.trim();
  const currentObject = currentTitle ? `“${currentTitle}”` : "当前内容";
  if (pathname === "/studio/work") {
    const pendingCount = Math.max(0, (context.itemCount ?? 0) - (context.completedCount ?? 0));
    if (currentTitle) {
      return {
        title: `围绕${currentObject}继续推进`,
        description: "先确认它的目标归属、时间安排和下一步，不会因为打开 Pilo 就修改任务。",
        entries: [
          { intent: "pick-selected-task", actionLabel: "判断这一项是否先做", prompt: `结合${currentObject}的目标归属、优先级和今天剩余时间，判断它是否应该先做，并说明理由。` },
          { intent: "schedule-selected-task", actionLabel: "检查这一项的时间", prompt: `检查${currentObject}当前的时间安排与今天剩余可用时段是否匹配；如果需要调整，先给我变更预览，不要直接写入。` },
        ],
      };
    }
    if (pendingCount === 0) {
      return {
        title: "今天没有待完成任务",
        description: "可以回看真实完成记录，或等待下一项任务进入计划。",
        entries: [
          { intent: "review-today", actionLabel: "回看今天的完成记录", prompt: "根据今天真实的任务完成状态和实际投入记录，帮我总结一条简短的复盘，不要编造没有记录的时间。" },
          { intent: "plan-next-task", actionLabel: "准备下一步安排", prompt: "根据当前真实目标和任务，帮我找出下一项可安排的动作；如果没有数据，请明确告诉我。" },
        ],
      };
    }
    return {
      title: `今天还有 ${pendingCount} 项待完成任务`,
      description: "我可以帮你缩小选择，或先检查剩余时段能否放下，不会直接改动计划。",
      entries: [
        { intent: "pick-next-task", actionLabel: "从今天任务里选一项", prompt: "结合今天真实任务、优先级和可用时间，只推荐最适合现在开始的一项，并说明依据。" },
        { intent: "adjust-today-plan", actionLabel: "预览剩余时间调整", prompt: "检查今天剩余任务和真实可用时段，先给出调整预览和影响，等我确认后再应用。" },
      ],
    };
  }
  if (pathname.startsWith("/studio/work/knowledge")) {
    const hasOpenResource = Boolean(context.currentObjectId);
    return {
      title: hasOpenResource ? `一起读懂${currentObject}` : "让资料真正服务于学习",
      description: hasOpenResource ? "先提炼和设问，需要采用时再由你决定。" : "检查资料是否可用，再把它们变成可执行的复习安排。",
      entries: hasOpenResource ? [
        { intent: "summarize-resource", actionLabel: "提炼当前资料", prompt: `请提炼${currentObject}最值得记住的内容，标明依据，先给我预览。` },
        { intent: "generate-review-questions", actionLabel: "生成复习问题", prompt: `请根据${currentObject}生成一组由浅入深的复习问题，暂时不要改动资料。` },
      ] : [
        { intent: "audit-knowledge", actionLabel: "检查可用资料", prompt: "请检查知识空间里哪些资料已经可用于学习，并按关联目标或主题说明适用范围和判断依据。" },
        { intent: "plan-review-from-knowledge", actionLabel: "根据资料安排复习", prompt: "请根据知识空间里已有资料及其目标关联拟一份轻量复习安排；未关联目标的资料请单独标注，先让我确认，不要直接加入计划。" },
      ],
    };
  }
  if (pathname.startsWith("/studio/work/notes")) {
    return {
      title: currentTitle ? `把${currentObject}变得更好复习` : "把刚写下的内容收拢起来",
      description: "保留你的原意，先提供整理预览和复习线索。",
      entries: [
        { intent: "organize-note", actionLabel: "整理当前笔记", prompt: `请整理${currentObject}的结构，保留原意并先给我预览，不要直接修改原文。` },
        { intent: "extract-review-points", actionLabel: "提炼复习要点", prompt: `请从${currentObject}提炼便于复习的要点，并指出仍需要补充的内容。` },
      ],
    };
  }
  if (pathname.startsWith("/studio/work/goals")) {
    const pathGoalId = pathname.match(/^\/studio\/work\/goals\/([^/]+)$/)?.[1];
    const isGoalDetail = Boolean(pathGoalId && pathGoalId !== "new");
    return {
      title: isGoalDetail ? `推进${currentObject}的下一小步` : "在多个目标之间看清重点",
      description: isGoalDetail ? "先拆出可开始的动作，再检查本周是否放得下。" : "结合优先级、进度和时间，找出当前真正值得推进的目标。",
      entries: isGoalDetail ? [
        { intent: "goal-next-step", actionLabel: "拆出下一步", prompt: `请把${currentObject}拆成一个现在就能开始的下一步，先给建议，不要直接修改目标。` },
        { intent: "goal-week-plan", actionLabel: "安排本周推进", prompt: `请结合我的可用时间，为${currentObject}拟一份本周推进安排，等我确认后再应用。` },
      ] : [
        { intent: "prioritize-goals", actionLabel: "找出优先目标", prompt: "请结合优先级、当前进度和可用时间，帮我找出现在最值得推进的目标并说明理由。" },
        { intent: "check-goal-rhythm", actionLabel: "检查推进节奏", prompt: "请检查各个目标最近的推进节奏，指出需要关注的停滞或负担，但不要直接调整计划。" },
      ],
    };
  }
  if (pathname.startsWith("/studio/coach/memory")) {
    return {
      title: "这是我对你的理解。",
      description: "有不准确的地方可以直接告诉我。你的反馈会让我之后的建议更贴近你。",
      entries: [
        { intent: "explain-learning-judgment", actionLabel: "解释一条判断", prompt: "请解释你最近对我的一条学习判断，以及它来自哪些行为。" },
        { intent: "correct-learning-profile", actionLabel: "校正我的画像", prompt: "我想校正你对我的学习画像，请和我逐条确认，不要自行改写。" },
      ],
    };
  }
  if (pathname.startsWith("/studio/settings")) {
    return {
      title: "让规划条件符合你的真实生活",
      description: "我可以检查时间、偏好与提醒之间是否冲突，也可以解释数据如何参与判断。",
      entries: [
        { intent: "audit-planning-settings", actionLabel: "检查规划条件", prompt: "请帮我检查当前的学习偏好、可用时间和提醒设置是否存在冲突，只给建议，不要替我修改。" },
        { intent: "explain-data-memory", actionLabel: "解释数据与记忆", prompt: "请解释 PlanPilot 会使用哪些学习数据和长期记忆，以及它们如何影响建议。" },
      ],
    };
  }
  return {
    title: "先把今天最值得完成的一件事找出来",
    description: "我可以根据任务、优先级和可用时间帮你缩小选择，但不会替你改动计划。",
    entries: [
      { intent: "pick-next-task", actionLabel: "现在先做哪一项", prompt: "请结合今天的任务、优先级和可用时间，帮我判断现在先做哪一项，并说明理由。" },
      { intent: "adjust-today-plan", actionLabel: "调整剩余安排", prompt: "请检查今天剩余的任务和时间，给我一份可行的调整建议，等我确认后再应用。" },
    ],
  };
}

export function PiloCompanion() {
  const pathname = usePathname();
  const { user, updateProfile } = useAuth();
  const reduceMotion = useReducedMotion();
  const dragControls = useDragControls();
  const piloX = useMotionValue(0);
  const piloY = useMotionValue(0);
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [hint, setHint] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [preferences, setPreferences] = useState<PiloPreferences>(DEFAULT_PREFERENCES);
  const [learnedPreferences, setLearnedPreferences] = useState<PiloLearnedPreferences>(DEFAULT_LEARNED_PREFERENCES);
  const learnedAccountSnapshotRef = useRef("");
  const [learningContext, setLearningContext] = useState<PiloContextSnapshot>(() => createPiloContextSnapshot(pathname));
  const [contextClock, setContextClock] = useState(() => Date.now());
  const [activeSuggestion, setActiveSuggestion] = useState<PiloSuggestion | null>(null);
  const [activeScene, setActiveScene] = useState<PiloScenePresentation | null>(null);
  const [sceneMemory, setSceneMemory] = useState<PiloSceneMemory>(DEFAULT_PILO_SCENE_MEMORY);
  const [presenceLog, setPresenceLog] = useState<PiloPresenceLog>(() => normalizePiloPresenceLog(null));
  const [nightSceneOffDayKey, setNightSceneOffDayKey] = useState<string | null>(null);
  const [routeIntroSurface, setRouteIntroSurface] = useState<PiloContextSnapshot["surface"] | null>(() => surfaceForPath(pathname));
  const [scheduler] = useState(() => {
    if (typeof window === "undefined") return new PiloStateScheduler(20260809);
    const querySeed = new URLSearchParams(window.location.search).get("piloSeed");
    const storedSeed = readPiloValue(RANDOM_SEED_KEY, user?.id);
    const seed = Number(querySeed ?? storedSeed ?? 20260809);
    return new PiloStateScheduler(Number.isFinite(seed) ? seed : 20260809);
  });
  const [schedule, setSchedule] = useState<PiloSchedulerSnapshot>(() => scheduler.snapshot());
  const [presentation, setPresentation] = useState(() => scheduler.snapshot().active);
  const [presentationPhase, setPresentationPhase] = useState<PiloActionPhase>("holding");
  const [panelReasonOpen, setPanelReasonOpen] = useState(false);
  const [settingsReasonOpen, setSettingsReasonOpen] = useState(false);
  const [focusTimerOpen, setFocusTimerOpen] = useState(false);
  const [focusTimer, setFocusTimer] = useState<PiloFocusTimer>(DEFAULT_FOCUS_TIMER);
  const [debugOpen, setDebugOpen] = useState(false);
  const [position, setPosition] = useState<PiloPoint>(DEFAULT_PREFERENCES.home);
  const [isFlying, setIsFlying] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [particleToken, setParticleToken] = useState(0);
  const [contextMenu, setContextMenu] = useState<PiloPoint | null>(null);
  const [panelAnchor, setPanelAnchor] = useState<PiloPoint | null>(null);
  const [settingsTab, setSettingsTab] = useState<PiloSettingsTab>("overview");
  const [lifeActionTab, setLifeActionTab] = useState<PiloLifeActionTab>("basic");
  const [expandedSections, setExpandedSections] = useState<Record<PiloSettingsSection, boolean>>({
    overview: false,
    presence: false,
    lifeActions: false,
    outfits: false,
    scenePreviews: false,
    activity: false,
    automatic: false,
    scenes: false,
    rhythm: false,
  });
  const [sleeping, setSleeping] = useState(false);
  const [sessionHidden, setSessionHidden] = useState(false);
  const [ambientCycle, setAmbientCycle] = useState(0);
  const [reminderMessage, setReminderMessage] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [appearanceConfirmation, setAppearanceConfirmation] = useState<string | null>(null);
  const [inactiveLevel, setInactiveLevel] = useState<0 | 1 | 2>(0);
  const [walkDirection, setWalkDirection] = useState<"walking-left" | "walking-right">("walking-right");
  const [hoverStage, setHoverStage] = useState<0 | 1 | 2 | 3>(0);
  const [showFullHoverGuide, setShowFullHoverGuide] = useState(true);
  const draggingRef = useRef(false);
  const longPressRef = useRef<number | null>(null);
  const pointerStartRef = useRef<PiloPoint | null>(null);
  const petButtonRef = useRef<HTMLButtonElement | null>(null);
  const companionPanelRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLElement | null>(null);
  const xAnimationRef = useRef<{ stop: () => void } | null>(null);
  const yAnimationRef = useRef<{ stop: () => void } | null>(null);
  const hoverParticleTimerRef = useRef<number | null>(null);
  const hoverGuideTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const reminderTimerRef = useRef<number | null>(null);
  const presentationTimerRef = useRef<number | null>(null);
  const presentationPhaseTimerRef = useRef<number | null>(null);
  const presentationTransitionKeyRef = useRef<string | null>(null);
  const presentationTransitionTokenRef = useRef(0);
  const appearanceTimerRef = useRef<number | null>(null);
  const sceneTimerRef = useRef<number | null>(null);
  const flightTimerRef = useRef<number | null>(null);
  const flightTokenRef = useRef(0);
  const hoverStageRef = useRef<0 | 1 | 2 | 3>(0);
  const movedDuringPointerRef = useRef(false);
  const ambientHasVariedRef = useRef(false);
  const hintWasOpenedRef = useRef(false);
  const lastSurfaceRef = useRef<PiloContextSnapshot["surface"] | null>(null);
  const lastActivityRef = useRef(Date.now());
  const activeSessionStartedRef = useRef(Date.now());
  const hydrationNextAtRef = useRef(0);
  const reminderSourceRef = useRef("companion:stretch-reminder");
  const timerCheckShownRef = useRef(false);
  const lastNavigationRef = useRef(Date.now());
  const presentationStartedAtRef = useRef(Date.now());
  const presentationRef = useRef(presentation);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const interruptionBudgetRef = useRef<PiloInterruptionBudget>(normalizePiloInterruptionBudget(null));
  const hidden = pathname === "/studio/coach" || pathname.startsWith("/studio/coach/proposals");

  useEffect(() => {
    setSearchQuery(window.location.search);
  }, [pathname]);

  const copy = useMemo(() => contextForPath(pathname, learningContext), [learningContext, pathname]);
  const coachEntryContext = useMemo(() => {
    const pathGoalId = pathname.match(/^\/studio\/work\/goals\/([^/]+)$/)?.[1];
    return {
      surface: learningContext.surface,
      objectId: learningContext.currentObjectId ?? undefined,
      objectTitle: learningContext.currentObjectTitle ?? undefined,
      returnTo: `${pathname}${searchQuery}`,
      goalId: pathGoalId && pathGoalId !== "new" ? pathGoalId : undefined,
      goalIds: pathGoalId && pathGoalId !== "new" ? [pathGoalId] : learningContext.currentGoalIds,
      goalScope: learningContext.currentObjectId
        ? (pathGoalId && pathGoalId !== "new") || learningContext.currentGoalIds.length ? "linked" : "unlinked"
        : undefined,
    } satisfies PiloCoachEntry;
  }, [learningContext.currentGoalIds, learningContext.currentObjectId, learningContext.currentObjectTitle, learningContext.surface, pathname, searchQuery]);
  const remindersPaused = preferences.pausedUntil > Date.now();
  const currentHour = new Date().getHours();
  const quietHoursActive = preferences.quietHours.enabled && (
    preferences.quietHours.start > preferences.quietHours.end
      ? currentHour >= preferences.quietHours.start || currentHour < preferences.quietHours.end
      : currentHour >= preferences.quietHours.start && currentHour < preferences.quietHours.end
  );
  const debugAvailable = process.env.NODE_ENV !== "production"
    || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("piloDebug") === "1");
  const modePolicy = useMemo(() => {
    if (preferences.mode !== "custom") return piloModePolicy(preferences.mode);
    return piloModePolicy("balanced", {
      allowGreeting: preferences.suggestionInitiative !== "quiet" || preferences.sceneFrequency !== "quiet",
      allowSuggestions: preferences.features.proactiveHints && preferences.suggestionInitiative !== "quiet",
      allowScenes: preferences.features.dailyScenes && preferences.sceneFrequency !== "quiet",
      allowAmbientLife: preferences.features.lifestyleStates,
      allowAutoMove: preferences.activity !== "docked",
      allowStretchReminder: preferences.features.stretchReminders,
    });
  }, [preferences]);

  const savePreferences = useCallback((next: PiloPreferences) => {
    const previous = preferencesRef.current;
    const bedtimeChanged = previous.bedtime.enabled !== next.bedtime.enabled
      || previous.bedtime.hour !== next.bedtime.hour
      || previous.bedtime.minute !== next.bedtime.minute;
    setPreferences(next);
    writePiloValue(PREFERENCES_KEY, JSON.stringify(next), user?.id);
    if (bedtimeChanged) {
      setSceneMemory((current) => {
        const normalized = normalizePiloSceneMemory(current);
        const resetNight = {
          ...normalized,
          shown: { ...normalized.shown, night: 0 },
          lastShownAt: 0,
        };
        writePiloValue(SCENE_MEMORY_KEY, JSON.stringify(resetNight), user?.id);
        return resetNight;
      });
      removePiloValue(NIGHT_SCENE_OFF_KEY, user?.id);
      setNightSceneOffDayKey(null);
    }
  }, [user?.id]);

  const saveLearnedPreferences = useCallback((next: PiloLearnedPreferences) => {
    setLearnedPreferences(next);
    writePiloValue(LEARNED_PREFERENCES_KEY, JSON.stringify(next), user?.id);
  }, [user?.id]);

  const rememberPresence = useCallback((entry: PiloPresenceEntry) => {
    setPresenceLog((current) => {
      const next = recordPiloPresence(current, entry);
      writePiloValue(PILO_PRESENCE_LOG_KEY, JSON.stringify(next), user?.id);
      return next;
    });
  }, [user?.id]);

  const reserveInterruption = useCallback((initiative: "quiet" | "balanced" | "present" = preferences.suggestionInitiative) => {
    const budget = normalizePiloInterruptionBudget(interruptionBudgetRef.current);
    const limit = piloNudgeLimit(initiative);
    if (budget.nudges >= limit) return false;
    const nextBudget = { ...budget, nudges: budget.nudges + 1 };
    interruptionBudgetRef.current = nextBudget;
    writePiloValue(INTERRUPTION_BUDGET_KEY, JSON.stringify(nextBudget), user?.id);
    return true;
  }, [preferences.suggestionInitiative, user?.id]);

  const learnFromInteraction = useCallback((kind: "opened" | "ignored") => {
    setLearnedPreferences((current) => {
      const next = {
        ...current,
        opened: current.opened + (kind === "opened" ? 1 : 0),
        ignored: current.ignored + (kind === "ignored" ? 1 : 0),
        reminderAffinity: clamp(current.reminderAffinity + (kind === "opened" ? .12 : -.04), -1, 1),
        lastInteractionAt: kind === "opened" ? Date.now() : current.lastInteractionAt,
      };
      writePiloValue(LEARNED_PREFERENCES_KEY, JSON.stringify(next), user?.id);
      return next;
    });
  }, [user?.id]);

  const learnFromSuggestion = useCallback((suggestion: PiloSuggestion, interaction: PiloSuggestionInteraction) => {
    setLearnedPreferences((current) => {
      const affinityDelta = interaction === "accepted" ? .1
        : interaction === "dismissed" ? -.1
          : interaction === "ignored" ? -.06
            : interaction === "snoozed" ? -.025 : 0;
      const next = {
        ...current,
        reminderAffinity: clamp(current.reminderAffinity + affinityDelta, -1, 1),
        suggestions: recordPiloSuggestionInteraction(current.suggestions, suggestion, interaction),
      };
      writePiloValue(LEARNED_PREFERENCES_KEY, JSON.stringify(next), user?.id);
      return next;
    });
    if (interaction === "shown") {
      rememberPresence({
        id: `suggestion:${suggestion.id}`,
        at: Date.now(),
        kind: "suggestion",
        title: suggestion.category === "capability" ? "说明页面能力" : suggestion.category === "observation" ? "分享一条观察" : "提出下一步建议",
        reason: suggestion.evidence,
      });
    }
  }, [rememberPresence, user?.id]);

  const resolveSuggestion = useCallback((interaction: Exclude<PiloSuggestionInteraction, "shown" | "ignored">) => {
    if (!activeSuggestion) return;
    learnFromSuggestion(activeSuggestion, interaction);
    setHint(false);
    setActiveSuggestion(null);
    if (interaction !== "accepted") setOpen(false);
  }, [activeSuggestion, learnFromSuggestion]);

  const reduceSuggestionFrequency = useCallback(() => {
    if (!activeSuggestion) return;
    setLearnedPreferences((current) => {
      const first = recordPiloSuggestionInteraction(current.suggestions, activeSuggestion, "dismissed");
      const suggestions = recordPiloSuggestionInteraction(first, activeSuggestion, "dismissed");
      const next = { ...current, suggestions };
      writePiloValue(LEARNED_PREFERENCES_KEY, JSON.stringify(next), user?.id);
      return next;
    });
    setHint(false);
    setActiveSuggestion(null);
    setOpen(false);
  }, [activeSuggestion, user?.id]);

  const closeCompanionPanel = useCallback(() => {
    if (activeSuggestion) learnFromSuggestion(activeSuggestion, "dismissed");
    setActiveSuggestion(null);
    setHint(false);
    setOpen(false);
    setPanelReasonOpen(false);
  }, [activeSuggestion, learnFromSuggestion]);

  const closeScene = useCallback(() => {
    if (sceneTimerRef.current) window.clearTimeout(sceneTimerRef.current);
    sceneTimerRef.current = null;
    setActiveScene(null);
    scheduler.release("companion:daily-scene");
  }, [scheduler]);

  const showScene = useCallback((id: PiloSceneId, options?: { record?: boolean }) => {
    const now = Date.now();
    const scene = createPiloScenePresentation(id, {
      username: user?.username,
      itemCount: learningContext.itemCount,
      completedCount: learningContext.completedCount,
      currentObjectTitle: learningContext.currentObjectTitle,
      activeMinutes: Math.max(0, Math.floor((now - activeSessionStartedRef.current) / 60_000)),
    }, preferences.features.personalizedSceneCopy);
    if (sceneTimerRef.current) window.clearTimeout(sceneTimerRef.current);
    setHint(false);
    setActiveSuggestion(null);
    setReminderMessage(null);
    setFeedbackMessage(null);
    setActiveScene(scene);
    rememberPresence({ id: `scene:${id}`, at: now, kind: "scene", title: scene.eyebrow, reason: scene.reason, lifeAction: scene.lifeAction });
    scheduler.request({
      state: scene.mood === "sitting" ? "resting" : scene.mood,
      layer: "context",
      source: "companion:daily-scene",
      reason: scene.reason,
      duration: scene.duration,
      accessory: scene.id === "movement" && scene.movementVariant !== "walk" ? "headband" : "none",
    });
    if (options?.record !== false) {
      setSceneMemory((current) => {
        const next = recordPiloSceneShown(current, id, now);
        writePiloValue(SCENE_MEMORY_KEY, JSON.stringify(next), user?.id);
        return next;
      });
    }
    sceneTimerRef.current = window.setTimeout(() => closeScene(), scene.duration);
  }, [closeScene, learningContext.completedCount, learningContext.currentObjectTitle, learningContext.itemCount, preferences.features.personalizedSceneCopy, rememberPresence, scheduler, user?.id, user?.username]);

  const previewLifeAction = useCallback((action: PiloLifeActionDefinition) => {
    setContextMenu(null);
    window.setTimeout(() => {
      scheduler.release("companion:interaction");
      scheduler.request({
        state: action.state,
        layer: "interaction",
        source: "companion:manual-life-action",
        reason: `你选择让 Pilo 预览「${action.label}」`,
        duration: 8_200,
        minimumDwell: 2_800,
        interrupt: "same-or-higher",
        accessory: action.accessory,
        lifeAction: action.id,
      });
    }, 80);
  }, [scheduler]);

  const burst = useCallback(() => {
    if (!reduceMotion && preferences.particles) setParticleToken((current) => current + 1);
  }, [preferences.particles, reduceMotion]);

  const movePilo = useCallback((nextPoint: PiloPoint, options?: { home?: boolean; burst?: boolean }) => {
    const next = keepInBounds(nextPoint);
    const distance = Math.hypot(next.x - piloX.get(), next.y - piloY.get());
    if (distance < 2) return;
    const duration = clamp(distance / 420, .72, 1.65);
    const flightToken = ++flightTokenRef.current;
    if (flightTimerRef.current) window.clearTimeout(flightTimerRef.current);
    setWalkDirection(next.x < piloX.get() ? "walking-left" : "walking-right");
    xAnimationRef.current?.stop();
    yAnimationRef.current?.stop();
    setIsFlying(!reduceMotion);
    setPosition(next);
    if (reduceMotion) {
      piloX.set(next.x);
      piloY.set(next.y);
    } else {
      xAnimationRef.current = animateMotion(piloX, next.x, { duration, ease: [0.25, 0.1, 0.25, 1] });
      yAnimationRef.current = animateMotion(piloY, next.y, { duration, ease: [0.25, 0.1, 0.25, 1] });
    }
    if (options?.burst !== false) burst();
    if (options?.home) savePreferences({ ...preferences, home: next });
    flightTimerRef.current = window.setTimeout(() => {
      if (flightTokenRef.current !== flightToken) return;
      setIsFlying(false);
      if (options?.burst !== false) burst();
      flightTimerRef.current = null;
    }, reduceMotion ? 0 : duration * 1_000 + 40);
  }, [burst, piloX, piloY, preferences, reduceMotion, savePreferences]);

  const settlePiloInPlace = useCallback(() => {
    flightTokenRef.current += 1;
    if (flightTimerRef.current) window.clearTimeout(flightTimerRef.current);
    flightTimerRef.current = null;
    xAnimationRef.current?.stop();
    yAnimationRef.current?.stop();
    const current = keepInBounds({ x: piloX.get(), y: piloY.get() });
    piloX.set(current.x);
    piloY.set(current.y);
    setPosition(current);
    setIsFlying(false);
  }, [piloX, piloY]);

  const selectOutfit = useCallback((outfit: (typeof OUTFIT_OPTIONS)[number]) => {
    let nextOutfit: PiloOutfit = preferences.outfit;
    let nextOutfits = preferences.outfits;
    let confirmation = "";
    if (outfit.id === "auto") {
      nextOutfit = "auto";
      nextOutfits = [];
      confirmation = "已改为随状态变化；只在动作需要时换装。";
    } else if (outfit.id === "none") {
      nextOutfit = "none";
      nextOutfits = [];
      confirmation = "已恢复经典造型。";
    } else {
      const selected = preferences.outfits.includes(outfit.id);
      if (selected) {
        nextOutfits = preferences.outfits.filter((item) => item !== outfit.id);
        nextOutfit = nextOutfits.length ? nextOutfits[0] : "none";
        confirmation = `已取下${outfit.label}。`;
      } else if (EXCLUSIVE_HEAD_OUTFITS.has(outfit.id)) {
        const replaced = preferences.outfits.find((item) => EXCLUSIVE_HEAD_OUTFITS.has(item));
        nextOutfits = normalizeOutfits([...preferences.outfits.filter((item) => !EXCLUSIVE_HEAD_OUTFITS.has(item)), outfit.id]);
        nextOutfit = outfit.id;
        const replacedLabel = replaced ? OUTFIT_OPTIONS.find((option) => option.id === replaced)?.label : null;
        confirmation = replacedLabel ? `已用${outfit.label}替换${replacedLabel}；头部配饰只能选一件。` : `已戴上${outfit.label}。`;
      } else {
        nextOutfits = normalizeOutfits([...preferences.outfits, outfit.id]);
        nextOutfit = outfit.id;
        confirmation = `已加上${outfit.label}；可继续搭配其它位置。`;
      }
    }
    if (nextOutfit === preferences.outfit && nextOutfits.join("|") === preferences.outfits.join("|")) return;
    savePreferences({ ...preferences, outfit: nextOutfit, outfits: nextOutfits });
    setAppearanceConfirmation(confirmation);
    if (appearanceTimerRef.current) window.clearTimeout(appearanceTimerRef.current);
    appearanceTimerRef.current = window.setTimeout(() => {
      setAppearanceConfirmation(null);
      appearanceTimerRef.current = null;
    }, 2_800);
  }, [preferences, savePreferences]);

  const prepareCoachTransition = useCallback(() => {
    capturePiloCoachTransition();
  }, []);

  const enterCoachFromLink = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    prepareCoachTransition();
  }, [prepareCoachTransition]);

  const openContextMenu = useCallback((clientX: number, clientY: number, tab: PiloSettingsTab = "overview") => {
    const width = 360;
    const height = 640;
    const safeClientX = Number.isFinite(clientX) ? clientX : window.innerWidth - 24;
    const safeClientY = Number.isFinite(clientY) ? clientY : window.innerHeight - 24;
    if (activeSuggestion) learnFromSuggestion(activeSuggestion, "ignored");
    setActiveSuggestion(null);
    setOpen(false);
    setHint(false);
    closeScene();
    setSettingsTab(tab);
    setSettingsReasonOpen(false);
    setContextMenu({
      x: clamp(safeClientX, 12, Math.max(12, window.innerWidth - width - 12)),
      y: clamp(safeClientY, 12, Math.max(12, window.innerHeight - height - 12)),
    });
    burst();
  }, [activeSuggestion, burst, closeScene, learnFromSuggestion]);

  useEffect(() => {
    // Account changes must start from the new namespace. Do not leave the
    // previous user's in-memory companion state visible while storage loads.
    setPreferences(DEFAULT_PREFERENCES);
    setLearnedPreferences(DEFAULT_LEARNED_PREFERENCES);
    setLearningContext(createPiloContextSnapshot(pathname));
    setSceneMemory(DEFAULT_PILO_SCENE_MEMORY);
    setPresenceLog(normalizePiloPresenceLog(null));
    setNightSceneOffDayKey(null);
    setFocusTimer(DEFAULT_FOCUS_TIMER);
    setSleeping(false);
    setSessionHidden(false);
    setShowFullHoverGuide(true);
    learnedAccountSnapshotRef.current = "";
    hydrationNextAtRef.current = 0;
    try {
      const stored = readPiloValue(PREFERENCES_KEY, user?.id);
      const storedPreferences = stored ? JSON.parse(stored) as Partial<PiloPreferences> : null;
      const next = storedPreferences
        ? { ...DEFAULT_PREFERENCES, ...storedPreferences } as PiloPreferences
        : DEFAULT_PREFERENCES;
      const legacyInitiative = (storedPreferences as (Partial<PiloPreferences> & { initiative?: "quiet" | "balanced" | "present" }) | null)?.initiative;
      if (!storedPreferences?.suggestionInitiative && legacyInitiative) next.suggestionInitiative = legacyInitiative;
      if (!storedPreferences?.sceneFrequency && legacyInitiative) next.sceneFrequency = legacyInitiative;
      delete (next as PiloPreferences & { initiative?: unknown }).initiative;
      const needsOutfitDefaultMigration = Boolean(storedPreferences)
        && storedPreferences?.outfitDefaultVersion !== OUTFIT_DEFAULT_VERSION;
      const needsActivityDefaultMigration = Boolean(storedPreferences)
        && storedPreferences?.activityDefaultVersion !== ACTIVITY_DEFAULT_VERSION;
      if (needsOutfitDefaultMigration) {
        const legacyOutfit = storedPreferences?.outfit;
        next.outfits = legacyOutfit && legacyOutfit !== "auto" && legacyOutfit !== "none" ? [legacyOutfit] : [];
        if (legacyOutfit === "auto") next.outfit = "none";
      } else {
        next.outfits = normalizeOutfits(next.outfits);
      }
      next.outfitDefaultVersion = OUTFIT_DEFAULT_VERSION;
      next.features = { ...DEFAULT_PREFERENCES.features, ...next.features };
      next.quietHours = { ...DEFAULT_PREFERENCES.quietHours, ...next.quietHours };
      next.bedtime = { ...DEFAULT_PREFERENCES.bedtime, ...next.bedtime };
      next.home = keepInBounds(next.home);
      const legacyMode = next.mode === "balanced" || next.mode === "quiet";
      if (next.mode === "balanced") {
        next.mode = "coach";
        next.suggestionInitiative = "present";
        next.sceneFrequency = "present";
        next.particles = true;
        next.features = { ...next.features, proactiveHints: true, stretchReminders: true, lifestyleStates: true, dailyScenes: true };
      } else if (next.mode === "quiet") {
        next.mode = "focus";
        next.activity = "docked";
        next.suggestionInitiative = "balanced";
        next.sceneFrequency = "quiet";
        next.particles = false;
        next.features = { ...next.features, proactiveHints: false, stretchReminders: true, lifestyleStates: false, dailyScenes: false };
      }
      if (needsActivityDefaultMigration) {
        next.activity = "docked";
        next.activityDefaultVersion = ACTIVITY_DEFAULT_VERSION;
        if (next.mode === "coach") next.mode = "custom";
      }
      if (needsOutfitDefaultMigration || needsActivityDefaultMigration || legacyMode || legacyInitiative) writePiloValue(PREFERENCES_KEY, JSON.stringify(next), user?.id);
      setPreferences(next);
      setPosition(next.home);
      piloX.set(next.home.x);
      piloY.set(next.home.y);
      setSleeping(window.localStorage.getItem(piloSessionKey(SESSION_SLEEP_KEY, user?.id)) === "true");
      setSessionHidden(window.localStorage.getItem(piloSessionKey(SESSION_HIDDEN_KEY, user?.id)) === "true");
      setShowFullHoverGuide(readPiloValue(HOVER_DISCOVERY_KEY, user?.id) !== "true");
      const learned = readPiloValue(LEARNED_PREFERENCES_KEY, user?.id);
      if (learned) setLearnedPreferences({ ...DEFAULT_LEARNED_PREFERENCES, ...JSON.parse(learned) } as PiloLearnedPreferences);
      const storedBudget = readPiloValue(INTERRUPTION_BUDGET_KEY, user?.id);
      interruptionBudgetRef.current = normalizePiloInterruptionBudget(storedBudget ? JSON.parse(storedBudget) : null);
      const storedSceneMemory = readPiloValue(SCENE_MEMORY_KEY, user?.id);
      setSceneMemory(normalizePiloSceneMemory(storedSceneMemory ? JSON.parse(storedSceneMemory) : null));
      const storedPresence = readPiloValue(PILO_PRESENCE_LOG_KEY, user?.id);
      setPresenceLog(normalizePiloPresenceLog(storedPresence ? JSON.parse(storedPresence) : null));
      setNightSceneOffDayKey(readPiloValue(NIGHT_SCENE_OFF_KEY, user?.id));
      const storedFocusTimer = readPiloValue(FOCUS_SESSION_KEY, user?.id);
      if (storedFocusTimer) setFocusTimer(normalizeFocusTimer(JSON.parse(storedFocusTimer)));
      if (readPiloValue(RANDOM_SEED_KEY, user?.id) === null) {
        writePiloValue(RANDOM_SEED_KEY, String(scheduler.snapshot().seed), user?.id);
      }
    } catch {
      setPreferences(DEFAULT_PREFERENCES);
      setPosition(DEFAULT_PREFERENCES.home);
    }
    setMounted(true);
  }, [pathname, piloX, piloY, reduceMotion, scheduler, user?.id]);

  useEffect(() => {
    const accountLearned = user?.account_preferences?.pilo_learned_preferences;
    if (!accountLearned) return;
    const serialized = JSON.stringify(accountLearned);
    if (serialized === learnedAccountSnapshotRef.current) return;
    learnedAccountSnapshotRef.current = serialized;
    setLearnedPreferences({ ...DEFAULT_LEARNED_PREFERENCES, ...accountLearned } as PiloLearnedPreferences);
    writePiloValue(LEARNED_PREFERENCES_KEY, serialized, user?.id);
  }, [user?.account_preferences?.pilo_learned_preferences, user?.id]);

  useEffect(() => {
    if (!mounted || !user) return;
    const serialized = JSON.stringify(learnedPreferences);
    if (serialized === learnedAccountSnapshotRef.current) return;
    const timer = window.setTimeout(() => {
      learnedAccountSnapshotRef.current = serialized;
      void updateProfile({ account_preferences: { pilo_learned_preferences: learnedPreferences as unknown as Record<string, unknown> } })
        .catch(() => { learnedAccountSnapshotRef.current = ""; });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [learnedPreferences, mounted, updateProfile, user]);

  useEffect(() => {
    writePiloValue(FOCUS_SESSION_KEY, JSON.stringify(focusTimer), user?.id);
  }, [focusTimer, user?.id]);

  useEffect(() => {
    if (focusTimer.status !== "running" || !focusTimer.endsAt) return;
    const updateRemaining = () => {
      const remainingSeconds = Math.max(0, Math.ceil((focusTimer.endsAt! - Date.now()) / 1_000));
      if (remainingSeconds > 0) {
        setFocusTimer((current) => current.status === "running" ? { ...current, remainingSeconds } : current);
        return;
      }
      setFocusTimer((current) => ({ ...current, status: "idle", remainingSeconds: 0, endsAt: null }));
    };
    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1_000);
    return () => window.clearInterval(timer);
  }, [focusTimer.endsAt, focusTimer.status]);

  const focusNearingEnd = focusTimer.status === "running" && focusTimer.remainingSeconds <= 60;

  useEffect(() => {
    if (focusTimer.status === "running") {
      const secondsUntilEnd = focusTimer.endsAt
        ? Math.max(1, Math.ceil((focusTimer.endsAt - Date.now()) / 1_000))
        : focusTimer.durationMinutes * 60;
      scheduler.request({
        state: focusNearingEnd ? "checking" : "working",
        layer: "system",
        source: "companion:focus-session",
        reason: focusNearingEnd ? "本轮专注还剩不到一分钟" : `正在陪你完成 ${focusTimer.durationMinutes} 分钟专注`,
        duration: Math.max(1_500, secondsUntilEnd * 1_000),
        minimumDwell: 1_500,
        interrupt: "same-or-higher",
        accessory: "earmuffs",
        lifeAction: focusNearingEnd ? "check-timer" : undefined,
      });
      return;
    }
    scheduler.release("companion:focus-session");
  }, [focusNearingEnd, focusTimer.durationMinutes, focusTimer.endsAt, focusTimer.status, scheduler]);

  useEffect(() => {
    if (focusTimer.remainingSeconds === 0 && !focusTimer.completionNotified) {
      const completedAt = Date.now();
      const message = `完成了 ${focusTimer.durationMinutes} 分钟专注。先松一口气，再决定下一步。`;
      setFocusTimer((current) => current.remainingSeconds === 0 ? { ...current, completionNotified: true } : current);
      setActiveSuggestion(null);
      setReminderMessage(null);
      setFeedbackMessage(message);
      setHint(true);
      burst();
      rememberPresence({
        id: `focus-complete:${completedAt}`,
        at: completedAt,
        kind: "action",
        title: "完成一轮专注",
        reason: `完成 ${focusTimer.durationMinutes} 分钟专注，Pilo 用放松动作陪你收尾`,
        lifeAction: "relief",
      });
      scheduler.request({
        state: "success",
        layer: "feedback",
        source: "companion:focus-complete",
        reason: `你完成了 ${focusTimer.durationMinutes} 分钟专注`,
        duration: 5_200,
        minimumDwell: 2_400,
        interrupt: "same-or-higher",
        lifeAction: "relief",
      });
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = window.setTimeout(() => {
        setHint(false);
        setFeedbackMessage(null);
      }, 9_000);
    }
  }, [burst, focusTimer.completionNotified, focusTimer.durationMinutes, focusTimer.remainingSeconds, rememberPresence, scheduler]);

  useEffect(() => {
    if (!mounted || hidden || !modePolicy.allowScenes) return;
    const evaluate = () => {
      if (
        activeScene
        || modalOpen
        || open
        || contextMenu
        || hint
        || reminderMessage
        || feedbackMessage
        || activeSuggestion
        || isDragging
        || isFlying
        || sleeping
        || sessionHidden
        || document.visibilityState !== "visible"
      ) return;
      const now = Date.now();
      const scene = choosePiloScene({
        now,
        enteredAt: learningContext.enteredAt,
        activeSessionStartedAt: activeSessionStartedRef.current,
        phase: learningContext.phase,
        activeLayer: schedule.active.layer,
        activeState: schedule.active.state,
        initiative: preferences.sceneFrequency,
        quietHoursActive,
        completedCount: Math.max(0, learningContext.completedCount ?? 0),
        bedtime: preferences.bedtime,
        nightReminderOff: nightSceneOffDayKey === piloSceneDayKey(now),
        features: preferences.features,
        memory: sceneMemory,
      });
      if (scene && modePolicy.allowScenes && reserveInterruption(preferences.sceneFrequency)) showScene(scene);
    };
    const first = window.setTimeout(evaluate, 10_000);
    const interval = window.setInterval(evaluate, 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [activeScene, activeSuggestion, contextMenu, feedbackMessage, hidden, hint, isDragging, isFlying, learningContext.completedCount, learningContext.enteredAt, learningContext.phase, modalOpen, modePolicy.allowScenes, mounted, nightSceneOffDayKey, open, preferences.bedtime, preferences.features, preferences.sceneFrequency, quietHoursActive, reminderMessage, reserveInterruption, sceneMemory, schedule.active.layer, schedule.active.state, sessionHidden, showScene, sleeping]);

  useEffect(() => {
    const onScene = (event: Event) => {
      const id = (event as CustomEvent<{ scene?: PiloSceneId }>).detail?.scene;
      if (!id || !PILO_SCENE_IDS.includes(id)) return;
      showScene(id, { record: false });
    };
    window.addEventListener(PILO_SCENE_EVENT, onScene);
    return () => window.removeEventListener(PILO_SCENE_EVENT, onScene);
  }, [showScene]);

  useEffect(() => {
    if (!activeScene) return;
    if (
      modalOpen
      || open
      || contextMenu
      || isDragging
      || isFlying
      || sleeping
      || sessionHidden
      || schedule.active.layer === "interaction"
      || schedule.active.layer === "agent"
      || schedule.active.layer === "feedback"
    ) closeScene();
  }, [activeScene, closeScene, contextMenu, isDragging, isFlying, modalOpen, open, schedule.active.layer, sessionHidden, sleeping]);

  useEffect(() => {
    const unsubscribe = scheduler.subscribe(setSchedule);
    const timer = window.setInterval(() => scheduler.tick(), 250);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [scheduler]);

  useEffect(() => {
    const target = schedule.active;
    const current = presentationRef.current;
    const targetKey = `${target.id}:${target.state}:${target.accessory}:${target.lifeAction ?? "none"}`;
    if (
      current.id === target.id
      && current.state === target.state
      && current.accessory === target.accessory
      && current.lifeAction === target.lifeAction
    ) {
      if (presentationTimerRef.current) window.clearTimeout(presentationTimerRef.current);
      presentationTimerRef.current = null;
      presentationTransitionKeyRef.current = null;
      presentationRef.current = target;
      setPresentation(target);
      return;
    }
    // Scheduler subscribers may receive the same target more than once while
    // its leaving phase is in progress. Keep the existing timer instead of
    // restarting the 410ms exit indefinitely.
    if (presentationTimerRef.current && presentationTransitionKeyRef.current === targetKey) return;
    const transitionToken = ++presentationTransitionTokenRef.current;
    if (presentationTimerRef.current) window.clearTimeout(presentationTimerRef.current);
    if (presentationPhaseTimerRef.current) window.clearTimeout(presentationPhaseTimerRef.current);
    presentationTransitionKeyRef.current = targetKey;
    const visibleFor = Date.now() - presentationStartedAtRef.current;
    const dwellDelay = piloPresentationDelay(current, target, visibleFor);
    const sameActivityChain = current.source === target.source && current.layer === target.layer;
    const canInterruptImmediately = target.priority > current.priority
      || target.layer === "interaction"
      || sameActivityChain;
    const exitDuration = current.lifeAction && !canInterruptImmediately && !reduceMotion
      ? PILO_ACTION_PHASE_DURATION_MS.leaving
      : 0;
    const delay = canInterruptImmediately ? 0 : Math.max(dwellDelay, exitDuration);
    const commit = () => {
      if (presentationTransitionTokenRef.current !== transitionToken) return;
      const latestActivation = [...schedule.timeline].reverse().find((entry) => (
        entry.source === target.source
        && entry.state === target.state
        && (entry.action === "activated" || entry.action === "resumed")
      ));
      const resumesAction = Boolean(target.lifeAction && latestActivation?.action === "resumed");
      presentationRef.current = target;
      setPresentation(target);
      setPresentationPhase(resumesAction ? "holding" : "entering");
      presentationStartedAtRef.current = Date.now();
      if (resumesAction) {
        presentationPhaseTimerRef.current = null;
        presentationTimerRef.current = null;
        presentationTransitionKeyRef.current = null;
        return;
      }
      presentationPhaseTimerRef.current = window.setTimeout(() => {
        if (presentationTransitionTokenRef.current !== transitionToken) return;
        setPresentationPhase("holding");
        presentationPhaseTimerRef.current = null;
      }, reduceMotion ? 0 : PILO_ACTION_PHASE_DURATION_MS.entering);
      presentationTimerRef.current = null;
      presentationTransitionKeyRef.current = null;
    };
    if (delay <= 0) {
      commit();
      return;
    }
    // A leaving phase only has visual meaning for a life-action sequence.
    // Marking an ordinary delayed state as leaving makes the avatar appear to
    // stall even though there is no exit animation to play.
    setPresentationPhase(current.lifeAction ? "leaving" : "holding");
    presentationTimerRef.current = window.setTimeout(commit, delay);
    // Do not return a per-render cleanup here. React may run that cleanup while
    // the scheduler is emitting an equivalent snapshot, cancelling the only
    // pending commit and leaving Pilo stuck in the leaving phase. A newer
    // target clears/replaces these timers at the top of this effect; unmount is
    // handled by the dedicated teardown effect below.
  }, [reduceMotion, schedule.active, schedule.timeline]);

  useEffect(() => {
    if (!mounted || presentation.layer === "ambient" || presentation.layer === "interaction" || activeScene) return;
    rememberPresence({
      id: `action:${presentation.id}:${presentation.createdAt}`,
      at: Date.now(),
      kind: "action",
      title: presentation.lifeAction
        ? PILO_LIFE_ACTIONS.find((action) => action.id === presentation.lifeAction)?.label ?? "状态回应"
        : `${PILO_LAYER_LABEL[presentation.layer]}回应`,
      reason: presentation.reason,
      state: presentation.state,
      layer: presentation.layer,
      lifeAction: presentation.lifeAction,
    });
  }, [activeScene, mounted, presentation, rememberPresence]);

  useEffect(() => {
    if (!mounted || hidden || !modePolicy.allowGreeting) return;
    const today = piloDayKey();
    if (readPiloValue(DAILY_GREETING_KEY, user?.id) === today) return;
    writePiloValue(DAILY_GREETING_KEY, today, user?.id);
    const timer = window.setTimeout(() => {
      scheduler.request({
        state: "greeting",
        layer: "context",
        source: "companion:daily-greeting",
        reason: "今天第一次见面，Pilo 轻轻向你问好",
        duration: 2_800,
        cooldown: 20 * 60 * 60 * 1000,
        minimumDwell: 1_800,
      });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [hidden, modePolicy.allowGreeting, mounted, scheduler, user?.id]);

  useEffect(() => {
    const now = Date.now();
    // Route-scoped work must never leak into the next page. Releasing it here
    // lets the current supplemental action play its leaving frames before the
    // new page supplies a concrete object-opened/editing signal.
    for (const source of [
      "companion:learning-activity",
      "companion:surface-life:notes",
      "companion:surface-life:knowledge",
      "companion:surface-life:goals",
      "notes:capture-idea",
      "notes:save",
      "goals:create",
      "goals:status",
    ]) scheduler.release(source, now);
    const previousSurface = lastSurfaceRef.current;
    if (previousSurface) {
      scheduler.release(`context:${previousSurface}:completed`, now);
    }
    let next = createPiloContextSnapshot(pathname, now);
    const latest = readLatestPiloContextSignal();
    if (latest && now - latest.at < 2_000 && (!latest.detail.surface || latest.detail.surface === next.surface)) {
      next = reducePiloContextSnapshot(next, latest.detail, latest.at);
    }
    if (lastSurfaceRef.current !== next.surface) setRouteIntroSurface(next.surface);
    lastSurfaceRef.current = next.surface;
    setLearningContext(next);
    setActiveSuggestion(null);
    setFeedbackMessage(null);
  }, [pathname, scheduler]);

  useEffect(() => {
    if (learningContext.phase !== "arriving") return;
    const timer = window.setTimeout(() => {
      setLearningContext((current) => current.phase === "arriving" ? { ...current, phase: "browsing" } : current);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [learningContext.phase, pathname]);

  useEffect(() => {
    const onContextSignal = (event: Event) => {
      const detail = (event as CustomEvent<PiloContextDetail>).detail;
      if (!detail?.kind) return;
      const now = Date.now();
      setLearningContext((current) => reducePiloContextSnapshot(current, detail, now));
      if (detail.kind !== "completed") return;
      const message = detail.message ?? "这一小步已经完成。先把成果留住就好。";
      setActiveSuggestion(null);
      setReminderMessage(null);
      setFeedbackMessage(message);
      setHint(true);
      signalPiloState("success", {
        source: `context:${detail.surface ?? "workspace"}:completed`,
        layer: "system",
        reason: message,
        duration: 3_800,
        cooldown: 1_200,
        lifeAction: detail.surface === "goals" ? "nurture-growth" : "tidy-desk",
      });
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = window.setTimeout(() => {
        setHint(false);
        setFeedbackMessage(null);
      }, 4_800);
    };
    window.addEventListener(PILO_CONTEXT_EVENT, onContextSignal);
    return () => {
      window.removeEventListener(PILO_CONTEXT_EVENT, onContextSignal);
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setContextClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const storedNextAt = Number(readPiloValue(HYDRATION_NEXT_AT_KEY, user?.id));
    const nextAt = Number.isFinite(storedNextAt) && storedNextAt > 0
      ? storedNextAt
      : Date.now() + HYDRATION_REMINDER_INTERVAL_MS;
    hydrationNextAtRef.current = nextAt;
    writePiloValue(HYDRATION_NEXT_AT_KEY, String(nextAt), user?.id);
  }, [user?.id]);

  useEffect(() => {
    if (
      hydrationNextAtRef.current <= 0
      || contextClock < hydrationNextAtRef.current
      || !mounted
      || hidden
      || !modePolicy.allowStretchReminder
      || !preferences.features.stretchReminders
      || !preferences.features.lifestyleStates
      || remindersPaused
      || quietHoursActive
      || sleeping
      || sessionHidden
      || open
      || contextMenu
      || modalOpen
      || document.visibilityState !== "visible"
      || Date.now() - lastActivityRef.current >= INACTIVE_THRESHOLD_MS
      || Date.now() - lastNavigationRef.current < NAVIGATION_REMINDER_QUIET_MS
    ) return;
    if (!reserveInterruption()) {
      const retryAt = Date.now() + 15 * 60 * 1000;
      hydrationNextAtRef.current = retryAt;
      writePiloValue(HYDRATION_NEXT_AT_KEY, String(retryAt), user?.id);
      return;
    }
    const nextAt = Date.now() + HYDRATION_REMINDER_INTERVAL_MS;
    hydrationNextAtRef.current = nextAt;
    activeSessionStartedRef.current = Date.now();
    timerCheckShownRef.current = false;
    writePiloValue(HYDRATION_NEXT_AT_KEY, String(nextAt), user?.id);
    const hydrationDetail: PiloStateDetail = {
      state: "resting",
      source: "companion:hydration-reminder",
      layer: "inactivity",
      reason: "距离上次补水提示已经过去约九十分钟",
      duration: 10_000,
      cooldown: HYDRATION_REMINDER_INTERVAL_MS,
      minimumDwell: 3_000,
      interrupt: "same-or-higher",
      message: HYDRATION_REMINDER_MESSAGE,
      lifeAction: "tea-break",
    };
    // This may become due during the component's first effect pass, before
    // the global state-event listener exists. Apply it locally so a persisted
    // overdue reminder cannot be lost on refresh.
    reminderSourceRef.current = hydrationDetail.source!;
    setActiveSuggestion(null);
    setFeedbackMessage(null);
    setReminderMessage(HYDRATION_REMINDER_MESSAGE);
    setHint(true);
    scheduler.request(hydrationDetail);
    if (reminderTimerRef.current) window.clearTimeout(reminderTimerRef.current);
    reminderTimerRef.current = window.setTimeout(() => {
      setHint(false);
      setReminderMessage(null);
      reminderTimerRef.current = null;
    }, 10_000);
  }, [contextClock, contextMenu, hidden, modalOpen, modePolicy.allowStretchReminder, mounted, open, preferences.features.lifestyleStates, preferences.features.stretchReminders, quietHoursActive, remindersPaused, reserveInterruption, scheduler, sessionHidden, sleeping, user?.id]);

  useEffect(() => {
    if (learningContext.phase === "editing" && learningContext.lastEditAt && contextClock - learningContext.lastEditAt >= EDIT_PAUSE_THRESHOLD_MS) {
      setLearningContext((current) => current.phase === "editing" ? { ...current, phase: "paused" } : current);
    }
    if (learningContext.phase === "completed" && learningContext.lastCompletedAt && contextClock - learningContext.lastCompletedAt >= 5_000) {
      setLearningContext((current) => current.phase === "completed" ? { ...current, phase: "browsing", completionMessage: null } : current);
    }
  }, [contextClock, learningContext.lastCompletedAt, learningContext.lastEditAt, learningContext.phase]);

  useEffect(() => {
    const onPiloState = (event: Event) => {
      const detail = (event as CustomEvent<PiloStateDetail>).detail;
      if (!detail?.state) return;
      const isStretchReminder = detail.state === "stretching";
      const isHydrationReminder = detail.source === "companion:hydration-reminder";
      const isWellbeingReminder = isStretchReminder || isHydrationReminder;
      setReminderMessage(isWellbeingReminder
        ? detail.message ?? (isHydrationReminder ? HYDRATION_REMINDER_MESSAGE : STRETCH_REMINDER_MESSAGE)
        : null);
      if (isWellbeingReminder) {
        reminderSourceRef.current = detail.source ?? "companion:stretch-reminder";
        setActiveSuggestion(null);
        setFeedbackMessage(null);
        setHint(true);
        if (reminderTimerRef.current) window.clearTimeout(reminderTimerRef.current);
        reminderTimerRef.current = window.setTimeout(() => {
          setHint(false);
          setReminderMessage(null);
          reminderTimerRef.current = null;
        }, isHydrationReminder ? 10_000 : 8_000);
      }
      scheduler.request(detail);
    };
    window.addEventListener(PILO_STATE_EVENT, onPiloState);
    return () => {
      window.removeEventListener(PILO_STATE_EVENT, onPiloState);
    };
  }, [scheduler]);

  useEffect(() => {
    if (isDragging) {
      scheduler.request({
        state: "idle",
        layer: "interaction",
        source: "companion:interaction",
        reason: "你正在移动 Pilo，保持稳定站姿",
        interrupt: "same-or-higher",
      });
      return;
    }
    if (isFlying) {
      scheduler.request({
        state: "walking",
        layer: "interaction",
        source: "companion:interaction",
        reason: "Pilo 正在移动到新的陪伴位置",
      });
      return;
    }
    if (open || contextMenu) {
      scheduler.request({
        state: "listening",
        layer: "interaction",
        source: "companion:interaction",
        reason: contextMenu ? "你正在查看 Pilo 设置" : "你打开了 Pilo 对话入口",
      });
      return;
    }
    scheduler.release("companion:interaction");
  }, [contextMenu, isDragging, isFlying, open, scheduler]);

  useEffect(() => {
    if (!focusTimerOpen || !contextMenu || focusTimer.status === "running") {
      scheduler.release("companion:focus-timer-preview");
      return;
    }
    scheduler.request({
      state: "checking",
      layer: "interaction",
      source: "companion:focus-timer-preview",
      reason: focusTimer.status === "paused" ? "你正在查看暂停中的专注计时" : "你正在选择本轮专注时长",
      minimumDwell: 1_200,
      interrupt: "same-or-higher",
      lifeAction: "check-timer",
    });
  }, [contextMenu, focusTimer.status, focusTimerOpen, scheduler]);

  useEffect(() => {
    if (!mounted || hidden || !preferences.features.contextAwareness) {
      scheduler.release("companion:page-context");
      scheduler.release("companion:learning-activity");
      return;
    }
    // Navigation only refreshes what Pilo can observe and suggest. A visible
    // action is reserved for concrete learning activity, never the URL alone.
    const state: PiloSystemState | null = learningContext.phase === "editing"
      ? "working"
      : learningContext.phase === "reading"
        ? learningContext.surface === "notes"
          ? null
          : learningContext.surface === "goals" ? "checking" : "reading"
        : learningContext.phase === "reviewing"
          ? "checking"
          : null;
    if (!state) {
      scheduler.release("companion:learning-activity");
      return;
    }
    scheduler.request({
      state,
      layer: "context",
      source: "companion:learning-activity",
      reason: contextReason(learningContext, state),
      duration: state === "working" ? 14_000 : 20_000,
      cooldown: 5_000,
      interrupt: "same-or-higher",
      accessory: learningContext.surface === "goals" ? "wristwarmers" : "glasses",
      lifeAction: learningContext.surface === "notes" && learningContext.phase === "editing"
        ? "capture-idea"
        : learningContext.surface === "knowledge" && learningContext.phase === "reading"
          ? "read"
          : learningContext.surface === "goals" && learningContext.phase === "reading"
            ? "nurture-growth"
            : undefined,
    });
  }, [hidden, learningContext, mounted, preferences.features.contextAwareness, scheduler]);

  useEffect(() => () => {
    if (flightTimerRef.current) window.clearTimeout(flightTimerRef.current);
    if (appearanceTimerRef.current) window.clearTimeout(appearanceTimerRef.current);
    if (presentationTimerRef.current) window.clearTimeout(presentationTimerRef.current);
    if (presentationPhaseTimerRef.current) window.clearTimeout(presentationPhaseTimerRef.current);
    if (sceneTimerRef.current) window.clearTimeout(sceneTimerRef.current);
    if (reminderTimerRef.current) window.clearTimeout(reminderTimerRef.current);
  }, []);

  useEffect(() => {
    if (modePolicy.allowAmbientLife && preferences.features.lifestyleStates && (inactiveLevel > 0 || remindersPaused)) {
      scheduler.request({
        state: "resting",
        layer: "inactivity",
        source: "companion:inactivity",
        reason: remindersPaused ? "你暂停了主动提醒" : "你有一段时间没有操作",
        accessory: "none",
        lifeAction: currentHour >= 22 || currentHour < 6 ? "nap" : inactiveLevel > 1 ? "relief" : undefined,
      });
      return;
    }
    scheduler.release("companion:inactivity");
  }, [currentHour, inactiveLevel, modePolicy.allowAmbientLife, preferences.features.lifestyleStates, remindersPaused, scheduler]);

  useEffect(() => {
    const recordActivity = () => {
      const now = Date.now();
      const wasInactive = now - lastActivityRef.current >= INACTIVE_THRESHOLD_MS;
      lastActivityRef.current = now;
      if (wasInactive) {
        activeSessionStartedRef.current = now;
        timerCheckShownRef.current = false;
        setInactiveLevel(0);
      }
    };
    const activityEvents = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
    activityEvents.forEach((eventName) => window.addEventListener(eventName, recordActivity, { passive: true }));
    const timer = window.setInterval(() => {
      const inactiveFor = Date.now() - lastActivityRef.current;
      setInactiveLevel(inactiveFor >= 180_000 ? 2 : inactiveFor >= INACTIVE_THRESHOLD_MS ? 1 : 0);
    }, 15_000);
    return () => {
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, recordActivity));
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!mounted || hidden || !modePolicy.allowStretchReminder || !preferences.features.stretchReminders || remindersPaused || quietHoursActive || sleeping || sessionHidden || open || contextMenu) return;
    const checkForStretchReminder = () => {
      const now = Date.now();
      if (now - lastActivityRef.current >= INACTIVE_THRESHOLD_MS) return;
      if (now - lastNavigationRef.current < NAVIGATION_REMINDER_QUIET_MS) return;
      const sessionAge = now - activeSessionStartedRef.current;
      if (!timerCheckShownRef.current && sessionAge >= FOCUS_TIMER_CHECK_MS) {
        timerCheckShownRef.current = true;
        scheduler.request({
          state: "checking",
          layer: "inactivity",
          source: "companion:focus-timer-check",
          reason: "这一轮专注接近一个自然收尾点",
          duration: 4_800,
          cooldown: STRETCH_REMINDER_INTERVAL_MS,
          lifeAction: "check-timer",
        });
        return;
      }
      if (now - activeSessionStartedRef.current < STRETCH_REMINDER_INTERVAL_MS) return;
      if (!reserveInterruption()) return;
      activeSessionStartedRef.current = now;
      timerCheckShownRef.current = false;
      signalPiloState("stretching", {
        source: "companion:stretch-reminder",
        layer: "inactivity",
        reason: "你已经连续使用了一段时间",
        duration: 5_200,
        cooldown: STRETCH_REMINDER_INTERVAL_MS,
        interrupt: "same-or-higher",
        accessory: "headband",
        message: STRETCH_REMINDER_MESSAGE,
      });
    };
    const timer = window.setInterval(checkForStretchReminder, STRETCH_REMINDER_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [contextMenu, hidden, modePolicy.allowStretchReminder, mounted, open, preferences.features.stretchReminders, quietHoursActive, remindersPaused, reserveInterruption, scheduler, sessionHidden, sleeping]);

  useEffect(() => {
    const syncExternalPreferences = () => {
      try {
        const stored = readPiloValue(PREFERENCES_KEY, user?.id);
        if (!stored) return;
        const storedPreferences = JSON.parse(stored) as Partial<PiloPreferences>;
        const legacyInitiative = (storedPreferences as Partial<PiloPreferences> & { initiative?: "quiet" | "balanced" | "present" }).initiative;
        const activity = storedPreferences.activityDefaultVersion === ACTIVITY_DEFAULT_VERSION
          ? storedPreferences.activity ?? DEFAULT_PREFERENCES.activity
          : DEFAULT_PREFERENCES.activity;
        const outfit = (storedPreferences.outfitDefaultVersion === OUTFIT_DEFAULT_VERSION
          ? storedPreferences.outfit
          : storedPreferences.outfit === "auto" ? "none" : storedPreferences.outfit) ?? DEFAULT_PREFERENCES.outfit;
        const outfits = storedPreferences.outfitDefaultVersion === OUTFIT_DEFAULT_VERSION
          ? normalizeOutfits(storedPreferences.outfits)
          : outfit !== "auto" && outfit !== "none" ? [outfit] : [];
        const nextPreferences = {
          ...DEFAULT_PREFERENCES,
          ...storedPreferences,
          activity,
          activityDefaultVersion: ACTIVITY_DEFAULT_VERSION,
          mode: storedPreferences.activityDefaultVersion === ACTIVITY_DEFAULT_VERSION
            ? storedPreferences.mode ?? DEFAULT_PREFERENCES.mode
            : "custom",
          suggestionInitiative: storedPreferences.suggestionInitiative ?? legacyInitiative ?? DEFAULT_PREFERENCES.suggestionInitiative,
          sceneFrequency: storedPreferences.sceneFrequency ?? legacyInitiative ?? DEFAULT_PREFERENCES.sceneFrequency,
          outfit,
          outfits,
          outfitDefaultVersion: OUTFIT_DEFAULT_VERSION,
          features: { ...DEFAULT_PREFERENCES.features, ...storedPreferences.features },
          quietHours: { ...DEFAULT_PREFERENCES.quietHours, ...storedPreferences.quietHours },
          bedtime: { ...DEFAULT_PREFERENCES.bedtime, ...storedPreferences.bedtime },
        } as PiloPreferences & { initiative?: unknown };
        delete nextPreferences.initiative;
        setPreferences(nextPreferences);
      } catch {
        // Keep the last valid appearance preferences.
      }
    };
    window.addEventListener("planpilot:pilo-appearance-changed", syncExternalPreferences);
    return () => window.removeEventListener("planpilot:pilo-appearance-changed", syncExternalPreferences);
  }, [user?.id]);

  useEffect(() => {
    if (!mounted || hidden || open || contextMenu || sleeping || sessionHidden || inactiveLevel > 0 || !modePolicy.allowAmbientLife) return;
    const initiativeScale = preferences.suggestionInitiative === "quiet" ? 1.7 : preferences.suggestionInitiative === "present" ? .72 : 1;
    const learnedScale = preferences.features.adaptiveTiming
      ? clamp(1 - learnedPreferences.reminderAffinity * .18, .8, 1.25)
      : 1;
    const baseDelay = !ambientHasVariedRef.current ? 18_000 : 65_000;
    const variance = !ambientHasVariedRef.current ? 6_000 : 35_000;
    const delay = (baseDelay + scheduler.random() * variance) * initiativeScale * learnedScale;
    const timer = window.setTimeout(() => {
      ambientHasVariedRef.current = true;
      const ambientIdleChance = contextualStates(learningContext).includes("reading") ? .66 : .6;
      const state = !preferences.features.lifestyleStates || scheduler.random() < ambientIdleChance
        ? "idle"
        : pickAmbientContextState(learningContext, () => scheduler.random());
      setAmbientCycle((current) => current + 1);
      scheduler.request({
        state,
        layer: "ambient",
        source: "companion:ambient",
        reason: state === "idle" ? "当前没有明确需要介入的学习信号" : contextReason(learningContext, state),
        accessory: state === "reading" || state === "checking" ? "glasses" : "none",
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [ambientCycle, contextMenu, hidden, inactiveLevel, learnedPreferences.reminderAffinity, learningContext, modePolicy.allowAmbientLife, mounted, open, preferences.features.adaptiveTiming, preferences.features.lifestyleStates, preferences.suggestionInitiative, scheduler, sessionHidden, sleeping]);

  useEffect(() => {
    const syncModalState = () => setModalOpen(
      // Pilo's own settings surface is modal for focus management, but it
      // must not hide/unmount the companion that owns that surface. Only
      // external dialogs should suspend the floating companion.
      Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]:not(.pilo-companion__context):not([data-pilo-allow-companion="true"])'))
        .some((element) => element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== "hidden"),
    );
    syncModalState();
    const observer = new MutationObserver(syncModalState);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const onMenuKeyDown = (event: KeyboardEvent) => {
      const menu = contextMenuRef.current;
      if (!menu) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setContextMenu(null);
        window.requestAnimationFrame(() => petButtonRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(menu.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onMenuKeyDown);
    const timer = window.setTimeout(() => {
      const menu = contextMenuRef.current;
      if (!menu) return;
      menu.querySelector<HTMLElement>("a, button")?.focus();
    }, reduceMotion ? 0 : 80);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onMenuKeyDown);
    };
  }, [contextMenu, reduceMotion]);

  const contextMenuOpen = Boolean(contextMenu);

  useEffect(() => {
    if (!contextMenuOpen || !contextMenuRef.current) return;
    const menu = contextMenuRef.current;
    const keepPanelVisible = () => {
      const rect = menu.getBoundingClientRect();
      setContextMenu((current) => {
        if (!current) return current;
        const horizontalOverflow = rect.right > window.innerWidth - 12
          ? rect.right - (window.innerWidth - 12)
          : rect.left < 12 ? rect.left - 12 : 0;
        const verticalOverflow = rect.bottom > window.innerHeight - 12
          ? rect.bottom - (window.innerHeight - 12)
          : rect.top < 12 ? rect.top - 12 : 0;
        const next = {
          x: clamp(current.x - horizontalOverflow, 12, Math.max(12, window.innerWidth - rect.width - 12)),
          y: clamp(current.y - verticalOverflow, 12, Math.max(12, window.innerHeight - rect.height - 12)),
        };
        return Math.abs(next.x - current.x) > 1 || Math.abs(next.y - current.y) > 1 ? next : current;
      });
    };
    const observer = new ResizeObserver(keepPanelVisible);
    observer.observe(menu);
    const frame = window.requestAnimationFrame(keepPanelVisible);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [contextMenuOpen]);

  useEffect(() => {
    const expectedSurface = surfaceForPath(pathname);
    if (learningContext.surface !== expectedSurface) return;
    const staleIntroduction = activeSuggestion?.level === "introduction"
      && activeSuggestion.kind !== `intro-${expectedSurface}`;
    if (staleIntroduction) {
      setActiveSuggestion(null);
      setHint(false);
      return;
    }
    if (
      hidden
      || !mounted
      || !preferences.features.contextAwareness
      || remindersPaused
      || quietHoursActive
      || sleeping
      || sessionHidden
      || open
      || contextMenu
      || modalOpen
      || reminderMessage
      || feedbackMessage
      || activeSuggestion
      || !modePolicy.allowSuggestions
      || document.visibilityState !== "visible"
    ) return;
    const suggestion = choosePiloSuggestion(
      learningContext,
      learnedPreferences.suggestions,
      preferences.suggestionInitiative,
      contextClock,
      { forceIntroduction: routeIntroSurface === learningContext.surface },
    );
    if (!suggestion) return;
    if (suggestion.level === "nudge" && !preferences.features.proactiveHints) return;
    if (suggestion.level === "nudge" && !reserveInterruption(preferences.suggestionInitiative)) return;
    hintWasOpenedRef.current = false;
    setActiveSuggestion(suggestion);
    setHint(true);
    if (routeIntroSurface === learningContext.surface) {
      setRouteIntroSurface((current) => current === learningContext.surface ? null : current);
    }
    learnFromSuggestion(suggestion, "shown");
  }, [activeSuggestion, contextClock, contextMenu, feedbackMessage, hidden, learnedPreferences.suggestions, learningContext, learnFromSuggestion, modalOpen, modePolicy.allowSuggestions, mounted, open, pathname, preferences.features.contextAwareness, preferences.features.proactiveHints, preferences.suggestionInitiative, quietHoursActive, reminderMessage, remindersPaused, reserveInterruption, routeIntroSurface, sessionHidden, sleeping]);

  useEffect(() => {
    if (!hint || !activeSuggestion || open) return;
    const timer = window.setTimeout(() => {
      if (!hintWasOpenedRef.current) learnFromSuggestion(activeSuggestion, "ignored");
      setHint(false);
      setActiveSuggestion(null);
    }, activeSuggestion.level === "introduction" ? 11_000 : 8_000);
    return () => window.clearTimeout(timer);
  }, [activeSuggestion, hint, learnFromSuggestion, open]);

  useEffect(() => {
    lastNavigationRef.current = Date.now();
    setReminderMessage(null);
    setFeedbackMessage(null);
    setActiveSuggestion(null);
    setOpen(false);
    setContextMenu(null);
    setHint(false);
    setPanelReasonOpen(false);
    closeScene();
  }, [closeScene, pathname]);

  useEffect(() => {
    if (!mounted || hidden || !modePolicy.allowAutoMove || !preferences.features.lifestyleStates || reduceMotion || open || contextMenu || sleeping || sessionHidden || preferences.activity === "docked") return;
    const delay = preferences.activity === "active"
      ? 40_000 + scheduler.random() * 25_000
      : 70_000 + scheduler.random() * 40_000;
    const timer = window.setTimeout(() => {
      const bounds = getViewportBounds();
      if (preferences.activity === "gentle") {
        movePilo({
          x: preferences.home.x - 34 - scheduler.random() * 112,
          y: preferences.home.y - 20 - scheduler.random() * 96,
        });
        return;
      }
      const safeStops: PiloPoint[] = [
        preferences.home,
        { x: bounds.minX, y: 0 },
        { x: 0, y: bounds.minY },
        { x: bounds.minX, y: bounds.minY },
        { x: bounds.minX * .48, y: bounds.minY * .76 },
      ];
      const candidates = safeStops.filter((item) => Math.hypot(item.x - position.x, item.y - position.y) > 160);
      movePilo(scheduler.pick(candidates) ?? preferences.home);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [contextMenu, hidden, modePolicy.allowAutoMove, mounted, movePilo, open, position.x, position.y, preferences.activity, preferences.features.lifestyleStates, preferences.home, reduceMotion, scheduler, sessionHidden, sleeping]);

  useEffect(() => {
    const onResize = () => {
      const nextHome = keepInBounds(preferences.home);
      const nextPosition = keepInBounds(position);
      setPosition(nextPosition);
      piloX.set(nextPosition.x);
      piloY.set(nextPosition.y);
      setContextMenu((current) => current ? {
        x: clamp(current.x, 12, Math.max(12, window.innerWidth - 360 - 12)),
        y: clamp(current.y, 12, Math.max(12, window.innerHeight - 640 - 12)),
      } : null);
      if (nextHome.x !== preferences.home.x || nextHome.y !== preferences.home.y) {
        savePreferences({ ...preferences, home: nextHome });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [piloX, piloY, position, preferences, savePreferences]);

  const positionCompanionPanel = useCallback(() => {
    if (!open) return;
    const pet = petButtonRef.current;
    const panel = companionPanelRef.current;
    if (!pet || !panel) return;

    const safeInset = 12;
    const anchorGap = 12;
    const petRect = pet.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const panelWidth = panelRect.width;
    const panelHeight = panelRect.height;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const alignToRight = petRect.left + petRect.width / 2 >= viewportWidth / 2;
    const preferredLeft = alignToRight ? petRect.right - panelWidth : petRect.left;
    const left = clamp(preferredLeft, safeInset, Math.max(safeInset, viewportWidth - panelWidth - safeInset));
    const above = petRect.top - panelHeight - anchorGap;
    const below = petRect.bottom + anchorGap;
    const top = above >= safeInset
      ? above
      : below + panelHeight <= viewportHeight - safeInset
        ? below
        : clamp(
          petRect.top + petRect.height / 2 - panelHeight / 2,
          safeInset,
          Math.max(safeInset, viewportHeight - panelHeight - safeInset),
        );

    setPanelAnchor((current) => current
      && Math.abs(current.x - left) < .5
      && Math.abs(current.y - top) < .5
      ? current
      : { x: left, y: top });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelAnchor(null);
      return;
    }

    let frame = window.requestAnimationFrame(positionCompanionPanel);
    const panel = companionPanelRef.current;
    const observer = typeof ResizeObserver === "undefined" || !panel
      ? null
      : new ResizeObserver(() => {
        window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(positionCompanionPanel);
      });
    if (observer && panel) observer.observe(panel);
    const onResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(positionCompanionPanel);
    };
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, [open, positionCompanionPanel]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextMenu(null);
      setOpen(false);
      window.requestAnimationFrame(() => petButtonRef.current?.focus());
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, []);

  useEffect(() => {
    if (!preferences.pausedUntil || preferences.pausedUntil <= Date.now()) return;
    const timer = window.setTimeout(() => {
      savePreferences({ ...preferences, pausedUntil: 0 });
    }, Math.min(preferences.pausedUntil - Date.now(), 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [preferences, savePreferences]);

  const clearLongPress = () => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current);
    longPressRef.current = null;
    pointerStartRef.current = null;
  };

  const clearHoverTimers = () => {
    if (hoverParticleTimerRef.current) window.clearTimeout(hoverParticleTimerRef.current);
    if (hoverGuideTimerRef.current) window.clearTimeout(hoverGuideTimerRef.current);
    hoverParticleTimerRef.current = null;
    hoverGuideTimerRef.current = null;
  };

  const setHoverState = (stage: 0 | 1 | 2 | 3) => {
    hoverStageRef.current = stage;
    setHoverStage(stage);
  };

  const beginHover = (pointerType: string) => {
    if (pointerType === "touch") return;
    clearHoverTimers();
    setHoverState(1);
    hoverParticleTimerRef.current = window.setTimeout(() => setHoverState(2), 300);
    hoverGuideTimerRef.current = window.setTimeout(() => setHoverState(3), 500);
  };

  const endHover = (rememberDiscovery = true) => {
    clearHoverTimers();
    if (rememberDiscovery && showFullHoverGuide && hoverStageRef.current === 3) {
      writePiloValue(HOVER_DISCOVERY_KEY, "true", user?.id);
      setShowFullHoverGuide(false);
    }
    setHoverState(0);
  };

  const setActivity = (activity: ActivityMode) => {
    savePreferences({ ...preferences, activity, mode: "custom" });
    if (activity === "docked") movePilo(preferences.home);
  };

  const applyMode = (mode: Exclude<PiloCompanionMode, "custom">) => {
    const modePreferences: Record<Exclude<PiloCompanionMode, "custom">, Partial<PiloPreferences>> = {
      quiet: {
        activity: "docked",
        suggestionInitiative: "quiet",
        sceneFrequency: "quiet",
        particles: false,
        features: { ...preferences.features, proactiveHints: false, stretchReminders: false, lifestyleStates: false, dailyScenes: false },
      },
      balanced: {
        activity: "gentle",
        suggestionInitiative: "balanced",
        sceneFrequency: "balanced",
        particles: true,
        features: { ...preferences.features, proactiveHints: true, stretchReminders: true, lifestyleStates: true, dailyScenes: true },
      },
      focus: {
        activity: "docked",
        suggestionInitiative: "balanced",
        sceneFrequency: "quiet",
        particles: false,
        features: { ...preferences.features, proactiveHints: false, stretchReminders: true, lifestyleStates: false, dailyScenes: false },
      },
      coach: {
        activity: "active",
        suggestionInitiative: "present",
        sceneFrequency: "present",
        particles: true,
        features: { ...preferences.features, proactiveHints: true, stretchReminders: true, lifestyleStates: true, dailyScenes: true },
      },
    };
    const next = { ...preferences, ...modePreferences[mode], mode } as PiloPreferences;
    savePreferences(next);
    if (next.activity === "docked") movePilo(next.home);
  };

  const toggleFeature = (feature: keyof PiloFeatures) => {
    const nextValue = !preferences.features[feature];
    if (feature === "stateExplanations" && !nextValue) {
      setPanelReasonOpen(false);
      setSettingsReasonOpen(false);
    }
    savePreferences({
      ...preferences,
      mode: "custom",
      features: { ...preferences.features, [feature]: nextValue },
    });
  };

  const toggleSettingsSection = (section: PiloSettingsSection) => {
    setExpandedSections((current) => ({ ...current, [section]: !current[section] }));
  };

  const moveSettingsTab = (event: React.KeyboardEvent<HTMLButtonElement>, tab: PiloSettingsTab) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const currentIndex = PILO_SETTINGS_TABS.indexOf(tab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? PILO_SETTINGS_TABS.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + PILO_SETTINGS_TABS.length) % PILO_SETTINGS_TABS.length;
    const nextTab = PILO_SETTINGS_TABS[nextIndex];
    setSettingsTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById(`pilo-settings-tab-${nextTab}`)?.focus());
  };

  const pauseReminders = (duration: number) => {
    savePreferences({ ...preferences, pausedUntil: Date.now() + duration });
    setHint(false);
    setOpen(false);
    setContextMenu(null);
    closeScene();
  };

  const selectFocusDuration = (durationMinutes: number) => {
    if (focusTimer.status === "running") return;
    setFocusTimer({ durationMinutes, remainingSeconds: durationMinutes * 60, endsAt: null, status: "idle", completionNotified: true });
  };

  const startFocusTimer = () => {
    const remainingSeconds = focusTimer.remainingSeconds > 0
      ? focusTimer.remainingSeconds
      : focusTimer.durationMinutes * 60;
    setFeedbackMessage(null);
    setFocusTimer({
      ...focusTimer,
      remainingSeconds,
      endsAt: Date.now() + remainingSeconds * 1_000,
      status: "running",
      completionNotified: false,
    });
  };

  const pauseFocusTimer = () => {
    const remainingSeconds = focusTimer.endsAt
      ? Math.max(1, Math.ceil((focusTimer.endsAt - Date.now()) / 1_000))
      : focusTimer.remainingSeconds;
    setFocusTimer({ ...focusTimer, remainingSeconds, endsAt: null, status: "paused" });
  };

  const stopFocusTimer = () => {
    setFocusTimer({
      ...focusTimer,
      remainingSeconds: focusTimer.durationMinutes * 60,
      endsAt: null,
      status: "idle",
      completionNotified: true,
    });
    scheduler.release("companion:focus-session");
  };

  const restorePilo = () => {
    window.localStorage.removeItem(piloSessionKey(SESSION_SLEEP_KEY, user?.id));
    window.localStorage.removeItem(piloSessionKey(SESSION_HIDDEN_KEY, user?.id));
    setSleeping(false);
    setSessionHidden(false);
    setPosition(preferences.home);
    burst();
  };

  if (!mounted || hidden || modalOpen) return null;

  if (sessionHidden) {
    return (
      <motion.button
        type="button"
        className="pilo-companion__restore-tab"
        onClick={restorePilo}
        aria-label="重新显示 Pilo"
        initial={{ x: 18 }}
        animate={{ x: 0 }}
      >
        <Star size={15} />
        <span>显示 Pilo</span>
      </motion.button>
    );
  }

  if (sleeping) {
    return (
      <motion.button
        type="button"
        className="pilo-companion__sleep-beacon"
        onClick={restorePilo}
        aria-label="唤醒 Pilo"
        whileHover={reduceMotion ? undefined : { scale: 1.05 }}
      >
        <Moon size={17} />
        <span>唤醒 Pilo</span>
      </motion.button>
    );
  }

  const bounds = getViewportBounds();
  const dragConstraints = {
    left: bounds.minX,
    right: bounds.maxX,
    top: bounds.minY,
    bottom: bounds.maxY,
  };
  const compactPanelLeft = typeof window === "undefined"
    ? 0
    : 12 - (window.innerWidth - 102 + position.x);
  const compactPanelBottom = 100 + position.y;
  const avatarMood: PiloMood = isDragging
    ? "idle"
    : presentation.state === "walking"
      ? walkDirection
      : moodForSystemState(presentation.state);
  const manualOutfits = preferences.outfit === "auto" || preferences.outfit === "none" ? [] : preferences.outfits;
  const compatibleManualAccessory = manualOutfits.find((item) => PILO_ACCESSORY_MATRIX[item][avatarMood]);
  const activeAccessory: PiloAccessory = preferences.outfit === "auto"
    ? isDragging ? "none" : presentation.accessory
    : manualOutfits.length === 0
      ? "none"
      : compatibleManualAccessory
        ? compatibleManualAccessory
        : presentation.accessory;
  const accessoryReason = manualOutfits.length > 1 && (avatarMood === "idle" || avatarMood === "listening")
    ? `当前搭配：${manualOutfits.map((item) => PILO_ACCESSORY_LABELS[item]).join("、")}`
    : piloAccessoryReason(activeAccessory, presentation.state, manualOutfits.includes(activeAccessory));
  const currentModeLabel = preferences.mode === "custom"
    ? "自定义节奏"
    : MODE_OPTIONS.find((mode) => mode.id === preferences.mode)?.label ?? "学习伙伴";
  const presenceSummary = piloPresenceSummary(presenceLog);
  const settingsStateReason = contextMenu && presentation.layer === "interaction"
    ? "你正在调整陪伴方式，Pilo 会留在这里认真听，不触发其它生活动作。"
    : presentation.reason;
  const panelHorizontalSide = position.x < bounds.minX / 2 ? "is-panel-left" : "is-panel-right";
  const panelVerticalSide = position.y < bounds.minY / 2 ? "is-panel-bottom" : "is-panel-top";
  return (
    <>
      <motion.aside
        className={`pilo-companion ${isFlying ? "is-flying" : ""} ${isDragging ? "is-dragging" : ""} ${activeScene ? "is-scene-active" : ""} ${position.x < bounds.minX / 2 ? "is-left-side" : ""} ${position.y < bounds.minY / 2 ? "is-upper-side" : ""}`}
        aria-label="Pilo 学习伙伴"
        data-pilo-state={presentation.state}
        data-pilo-layer={presentation.layer}
        data-pilo-source={presentation.source}
        data-pilo-phase={presentationPhase}
        data-pilo-seed={schedule.seed}
        data-pilo-scene={activeScene?.id ?? "none"}
        data-pilo-life-action={presentation.lifeAction ?? "none"}
        style={{
          x: piloX,
          y: piloY,
          "--pilo-compact-panel-left": `${compactPanelLeft}px`,
          "--pilo-compact-panel-bottom": `${compactPanelBottom}px`,
        } as unknown as MotionStyle}
        initial={false}
        animate={{ opacity: 1 }}
        transition={{ duration: reduceMotion ? 0 : .18, ease: [0.22, 1, 0.36, 1] }}
        drag
        dragControls={dragControls}
        dragListener={false}
        dragMomentum={false}
        dragElastic={.05}
        dragConstraints={dragConstraints}
        onDragStart={() => {
          flightTokenRef.current += 1;
          if (flightTimerRef.current) window.clearTimeout(flightTimerRef.current);
          flightTimerRef.current = null;
          xAnimationRef.current?.stop();
          yAnimationRef.current?.stop();
          setIsFlying(false);
          draggingRef.current = true;
          movedDuringPointerRef.current = true;
          setIsDragging(true);
          endHover(false);
          setOpen(false);
          setHint(false);
          setContextMenu(null);
          closeScene();
        }}
        onDragEnd={() => {
          const next = keepInBounds({ x: piloX.get(), y: piloY.get() });
          piloX.set(next.x);
          piloY.set(next.y);
          setPosition(next);
          savePreferences({ ...preferences, home: next });
          setIsDragging(false);
          window.setTimeout(() => { draggingRef.current = false; }, 120);
          burst();
        }}
      >
        <AnimatePresence>
          {activeScene && (
            <PiloSceneStage
              scene={activeScene}
              reduceMotion={Boolean(reduceMotion)}
              accessories={preferences.outfit === "auto" || preferences.outfit === "none" ? [] : preferences.outfits}
              actionPhase={presentationPhase}
              onDismiss={closeScene}
              onDisableTonight={() => {
                const dayKey = piloSceneDayKey(Date.now());
                writePiloValue(NIGHT_SCENE_OFF_KEY, dayKey, user?.id);
                setNightSceneOffDayKey(dayKey);
                closeScene();
              }}
              onAction={() => {
                const scene = activeScene;
                closeScene();
                if (scene.id === "movement") {
                  if (scene.movementVariant === "walk") {
                    const bounds = getViewportBounds();
                    movePilo({
                      x: clamp(piloX.get() + (piloX.get() > bounds.minX * .5 ? -72 : 72), 0, bounds.minX),
                      y: clamp(piloY.get() - 18, 0, bounds.minY),
                    });
                  } else {
                    signalPiloState("stretching", {
                      source: "companion:scene-action",
                      layer: "interaction",
                      reason: "你接受了 Pilo 的活动邀请",
                      duration: 3_800,
                      accessory: "headband",
                    });
                  }
                } else if (scene.id === "focus") {
                  learnFromInteraction("opened");
                  setOpen(true);
                }
              }}
              onOpenCompanion={() => {
                closeScene();
                settlePiloInPlace();
                learnFromInteraction("opened");
                burst();
                setOpen(true);
              }}
              onOpenSettings={(clientX, clientY) => openContextMenu(clientX, clientY, "functions")}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {hint && !open && (
            <motion.aside
              className={`pilo-companion__hint ${reminderMessage ? "is-activity-reminder" : ""}`}
              aria-live="polite"
              initial={{ opacity: 0, x: reduceMotion ? 0 : 10, scale: reduceMotion ? 1 : .96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: reduceMotion ? 0 : 8 }}
            >
              <button
                type="button"
                className="pilo-companion__hint-main"
                onClick={() => {
                  setHint(false);
                  if (reminderMessage) {
                    scheduler.release(reminderSourceRef.current);
                    setReminderMessage(null);
                    return;
                  }
                  if (feedbackMessage) {
                    setFeedbackMessage(null);
                    return;
                  }
                  hintWasOpenedRef.current = true;
                  learnFromInteraction("opened");
                  if (activeSuggestion?.level === "introduction") {
                    learnFromSuggestion(activeSuggestion, "accepted");
                    setActiveSuggestion(null);
                  }
                  settlePiloInPlace();
                  burst();
                  setOpen(true);
                }}
              >
                {reminderMessage ? <>
                  <span className="pilo-companion__hint-source"><Activity size={12} aria-hidden="true" /><small>Pilo 提醒</small></span>
                  <span>{reminderMessage}</span>
                </> : feedbackMessage ? <>
                  <span className="pilo-companion__hint-source"><Check size={12} aria-hidden="true" /><small>Pilo 回应</small></span>
                  <span>{feedbackMessage}</span>
                </> : activeSuggestion ? <>
                  <span className="pilo-companion__hint-source"><Sparkles size={12} aria-hidden="true" /><small>Pilo 建议</small></span>
                  <span>{activeSuggestion.message}</span><strong>{activeSuggestion.actionLabel}<ArrowRight size={12} /></strong>
                </> : null}
              </button>
              {activeSuggestion && (
                <button
                  type="button"
                  className="pilo-companion__hint-dismiss"
                  aria-label="关闭这条 Pilo 提示"
                  onClick={() => resolveSuggestion("dismissed")}
                ><X size={14} strokeWidth={2.3} /></button>
              )}
            </motion.aside>
          )}
        </AnimatePresence>

        <motion.button
          ref={petButtonRef}
          type="button"
          className={`pilo-companion__pet is-hover-stage-${hoverStage}`}
          onPointerEnter={(event) => beginHover(event.pointerType)}
          onPointerLeave={() => endHover()}
          onClick={() => {
            if (draggingRef.current || movedDuringPointerRef.current) {
              movedDuringPointerRef.current = false;
              return;
            }
            learnFromInteraction("opened");
            setHint(false);
            setContextMenu(null);
            if (open) {
              closeCompanionPanel();
              return;
            }
            if (activeSuggestion?.level === "introduction") {
              learnFromSuggestion(activeSuggestion, "accepted");
              setActiveSuggestion(null);
            }
            settlePiloInPlace();
            burst();
            setOpen(true);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            endHover(false);
            openContextMenu(event.clientX, event.clientY, "overview");
          }}
          onKeyDown={(event) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              openContextMenu(rect.left, rect.top, "overview");
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            movedDuringPointerRef.current = false;
            pointerStartRef.current = { x: event.clientX, y: event.clientY };
            dragControls.start(event.nativeEvent);
            if (event.pointerType === "touch") {
              longPressRef.current = window.setTimeout(() => {
                draggingRef.current = true;
                openContextMenu(event.clientX, event.clientY, "overview");
                window.setTimeout(() => { draggingRef.current = false; }, 120);
              }, 620);
            }
          }}
          onPointerMove={(event) => {
            if (!pointerStartRef.current) return;
            if (Math.hypot(event.clientX - pointerStartRef.current.x, event.clientY - pointerStartRef.current.y) > 8) {
              movedDuringPointerRef.current = true;
              clearLongPress();
            }
          }}
          onPointerUp={clearLongPress}
          onPointerCancel={() => {
            movedDuringPointerRef.current = false;
            clearLongPress();
          }}
          aria-expanded={open}
          aria-label={open ? "收起 Pilo 学习伙伴" : "打开 Pilo 学习伙伴；可拖动，右键或长按查看更多"}
        >
          <PiloAvatar
            mood={contextMenu ? "idle" : avatarMood}
            accessory={activeAccessory}
            accessories={isDragging ? [] : manualOutfits}
            size={104}
            priority
            illuminated={hoverStage > 0 || open || Boolean(contextMenu)}
            frameOverride={isDragging ? 0 : undefined}
            instant={isDragging}
            lifeAction={isDragging || activeScene ? undefined : presentation.lifeAction}
            actionPhase={activeScene ? "holding" : presentationPhase}
          />
          <span className="pilo-companion__online" aria-hidden="true" />
          <span className="pilo-companion__announcer" role="status" aria-live="polite" aria-atomic="true">
            {presentation.reason}. {accessoryReason}.
          </span>
          <span className="pilo-companion__hover-stars" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => <i key={index} />)}
          </span>
          {!open && !contextMenu && !hint && (
            <span className={`pilo-companion__drag-cue ${showFullHoverGuide ? "is-full" : "is-compact"}`} aria-hidden="true">
              {showFullHoverGuide ? (
                <><span><MessageCircle size={12} />点击对话</span><b /> <span><Move size={12} />拖动移动</span><b /> <span><MoreHorizontal size={12} />右键设置</span></>
              ) : (
                <>
                  <span data-tooltip="点击打开对话"><MessageCircle size={13} /></span>
                  <span data-tooltip="按住拖动位置"><Move size={13} /></span>
                  <span data-tooltip="右键打开设置"><MoreHorizontal size={13} /></span>
                </>
              )}
            </span>
          )}
        </motion.button>

        {preferences.particles && !reduceMotion && particleToken > 0 && (
          <span className="pilo-companion__particles" key={particleToken} aria-hidden="true">
            {Array.from({ length: 7 }, (_, index) => (
              <i
                key={index}
                style={{
                  "--particle-angle": `${index * 51 + (index % 2) * 12}deg`,
                  "--particle-distance": `${34 + (index % 3) * 13}px`,
                  "--particle-delay": `${index * 34}ms`,
                } as React.CSSProperties}
              />
            ))}
          </span>
        )}
      </motion.aside>

      <AnimatePresence>
        {open && (
          <motion.section
            ref={companionPanelRef}
            className={`pilo-companion__panel ${panelHorizontalSide} ${panelVerticalSide}`}
            role="dialog"
            aria-label="Pilo 快捷陪伴"
            style={{
              top: panelAnchor?.y,
              right: "auto",
              bottom: "auto",
              left: panelAnchor?.x,
              visibility: panelAnchor ? "visible" : "hidden",
            }}
            initial={{ opacity: 0, x: reduceMotion ? 0 : panelHorizontalSide === "is-panel-left" ? -12 : 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduceMotion ? 0 : panelHorizontalSide === "is-panel-left" ? -8 : 8 }}
            transition={{ duration: reduceMotion ? 0 : .22, ease: [0.22, 1, 0.36, 1] }}
          >
            <header>
              <span><Sparkles size={13} /> Pilo 正陪着你</span>
              <div>
                <button
                  type="button"
                  onClick={(event) => openContextMenu(event.clientX, event.clientY, "overview")}
                  aria-label="打开 Pilo 更多设置"
                ><MoreHorizontal size={16} /></button>
                <button type="button" onClick={closeCompanionPanel} aria-label="收起 Pilo"><X size={15} /></button>
              </div>
            </header>
            <h2>{copy.title}</h2>
            <p>{copy.description}</p>
            {preferences.features.stateExplanations && <>
              <button
                type="button"
                className="pilo-companion__reason-toggle"
                aria-expanded={panelReasonOpen}
                aria-controls="pilo-panel-state-reason"
                onClick={() => setPanelReasonOpen((current) => !current)}
              >
                <Info size={14} /> 为什么 Pilo 现在这样？
              </button>
              <AnimatePresence initial={false}>
                {panelReasonOpen && (
                <motion.div
                  id="pilo-panel-state-reason"
                  className="pilo-companion__panel-reason"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <strong>{PILO_LAYER_LABEL[presentation.layer]}</strong>
                  <p>{presentation.reason}</p>
                  {activeAccessory !== "none" && <small>{PILO_ACCESSORY_LABELS[activeAccessory]}：{accessoryReason}</small>}
                </motion.div>
                )}
              </AnimatePresence>
            </>}
            {activeSuggestion?.level === "nudge" && (
              <section className="pilo-companion__suggestion" aria-labelledby="pilo-current-suggestion">
                <span className={`pilo-companion__suggestion-kicker is-${activeSuggestion.category}`}>
                  {activeSuggestion.category === "capability" ? <Info size={13} /> : activeSuggestion.category === "observation" ? <Sparkles size={13} /> : <ArrowRight size={13} />}
                  {activeSuggestion.category === "capability" ? "页面能力" : activeSuggestion.category === "observation" ? "行为观察" : "行动建议"}
                </span>
                <h3 id="pilo-current-suggestion">{activeSuggestion.message}</h3>
                <p><Info size={13} />{activeSuggestion.evidence}</p>
                <Link
                  href={buildPiloCoachHref({
                    ...coachEntryContext,
                    intent: activeSuggestion.kind,
                    suggestionId: activeSuggestion.id,
                    observationTitle: activeSuggestion.category === "observation" ? activeSuggestion.message : undefined,
                    reason: activeSuggestion.evidence,
                    actionLabel: activeSuggestion.actionLabel,
                    prompt: activeSuggestion.prompt ?? activeSuggestion.message,
                    entryMode: activeSuggestion.category === "observation" ? "observation" : "object",
                  })}
                  className="pilo-companion__suggestion-primary"
                  onClick={(event) => {
                    resolveSuggestion("accepted");
                    enterCoachFromLink(event);
                  }}
                >
                  <span>{activeSuggestion.actionLabel}</span><ArrowRight size={14} />
                </Link>
                <div className="pilo-companion__suggestion-secondary" aria-label="处理这条建议">
                  <button type="button" onClick={() => resolveSuggestion("dismissed")}>先不用</button>
                  <button type="button" onClick={() => resolveSuggestion("snoozed")}>稍后提醒</button>
                  <button type="button" onClick={reduceSuggestionFrequency}>少提醒这类</button>
                </div>
              </section>
            )}
            <div className="pilo-companion__actions">
              {copy.entries.map((action) => (
                <Link
                  href={buildPiloCoachHref({
                    ...coachEntryContext,
                    ...action,
                    entryMode: action.intent === "explain-learning-judgment" ? "observation" : "object",
                  })}
                  key={action.intent}
                  onClick={enterCoachFromLink}
                >
                  <span>{action.actionLabel}</span><ArrowRight size={14} />
                </Link>
              ))}
            </div>
            <Link className="pilo-companion__chat" href="/studio/coach" onClick={enterCoachFromLink}>
              <MessageCircle size={15} /> 打开完整对话
            </Link>
            <small className="pilo-companion__tip"><Move size={12} /> 可以拖动 Pilo，右键或长按查看更多</small>
          </motion.section>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {contextMenu && (
          <>
            <motion.button
              type="button"
              className="pilo-companion__context-scrim"
              aria-label="关闭 Pilo 菜单"
              onClick={() => {
                setContextMenu(null);
                window.requestAnimationFrame(() => petButtonRef.current?.focus());
              }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            />
            <motion.section
              ref={contextMenuRef}
              className="pilo-companion__context"
              role="dialog"
              aria-modal="true"
              aria-label="Pilo 设置"
              style={{
                "--pilo-context-left": `${contextMenu.x}px`,
                "--pilo-context-top": `${contextMenu.y}px`,
              } as React.CSSProperties}
              initial={{ opacity: 0, y: reduceMotion ? 0 : 7, scale: reduceMotion ? 1 : .97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : 5, scale: reduceMotion ? 1 : .98 }}
              transition={{ duration: reduceMotion ? 0 : .18, ease: "easeOut" }}
            >
              <header>
                <PiloAvatar
                  mood={focusTimerOpen ? "checking" : "listening"}
                  size={42}
                  lifeAction={focusTimerOpen ? "check-timer" : undefined}
                />
                <span><strong>Pilo v3.2</strong><small>陪伴方式、外观与能力</small></span>
                <button type="button" onClick={() => { setContextMenu(null); window.requestAnimationFrame(() => petButtonRef.current?.focus()); }} aria-label="关闭 Pilo 设置"><X size={15} /></button>
              </header>

              <nav className="pilo-companion__settings-tabs" aria-label="Pilo 设置分类" role="tablist">
                <button id="pilo-settings-tab-overview" type="button" role="tab" tabIndex={settingsTab === "overview" ? 0 : -1} aria-selected={settingsTab === "overview"} aria-controls="pilo-settings-panel-overview" className={settingsTab === "overview" ? "is-active" : ""} onClick={() => setSettingsTab("overview")} onKeyDown={(event) => moveSettingsTab(event, "overview")}><ShieldCheck size={16} />概览</button>
                <button id="pilo-settings-tab-scenes" type="button" role="tab" tabIndex={settingsTab === "scenes" ? 0 : -1} aria-selected={settingsTab === "scenes"} aria-controls="pilo-settings-panel-scenes" className={settingsTab === "scenes" ? "is-active" : ""} onClick={() => setSettingsTab("scenes")} onKeyDown={(event) => moveSettingsTab(event, "scenes")}><Sparkles size={16} />场景</button>
                <button id="pilo-settings-tab-functions" type="button" role="tab" tabIndex={settingsTab === "functions" ? 0 : -1} aria-selected={settingsTab === "functions"} aria-controls="pilo-settings-panel-functions" className={settingsTab === "functions" ? "is-active" : ""} onClick={() => setSettingsTab("functions")} onKeyDown={(event) => moveSettingsTab(event, "functions")}><Settings2 size={16} />功能</button>
              </nav>

              {settingsTab === "overview" && (
                <div id="pilo-settings-panel-overview" role="tabpanel" aria-labelledby="pilo-settings-tab-overview" className="pilo-companion__settings-page">
                  <nav className="pilo-companion__context-quick" aria-label="Pilo 快捷操作">
                    <Link href="/studio/coach" onClick={enterCoachFromLink}><MessageCircle size={16} /><span><strong>学习对话</strong><small>继续和 Pilo 聊聊</small></span><ArrowRight size={13} /></Link>
                    <button
                      type="button"
                      className={focusTimer.status === "running" ? "is-running" : ""}
                      aria-expanded={focusTimerOpen}
                      aria-controls="pilo-focus-timer"
                      onClick={() => setFocusTimerOpen((current) => !current)}
                    >
                      <Focus size={16} />
                      <span>
                        <strong>{focusTimer.status === "running" ? formatFocusTime(focusTimer.remainingSeconds) : "专注计时"}</strong>
                        <small>{focusTimer.status === "paused" ? "已暂停，随时继续" : focusTimer.status === "running" ? `${focusTimer.durationMinutes} 分钟专注中` : "选择时长后开始"}</small>
                      </span>
                      <ChevronDown size={13} />
                    </button>
                  </nav>

                  {focusTimerOpen && (
                    <section id="pilo-focus-timer" className={`pilo-companion__focus-timer is-${focusTimer.status}`} aria-label="专注计时器">
                      <header>
                        <span><Clock3 size={14} /><strong>{focusTimer.status === "idle" ? "选择专注时长" : "本轮专注"}</strong></span>
                        <small>{focusTimer.status === "running" ? "Pilo 正在安静陪伴" : focusTimer.status === "paused" ? "倒计时已暂停" : "可随时暂停或结束"}</small>
                      </header>
                      <div className="pilo-companion__focus-duration" role="radiogroup" aria-label="选择专注时长">
                        {FOCUS_DURATION_OPTIONS.map((minutes) => (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={focusTimer.durationMinutes === minutes}
                            disabled={focusTimer.status === "running"}
                            className={focusTimer.durationMinutes === minutes ? "is-active" : ""}
                            onClick={() => selectFocusDuration(minutes)}
                            key={minutes}
                          ><strong>{minutes}</strong><small>分钟</small></button>
                        ))}
                      </div>
                      {focusTimer.status !== "idle" && (
                        <div className="pilo-companion__focus-clock" aria-live="polite">
                          <strong>{formatFocusTime(focusTimer.remainingSeconds)}</strong>
                          <small>{focusTimer.status === "running" ? "专注进行中" : "暂停中"}</small>
                        </div>
                      )}
                      <div className="pilo-companion__focus-actions">
                        {focusTimer.status === "running" ? (
                          <button type="button" className="is-primary" onClick={pauseFocusTimer}><Pause size={14} />暂停</button>
                        ) : (
                          <button type="button" className="is-primary" onClick={startFocusTimer}><Play size={15} />{focusTimer.status === "paused" ? "继续本轮专注" : `开始 ${focusTimer.durationMinutes} 分钟专注`}<ArrowRight size={14} /></button>
                        )}
                        {focusTimer.status !== "idle" && <button type="button" onClick={stopFocusTimer}><Square size={12} />结束本轮</button>}
                      </div>
                    </section>
                  )}

                  <section className={`pilo-companion__version-flow pilo-companion__overview-section ${expandedSections.overview ? "is-expanded" : "is-collapsed"}`} aria-label="当前设置摘要">
                    <header>
                      <span><BrainCircuit size={14} /><strong>快捷陪伴方案</strong></span>
                      <span className="pilo-companion__overview-heading-meta"><small>{currentModeLabel} · 可继续微调</small><button type="button" className="pilo-companion__collapse-toggle" aria-expanded={expandedSections.overview} aria-controls="pilo-settings-overview" aria-label={`${expandedSections.overview ? "收起" : "展开"}快捷陪伴方案`} onClick={() => toggleSettingsSection("overview")}><ChevronDown size={16} /></button></span>
                    </header>
                    {expandedSections.overview && <div id="pilo-settings-overview" className="pilo-companion__version-content">
                    <p className="pilo-companion__preset-note">一键应用一组陪伴设置；之后可在“功能”中分别调整，不会互相覆盖。</p>
                    <div className="pilo-companion__mode-grid" role="radiogroup" aria-label="选择 Pilo 快捷陪伴方案">
                      {MODE_OPTIONS.map((mode) => (
                        <button type="button" role="radio" aria-checked={preferences.mode === mode.id} className={preferences.mode === mode.id ? "is-active" : ""} onClick={() => applyMode(mode.id)} key={mode.id}>
                          <span><strong>{mode.label}</strong>{preferences.mode === mode.id && <Check size={12} />}</span>
                          <small>{mode.description}</small>
                        </button>
                      ))}
                    </div>
                    <div className="pilo-companion__version-summary">
                      <span><b>活动范围</b><strong>{ACTIVITY_LABELS[preferences.activity]}</strong></span>
                      <span><b>建议主动性</b><strong>{preferences.suggestionInitiative === "quiet" ? "安静观察" : preferences.suggestionInitiative === "present" ? "积极提醒" : "适时提醒"}</strong></span>
                      <span><b>场景频率</b><strong>{preferences.sceneFrequency === "quiet" ? "不主动" : preferences.sceneFrequency === "present" ? "多次出现" : "适时出现"}</strong></span>
                    </div>
                    {preferences.features.stateExplanations && <button type="button" className="pilo-companion__state-explanation-toggle" aria-expanded={settingsReasonOpen} aria-controls="pilo-settings-state-explanation" onClick={() => setSettingsReasonOpen((current) => !current)}>状态说明<ChevronDown size={12} /></button>}
                    {preferences.features.stateExplanations && settingsReasonOpen && (
                      <aside id="pilo-settings-state-explanation" className="pilo-companion__version-reason" aria-live="polite">
                        <Info size={13} />
                        <p><strong>Pilo 正在{PILO_STATE_COPY[presentation.state]}</strong>{settingsStateReason}</p>
                        {activeAccessory !== "none" && <small>{PILO_ACCESSORY_LABELS[activeAccessory]} · {accessoryReason}</small>}
                      </aside>
                    )}
                    </div>}
                  </section>

                  <section className={`pilo-companion__today-presence pilo-companion__overview-section ${expandedSections.presence ? "is-expanded" : "is-collapsed"}`} aria-label="今天 Pilo 为什么出现">
                    <button type="button" className="pilo-companion__timeline-toggle" aria-expanded={expandedSections.presence} aria-controls="pilo-today-presence-list" aria-label={`${expandedSections.presence ? "收起" : "展开"}今天 Pilo 出现了什么`} onClick={() => toggleSettingsSection("presence")}>
                      <span><strong>今天 Pilo 出现了什么</strong></span>
                      <span><small>{presenceSummary.total ? `${presenceSummary.total} 条今日记录` : "今天还没有记录"}</small><ChevronDown className={expandedSections.presence ? "is-expanded" : ""} size={16} /></span>
                    </button>
                    {expandedSections.presence && (presenceSummary.recent.length ? (
                      <ol id="pilo-today-presence-list">
                        {presenceSummary.recent.map((entry) => (
                          <li key={`${entry.id}-${entry.at}`}>
                            <time>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>
                            <span>
                              <span className="pilo-companion__presence-title"><strong>{entry.title}</strong><em>{PILO_PRESENCE_KIND_COPY[entry.kind]}</em></span>
                              <small>{entry.reason}</small>
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : <p id="pilo-today-presence-list">今天还没有触发陪伴场景、学习建议或关键状态回应。</p>)}
                  </section>
                </div>
              )}

              {settingsTab === "scenes" && (
                <div id="pilo-settings-panel-scenes" role="tabpanel" aria-labelledby="pilo-settings-tab-scenes" className="pilo-companion__settings-page pilo-companion__scene-page">
                  <section className={`pilo-companion__appearance-intro ${expandedSections.lifeActions ? "is-expanded" : "is-collapsed"}`}>
                    <PersonStanding size={17} />
                    <span><strong>动作预览</strong><small>选择基础动作或道具动作，让 Pilo 做一次预览；不会改变自动规则。</small></span>
                    <button
                      type="button"
                      className="pilo-companion__collapse-toggle"
                      aria-expanded={expandedSections.lifeActions}
                      aria-controls="pilo-life-action-options"
                      aria-label={`${expandedSections.lifeActions ? "收起" : "展开"}动作预览`}
                      onClick={() => toggleSettingsSection("lifeActions")}
                    >
                      <ChevronDown size={16} />
                    </button>
                  </section>
                  {expandedSections.lifeActions && (
                    <div className="pilo-companion__life-action-options">
                      <div className="pilo-companion__life-action-tabs" role="tablist" aria-label="选择动作类型">
                        <button
                          id="pilo-life-action-tab-basic"
                          type="button"
                          role="tab"
                          aria-selected={lifeActionTab === "basic"}
                          aria-controls="pilo-life-action-options-basic"
                          className={lifeActionTab === "basic" ? "is-active" : ""}
                          onClick={() => setLifeActionTab("basic")}
                        >基础动作</button>
                        <button
                          id="pilo-life-action-tab-props"
                          type="button"
                          role="tab"
                          aria-selected={lifeActionTab === "props"}
                          aria-controls="pilo-life-action-options-props"
                          className={lifeActionTab === "props" ? "is-active" : ""}
                          onClick={() => setLifeActionTab("props")}
                        >道具动作</button>
                      </div>
                      <div
                        id={`pilo-life-action-options-${lifeActionTab}`}
                        role="tabpanel"
                        aria-labelledby={`pilo-life-action-tab-${lifeActionTab}`}
                        className="pilo-companion__life-action-grid"
                        aria-label={`选择要预览的 Pilo ${lifeActionTab === "basic" ? "基础" : "道具"}动作`}
                      >
                        {(lifeActionTab === "basic" ? PILO_BASIC_LIFE_ACTION_OPTIONS : PILO_PROP_LIFE_ACTION_OPTIONS).map((action) => (
                          <button type="button" aria-label={`预览${action.label}动作`} onClick={() => previewLifeAction(action)} key={action.id}>
                            <span className="pilo-companion__life-action-preview" aria-hidden="true">
                              {lifeActionTab === "basic" ? (
                                <PiloAvatar
                                  size={58}
                                  mood={moodForSystemState(action.state)}
                                  accessory={action.accessory}
                                  lifeAction={action.id}
                                  actionPhase="holding"
                                  instant
                                />
                              ) : (
                                <span style={{ backgroundImage: `url(/pilo/life/${action.id}/04.png)` }} />
                              )}
                            </span>
                            <span><strong>{action.label}</strong><small>{action.trigger}</small></span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <section className={`pilo-companion__appearance-intro pilo-companion__scene-preview-heading ${expandedSections.scenePreviews ? "is-expanded" : "is-collapsed"}`}>
                    <Sparkles size={17} />
                    <span><strong>场景预览</strong><small>手动查看清晨、专注、用餐、活动与回顾场景；不会计入自动出现。</small></span>
                    <button
                      type="button"
                      className="pilo-companion__collapse-toggle"
                      aria-expanded={expandedSections.scenePreviews}
                      aria-controls="pilo-scene-preview-options"
                      aria-label={`${expandedSections.scenePreviews ? "收起" : "展开"}场景预览`}
                      onClick={() => toggleSettingsSection("scenePreviews")}
                    >
                      <ChevronDown size={16} />
                    </button>
                  </section>
                  {expandedSections.scenePreviews && (
                    <div id="pilo-scene-preview-options" className="pilo-companion__scene-preview-grid" aria-label="选择要预览的 Pilo 场景">
                      {PILO_SCENE_OPTIONS.map((scene) => (
                        <button
                          type="button"
                          onClick={() => {
                            setContextMenu(null);
                            window.setTimeout(() => {
                              scheduler.release("companion:interaction");
                              showScene(scene.id, { record: false });
                            }, 80);
                          }}
                          key={scene.id}
                        >
                          <span style={{ backgroundImage: `url(${scene.asset})` }} aria-hidden="true" />
                          <strong>{scene.label}</strong>
                          <small>{scene.description}</small>
                        </button>
                      ))}
                    </div>
                  )}

                  <section className={`pilo-companion__appearance-intro ${expandedSections.outfits ? "is-expanded" : "is-collapsed"}`}>
                    <Shirt size={17} />
                    <span><strong>装扮</strong><small>不同穿戴位置可以自由搭配；任务动作仍优先表达语义。</small></span>
                    <button
                      type="button"
                      className="pilo-companion__collapse-toggle"
                      aria-expanded={expandedSections.outfits}
                      aria-controls="pilo-outfit-options"
                      aria-label={`${expandedSections.outfits ? "收起" : "展开"}装扮选项`}
                      onClick={() => toggleSettingsSection("outfits")}
                    >
                      <ChevronDown size={16} />
                    </button>
                  </section>
                  {expandedSections.outfits && (
                    <div id="pilo-outfit-options" className="pilo-companion__outfit-grid" role="group" aria-label="选择 Pilo 装扮">
                      {OUTFIT_OPTIONS.map((outfit) => (
                        <button
                          type="button"
                          aria-pressed={outfit.id === "auto"
                            ? preferences.outfit === "auto"
                            : outfit.id === "none"
                              ? preferences.outfit === "none" || (preferences.outfit !== "auto" && preferences.outfits.length === 0)
                              : preferences.outfits.includes(outfit.id)}
                          className={(outfit.id === "auto" ? preferences.outfit === "auto" : outfit.id === "none" ? preferences.outfit === "none" || (preferences.outfit !== "auto" && preferences.outfits.length === 0) : preferences.outfits.includes(outfit.id)) ? "is-active" : ""}
                          onClick={() => selectOutfit(outfit)}
                          key={outfit.id}
                        >
                          <PiloAvatar mood={outfit.previewMood} accessory={outfit.previewAccessory} size={outfit.id === "auto" ? 54 : 50} />
                          <span>
                            <strong>{outfit.label}</strong>
                            <em>{outfit.id === "headband" || outfit.id === "earmuffs" || outfit.id === "laurel" ? "头部三选一" : outfit.id === "auto" || outfit.id === "none" ? "造型预设" : "可叠加"}</em>
                            <small>{outfit.description}</small>
                          </span>
                          {(outfit.id === "auto" ? preferences.outfit === "auto" : outfit.id === "none" ? preferences.outfit === "none" || (preferences.outfit !== "auto" && preferences.outfits.length === 0) : preferences.outfits.includes(outfit.id)) && <Check className="pilo-companion__outfit-check" size={14} />}
                        </button>
                      ))}
                    </div>
                  )}
                  <AnimatePresence initial={false}>
                    {appearanceConfirmation && (
                      <motion.p
                        className="pilo-companion__appearance-feedback"
                        role="status"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                      ><Check size={13} />{appearanceConfirmation}</motion.p>
                    )}
                  </AnimatePresence>
                  <p className="pilo-companion__settings-help">眼镜、围巾、腰包和护腕可同时搭配；运动头带、耳机与月桂花环占用同一头部位置，选择新款会立即替换。生活动作仍使用动作专属造型。</p>
                </div>
              )}

              {settingsTab === "functions" && (
                <div id="pilo-settings-panel-functions" role="tabpanel" aria-labelledby="pilo-settings-tab-functions" className="pilo-companion__settings-page">
                  <section className={`pilo-companion__settings-group ${expandedSections.activity ? "is-expanded" : "is-collapsed"}`}>
                    <header>
                      <span className="pilo-companion__group-title"><Move size={14} /><span><strong>活动与出现</strong><small>控制 Pilo 在页面中的存在感</small></span></span>
                      <button type="button" className="pilo-companion__collapse-toggle" aria-expanded={expandedSections.activity} aria-controls="pilo-settings-activity" aria-label={`${expandedSections.activity ? "收起" : "展开"}活动与出现`} onClick={() => toggleSettingsSection("activity")}><ChevronDown size={16} /></button>
                    </header>
                    {expandedSections.activity && (
                      <div id="pilo-settings-activity" className="pilo-companion__group-content">
                        <div className="pilo-companion__segmented-field">
                          <span><strong>活动范围</strong><small>拖动后会记住当前位置</small></span>
                          <div className="pilo-companion__activity-segments" role="radiogroup" aria-label="选择 Pilo 活动范围">
                            {(["docked", "gentle", "active"] as ActivityMode[]).map((activity) => (
                              <button type="button" role="radio" aria-checked={preferences.activity === activity} className={preferences.activity === activity ? "is-active" : ""} onClick={() => setActivity(activity)} key={activity}>
                                <span>{ACTIVITY_LABELS[activity]}</span>{preferences.activity === activity && <Check size={11} />}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="pilo-companion__segmented-field">
                          <span><strong>建议主动程度</strong><small>仅控制学习建议；每类建议仍会根据接受、稍后与忽略继续调整</small></span>
                          <div className="pilo-companion__activity-segments" role="radiogroup" aria-label="选择 Pilo 建议主动程度">
                            {(["quiet", "balanced", "present"] as const).map((initiative) => (
                              <button
                                type="button"
                                role="radio"
                                aria-checked={preferences.suggestionInitiative === initiative}
                                className={preferences.suggestionInitiative === initiative ? "is-active" : ""}
                                onClick={() => savePreferences({ ...preferences, mode: "custom", suggestionInitiative: initiative })}
                                key={initiative}
                              >
                                <span>{{ quiet: "安静观察", balanced: "适时提醒", present: "积极提醒" }[initiative]}</span>
                                {preferences.suggestionInitiative === initiative && <Check size={11} />}
                              </button>
                            ))}
                          </div>
                          <p className="pilo-companion__learning-note">
                            已记录 {Object.values(learnedPreferences.suggestions).reduce((total, entry) => total + (entry?.accepted ?? 0), 0)} 次采用、{Object.values(learnedPreferences.suggestions).reduce((total, entry) => total + (entry?.ignored ?? 0) + (entry?.dismissed ?? 0), 0)} 次暂不需要
                            <button type="button" onClick={() => saveLearnedPreferences(DEFAULT_LEARNED_PREFERENCES)}>重置</button>
                          </p>
                        </div>
                      </div>
                    )}
                  </section>

                  <section className={`pilo-companion__settings-group ${expandedSections.automatic ? "is-expanded" : "is-collapsed"}`}>
                    <header>
                      <span className="pilo-companion__group-title"><Sparkles size={14} /><span><strong>自动陪伴</strong><small>决定 Pilo 何时主动响应</small></span></span>
                      <button type="button" className="pilo-companion__collapse-toggle" aria-expanded={expandedSections.automatic} aria-controls="pilo-settings-automatic" aria-label={`${expandedSections.automatic ? "收起" : "展开"}自动陪伴`} onClick={() => toggleSettingsSection("automatic")}><ChevronDown size={16} /></button>
                    </header>
                    {expandedSections.automatic && (
                      <div id="pilo-settings-automatic" className="pilo-companion__settings-list pilo-companion__group-content">
                        <PiloSettingSwitch icon={Activity} label="自动生活动作" description="允许 Pilo 根据学习节律低频坐下、行走、茶歇或收尾" checked={preferences.features.lifestyleStates} onToggle={() => toggleFeature("lifestyleStates")} />
                        <PiloSettingSwitch icon={BookOpen} label="情境陪伴" description="理解你正在阅读、记录、复习还是推进目标，并调整 Pilo 的状态" checked={preferences.features.contextAwareness} onToggle={() => toggleFeature("contextAwareness")} />
                        <PiloSettingSwitch icon={MessageCircle} label="适时建议" description="只在发现明确下一步时轻声提醒；不会在输入和专注时打断" checked={preferences.features.proactiveHints} onToggle={() => toggleFeature("proactiveHints")} />
                        <PiloSettingSwitch icon={TimerReset} label="久坐提醒" description="连续使用约 60 分钟后提醒活动" checked={preferences.features.stretchReminders} onToggle={() => toggleFeature("stretchReminders")} />
                      </div>
                    )}
                  </section>

                  <section className={`pilo-companion__settings-group ${expandedSections.scenes ? "is-expanded" : "is-collapsed"}`}>
                    <header>
                      <span className="pilo-companion__group-title"><SunMoon size={14} /><span><strong>场景自动化</strong><small>按时间与真实进度轻声出现</small></span></span>
                      <button type="button" className="pilo-companion__collapse-toggle" aria-expanded={expandedSections.scenes} aria-controls="pilo-settings-scenes" aria-label={`${expandedSections.scenes ? "收起" : "展开"}场景自动化`} onClick={() => toggleSettingsSection("scenes")}><ChevronDown size={16} /></button>
                    </header>
                    {expandedSections.scenes && (
                      <div id="pilo-settings-scenes" className="pilo-companion__settings-list pilo-companion__group-content">
                        <PiloSettingSwitch icon={Sparkles} label="一日陪伴场景" description="7 个场景按时间、学习阶段和节律出现；不是固定贴图" checked={preferences.features.dailyScenes} onToggle={() => {
                          toggleFeature("dailyScenes");
                          if (preferences.features.dailyScenes) closeScene();
                        }} />
                        {preferences.features.dailyScenes && (
                          <>
                            <PiloSettingSwitch icon={SunMedium} label="早晨问候" description="06:30–09:30 在合适时机一起开始今天" checked={preferences.features.morningScenes} onToggle={() => toggleFeature("morningScenes")} />
                            <PiloSettingSwitch icon={Laptop} label="工作陪伴" description="任务或专注进入稳定阶段后，在桌前安静陪伴" checked={preferences.features.focusScenes} onToggle={() => toggleFeature("focusScenes")} />
                            <PiloSettingSwitch icon={Utensils} label="用餐场景" description="在午餐和晚餐时间窗口各轻声提醒一次" checked={preferences.features.mealScenes} onToggle={() => toggleFeature("mealScenes")} />
                            <PiloSettingSwitch icon={Activity} label="运动与休息" description="连续投入 45 分钟后，邀请你走动、伸展或轻运动" checked={preferences.features.movementScenes} onToggle={() => toggleFeature("movementScenes")} />
                            <PiloSettingSwitch icon={BookOpen} label="晚间回顾" description="仅在今天有真实完成记录时邀请你轻量回顾" checked={preferences.features.reviewScenes} onToggle={() => toggleFeature("reviewScenes")} />
                            <PiloSettingSwitch icon={Moon} label="夜间作息" description="仅在你设置的睡眠时间附近提醒一次" checked={preferences.features.nightCare} onToggle={() => toggleFeature("nightCare")} />
                            {preferences.features.nightCare && (
                              <div className="pilo-companion__scene-time-field">
                                <label htmlFor="pilo-bedtime"><span><strong>睡眠提醒时间</strong><small>修改时间会重新计算下一次夜间窗口</small></span></label>
                                <div>
                                  <input
                                    id="pilo-bedtime"
                                    type="time"
                                    aria-label="Pilo 睡眠提醒时间"
                                    disabled={!preferences.bedtime.enabled}
                                    value={`${String(preferences.bedtime.hour).padStart(2, "0")}:${String(preferences.bedtime.minute).padStart(2, "0")}`}
                                    onChange={(event) => {
                                      const [hour, minute] = event.target.value.split(":").map(Number);
                                      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
                                      savePreferences({ ...preferences, mode: "custom", bedtime: { ...preferences.bedtime, hour, minute } });
                                    }}
                                  />
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={preferences.bedtime.enabled}
                                    onClick={() => savePreferences({ ...preferences, mode: "custom", bedtime: { ...preferences.bedtime, enabled: !preferences.bedtime.enabled } })}
                                  >{preferences.bedtime.enabled ? "已启用" : "启用提醒"}</button>
                                </div>
                              </div>
                            )}
                            <PiloSettingSwitch icon={BrainCircuit} label="结合我的计划" description="只使用真实用户名、计划数量和当前内容生成场景文案" checked={preferences.features.personalizedSceneCopy} onToggle={() => toggleFeature("personalizedSceneCopy")} />
                            <div className="pilo-companion__segmented-field pilo-companion__scene-frequency">
                              <span><strong>主动场景频率</strong><small>安静模式不主动；其余模式没有总次数上限，但同一场景当天至多出现一次，场景之间至少间隔 60–90 分钟</small></span>
                              <div className="pilo-companion__activity-segments" role="radiogroup" aria-label="选择 Pilo 主动场景频率">
                                {(["quiet", "balanced", "present"] as const).map((initiative) => (
                                  <button
                                    type="button"
                                    role="radio"
                                    aria-checked={preferences.sceneFrequency === initiative}
                                    aria-label={{ quiet: "不主动，关闭主动场景", balanced: "适时出现，场景间隔约 90 分钟", present: "多次出现，场景间隔约 60 分钟" }[initiative]}
                                    className={preferences.sceneFrequency === initiative ? "is-active" : ""}
                                    onClick={() => savePreferences({ ...preferences, mode: "custom", sceneFrequency: initiative })}
                                    key={initiative}
                                  >
                                    <span>{{ quiet: "不主动", balanced: "适时出现", present: "多次出现" }[initiative]}</span>
                                    <small>{{ quiet: "关闭主动场景", balanced: "约 90 分钟间隔", present: "约 60 分钟间隔" }[initiative]}</small>
                                    {preferences.sceneFrequency === initiative && <Check size={11} />}
                                  </button>
                                ))}
                              </div>
                              <p className="pilo-companion__learning-note">场景会遵守时间窗口、当前学习阶段和最近一次出现的冷却；同一场景当天不会重复刷屏。</p>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </section>

                  <section className={`pilo-companion__settings-group ${expandedSections.rhythm ? "is-expanded" : "is-collapsed"}`}>
                    <header>
                      <span className="pilo-companion__group-title"><Settings2 size={14} /><span><strong>体验与节奏</strong><small>调整视觉反馈和个性化程度</small></span></span>
                      <button type="button" className="pilo-companion__collapse-toggle" aria-expanded={expandedSections.rhythm} aria-controls="pilo-settings-rhythm" aria-label={`${expandedSections.rhythm ? "收起" : "展开"}体验与节奏`} onClick={() => toggleSettingsSection("rhythm")}><ChevronDown size={16} /></button>
                    </header>
                    {expandedSections.rhythm && (
                      <div id="pilo-settings-rhythm" className="pilo-companion__group-content">
                        <div className="pilo-companion__settings-list">
                          <PiloSettingSwitch icon={Sparkles} label="星光效果" description="显示悬浮星点与完成反馈" checked={preferences.particles} onToggle={() => savePreferences({ ...preferences, particles: !preferences.particles })} />
                          <PiloSettingSwitch icon={BrainCircuit} label="自适应节奏" description="分别学习你对整理、复习和计划建议的偏好" checked={preferences.features.adaptiveTiming} onToggle={() => toggleFeature("adaptiveTiming")} />
                          <PiloSettingSwitch icon={Info} label="判断依据" description="用自然语言说明 Pilo 为什么在此刻出现" checked={preferences.features.stateExplanations} onToggle={() => toggleFeature("stateExplanations")} />
                          <PiloSettingSwitch icon={Clock3} label="安静时段" description="每天 22:00–08:00 不主动打扰" checked={preferences.quietHours.enabled} onToggle={() => savePreferences({ ...preferences, quietHours: { ...preferences.quietHours, enabled: !preferences.quietHours.enabled } })} />
                        </div>
                        <div className="pilo-companion__quiet-actions">
                          <span><Pause size={14} /><strong>{remindersPaused ? "主动提醒已暂停" : "临时暂停主动提醒"}</strong></span>
                          <div><button type="button" onClick={() => pauseReminders(60 * 60 * 1000)}>1 小时</button><button type="button" onClick={() => pauseReminders(24 * 60 * 60 * 1000)}>今天</button></div>
                        </div>
                      </div>
                    )}
                  </section>

              {debugAvailable && (
                <section className="pilo-companion__debug">
                  <button type="button" className="pilo-companion__timeline-toggle" aria-expanded={debugOpen} onClick={() => setDebugOpen((current) => !current)}>
                    <span><strong>状态时间线</strong></span><span><small>调度种子 {schedule.seed}</small><ChevronDown className={debugOpen ? "is-expanded" : ""} size={16} /></span>
                  </button>
                  {debugOpen && (
                    <div data-testid="pilo-debug-timeline">
                      <nav aria-label="Pilo 调试状态">
                        {(["thinking", "working", "checking", "success", "failure", "reading", "stretching"] as PiloSystemState[]).map((state) => (
                          <button
                            type="button"
                            data-testid={`pilo-debug-${state}`}
                            onClick={() => scheduler.request({
                              state,
                              layer: "interaction",
                              source: "debug:manual",
                              reason: `固定种子验收：${state}`,
                              duration: 2_400,
                              accessory: state === "reading" || state === "checking" || state === "working" ? "glasses" : state === "stretching" ? "headband" : "none",
                            })}
                            key={state}
                          >{PILO_STATE_COPY[state]}</button>
                        ))}
                      </nav>
                      <nav aria-label="Pilo 调试场景">
                        {PILO_SCENE_IDS.map((scene) => (
                          <button
                            type="button"
                            data-testid={`pilo-debug-scene-${scene}`}
                            onClick={() => {
                              setContextMenu(null);
                              window.setTimeout(() => {
                                scheduler.release("companion:interaction");
                                showScene(scene, { record: false });
                              }, 80);
                            }}
                            key={scene}
                          >{PILO_SCENE_OPTIONS.find((item) => item.id === scene)?.label ?? scene}</button>
                        ))}
                      </nav>
                      <ol>
                        {schedule.timeline.slice(-8).reverse().map((entry) => (
                          <li key={entry.id}><time>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}</time><span>{PILO_TIMELINE_ACTION_COPY[entry.action]} · {PILO_STATE_COPY[entry.state]}</span><small>{entry.reason}</small></li>
                        ))}
                      </ol>
                    </div>
                  )}
                </section>
              )}
                </div>
              )}
            </motion.section>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
