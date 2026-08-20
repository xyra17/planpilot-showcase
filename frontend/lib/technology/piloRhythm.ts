import type { ScheduledPiloState } from "@/lib/technology/piloScheduler";
import type { PiloAccessory, PiloLifeActionId, PiloStateLayer, PiloSystemState } from "@/lib/technology/piloState";

export type PiloActionPhase = "entering" | "holding" | "leaving";
export type PiloActionContinuity = "interruptible" | "resumable" | "finish-first";
export type PiloLifeActionReadiness = "loop-ready" | "complete" | "needs-asset";
export type PiloCompanionMode = "quiet" | "balanced" | "focus" | "coach";

export const PILO_ACTION_PHASE_DURATION_MS: Record<PiloActionPhase, number> = {
  entering: 470,
  holding: 0,
  leaving: 410,
};

export type PiloModePolicy = {
  allowGreeting: boolean;
  allowSuggestions: boolean;
  allowScenes: boolean;
  allowAmbientLife: boolean;
  allowAutoMove: boolean;
  allowStretchReminder: boolean;
};

export const PILO_MODE_POLICIES: Record<PiloCompanionMode, PiloModePolicy> = {
  quiet: {
    allowGreeting: false,
    allowSuggestions: false,
    allowScenes: false,
    allowAmbientLife: false,
    allowAutoMove: false,
    allowStretchReminder: false,
  },
  balanced: {
    allowGreeting: true,
    allowSuggestions: true,
    allowScenes: true,
    allowAmbientLife: true,
    allowAutoMove: true,
    allowStretchReminder: true,
  },
  focus: {
    allowGreeting: false,
    allowSuggestions: false,
    allowScenes: false,
    allowAmbientLife: false,
    allowAutoMove: false,
    allowStretchReminder: true,
  },
  coach: {
    allowGreeting: true,
    allowSuggestions: true,
    allowScenes: true,
    allowAmbientLife: true,
    allowAutoMove: true,
    allowStretchReminder: true,
  },
};

export function piloModePolicy(mode: PiloCompanionMode, custom?: Partial<PiloModePolicy>): PiloModePolicy {
  return mode === "balanced" && custom ? { ...PILO_MODE_POLICIES.balanced, ...custom } : PILO_MODE_POLICIES[mode];
}

export type PiloLifeActionDefinition = {
  id: PiloLifeActionId;
  label: string;
  trigger: string;
  state: PiloSystemState;
  accessory: PiloAccessory;
  heldObject?: string;
  readiness: PiloLifeActionReadiness;
  entry: string;
  exit: string;
  continuity: PiloActionContinuity;
};

/**
 * Product behavior inventory. Missing prop actions remain disabled until a
 * complete rendered action exists; the runtime never fakes them with overlays.
 */
export const PILO_LIFE_ACTIONS: readonly PiloLifeActionDefinition[] = [
  { id: "read", label: "安静阅读", trigger: "打开资料或阅读笔记", state: "reading", accessory: "glasses", heldObject: "书", readiness: "loop-ready", entry: "拿起书并戴好眼镜", exit: "合上书并抬头", continuity: "resumable" },
  { id: "work", label: "整理内容", trigger: "系统正在整理或生成", state: "working", accessory: "glasses", heldObject: "小电脑", readiness: "loop-ready", entry: "打开电脑", exit: "检查后合上电脑", continuity: "resumable" },
  { id: "rest", label: "坐下休息", trigger: "较长时间没有操作", state: "resting", accessory: "none", readiness: "loop-ready", entry: "由站立坐下", exit: "起身回到安静待机", continuity: "interruptible" },
  { id: "walk", label: "慢慢走动", trigger: "页面空间允许且当前没有任务事件", state: "walking", accessory: "none", readiness: "loop-ready", entry: "转向后起步", exit: "减速、停下并回头", continuity: "interruptible" },
  { id: "wait", label: "捧星等待", trigger: "等待用户确认", state: "waiting", accessory: "none", heldObject: "胸前星光", readiness: "loop-ready", entry: "捧起星光", exit: "将星光收回胸前", continuity: "resumable" },
  { id: "stretch", label: "伸展活动", trigger: "连续专注时间较长", state: "stretching", accessory: "headband", readiness: "loop-ready", entry: "站稳后舒展", exit: "放松回到待机", continuity: "finish-first" },
  { id: "comfort", label: "安慰自己", trigger: "失败、延期或计划受阻", state: "failure", accessory: "none", heldObject: "胸前星光", readiness: "loop-ready", entry: "抱住胸前星光", exit: "平复后重新抬头", continuity: "finish-first" },
  { id: "finish", label: "回应完成", trigger: "目标或任务完成", state: "success", accessory: "none", readiness: "loop-ready", entry: "收到结果后抬头", exit: "轻轻挥手后安静下来", continuity: "finish-first" },
  { id: "tea-break", label: "茶歇", trigger: "专注休息时间", state: "resting", accessory: "none", heldObject: "小杯子", readiness: "complete", entry: "拿起杯子", exit: "放好杯子再起身", continuity: "resumable" },
  { id: "capture-idea", label: "记录灵感", trigger: "创建或快速记录笔记", state: "working", accessory: "glasses", heldObject: "小本子", readiness: "complete", entry: "拿出小本子", exit: "合上本子并收好", continuity: "resumable" },
  { id: "check-timer", label: "查看计时器", trigger: "专注任务即将结束", state: "checking", accessory: "none", heldObject: "小计时器", readiness: "complete", entry: "低头拿起计时器", exit: "放回计时器", continuity: "finish-first" },
  { id: "tidy-desk", label: "整理桌面", trigger: "任务结束或准备离开页面", state: "checking", accessory: "glasses", heldObject: "书与电脑", readiness: "complete", entry: "停下当前工作", exit: "收书并合上电脑", continuity: "finish-first" },
  { id: "nurture-growth", label: "照顾小芽", trigger: "习惯延续或长期目标成长", state: "success", accessory: "wristwarmers", heldObject: "小苗", readiness: "complete", entry: "拿起小水壶", exit: "看一眼小芽再收好", continuity: "finish-first" },
  { id: "relief", label: "松一口气", trigger: "复杂任务处理完成", state: "resting", accessory: "none", readiness: "complete", entry: "完成收尾后坐下", exit: "肩膀放松后起身", continuity: "finish-first" },
  { id: "nap", label: "短暂打盹", trigger: "夜间或长时间无操作", state: "resting", accessory: "none", heldObject: "小盖毯", readiness: "complete", entry: "困倦并盖好毯子", exit: "被唤醒后伸懒腰", continuity: "resumable" },
  { id: "sign-off", label: "收工告别", trigger: "结束当天学习", state: "greeting", accessory: "none", readiness: "complete", entry: "整理好物品", exit: "轻轻鞠躬或挥手", continuity: "finish-first" },
] as const;

export function piloLifeActionContinuity(action?: PiloLifeActionId): PiloActionContinuity {
  return PILO_LIFE_ACTIONS.find((entry) => entry.id === action)?.continuity ?? "interruptible";
}

const MINIMUM_DWELL_BY_LAYER: Record<PiloStateLayer, number> = {
  interaction: 700,
  system: 2_200,
  agent: 1_400,
  feedback: 1_800,
  context: 3_000,
  inactivity: 8_000,
  ambient: 12_000,
};

const MINIMUM_DWELL_BY_STATE: Partial<Record<PiloSystemState, number>> = {
  idle: 8_000,
  reading: 8_000,
  working: 2_400,
  waiting: 2_400,
  success: 2_000,
  failure: 2_800,
  resting: 10_000,
  walking: 1_200,
};

export function piloPresentationDelay(
  current: ScheduledPiloState,
  target: ScheduledPiloState,
  visibleForMs: number,
) {
  if (
    current.id === target.id
    && current.state === target.state
    && current.accessory === target.accessory
    && current.lifeAction === target.lifeAction
  ) return 0;
  if (target.priority > current.priority || target.layer === "interaction") return 0;
  // Dragging and opening a panel are temporary interaction shells. Once the
  // interaction ends, immediately restore the interrupted semantic action;
  // holding the neutral drag pose for idle's eight-second dwell makes Pilo
  // appear to have forgotten what it was doing.
  if (current.source === "companion:interaction") return 0;
  // A single semantic activity may move from viewing to editing or checking.
  // Do not enforce the old state's full dwell again; the presentation layer
  // still plays the current action's leaving frames before committing.
  if (current.source === target.source && current.layer === target.layer) return 0;
  const minimumDwell = Math.max(
    MINIMUM_DWELL_BY_LAYER[current.layer],
    MINIMUM_DWELL_BY_STATE[current.state] ?? 0,
    current.minimumDwell,
  );
  return Math.max(0, minimumDwell - visibleForMs);
}

export type PiloInterruptionBudget = {
  day: string;
  nudges: number;
};

export function piloDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizePiloInterruptionBudget(
  value: Partial<PiloInterruptionBudget> | null | undefined,
  date = new Date(),
): PiloInterruptionBudget {
  const day = piloDayKey(date);
  if (value?.day !== day) return { day, nudges: 0 };
  return { day, nudges: Math.max(0, Number(value.nudges) || 0) };
}

export function piloNudgeLimit(initiative: "quiet" | "balanced" | "present") {
  // Active modes do not use an arbitrary daily counter. The rhythm guard is
  // provided by per-surface cooldowns, minimum dwell and one-per-scene/day
  // semantics; the quiet mode remains an explicit zero-interruption choice.
  return initiative === "quiet" ? 0 : Number.POSITIVE_INFINITY;
}

export function piloAccessoryReason(accessory: PiloAccessory, state: PiloSystemState, fixed = false) {
  if (accessory === "none") return "当前动作不需要额外配饰";
  if (fixed) return "这是你选择的固定造型；任务动作仍会优先表达当前状态";
  if (accessory === "glasses") return state === "working" ? "整理内容时戴上圆框眼镜" : "阅读、思考或检查时戴上圆框眼镜";
  if (accessory === "headband") return "伸展或完成一轮专注时戴上运动头带";
  if (accessory === "scarf") return "温暖陪伴或休息时围上短围巾";
  if (accessory === "earmuffs") return "共同专注时戴上低轮廓耳机";
  if (accessory === "wristwarmers") return "阶段里程碑或连续习惯达成时佩戴腕带";
  if (accessory === "laurel") return "这是你选择的季节主题配饰";
  return "这是你选择的陪伴造型";
}
