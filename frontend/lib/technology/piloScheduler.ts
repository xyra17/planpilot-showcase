import {
  inferPiloStateLayer,
  type PiloAccessory,
  type PiloInterruptRule,
  type PiloLifeActionId,
  type PiloStateDetail,
  type PiloStateLayer,
  type PiloSystemState,
} from "@/lib/technology/piloState";
import { piloLifeActionContinuity } from "@/lib/technology/piloRhythm";

export const PILO_LAYER_PRIORITY: Record<PiloStateLayer, number> = {
  system: 800,
  interaction: 700,
  agent: 600,
  feedback: 500,
  context: 400,
  inactivity: 300,
  ambient: 200,
};

export const PILO_LAYER_LABEL: Record<PiloStateLayer, string> = {
  interaction: "用户交互",
  system: "系统事件",
  agent: "Agent 工作",
  feedback: "结果反馈",
  context: "页面上下文",
  inactivity: "久未操作",
  ambient: "环境待机",
};

export type ScheduledPiloState = {
  id: string;
  state: PiloSystemState;
  layer: PiloStateLayer;
  priority: number;
  source: string;
  reason: string;
  message?: string;
  accessory: PiloAccessory;
  lifeAction?: PiloLifeActionId;
  interrupt: PiloInterruptRule;
  createdAt: number;
  expiresAt: number | null;
  cooldown: number;
  cooldownKey: string;
  minimumDwell: number;
  sequence: number;
};

export type PiloTimelineAction = "requested" | "activated" | "resumed" | "interrupted" | "released" | "expired" | "cooled-down";

export type PiloTimelineEntry = {
  id: number;
  at: number;
  action: PiloTimelineAction;
  state: PiloSystemState;
  layer: PiloStateLayer;
  source: string;
  reason: string;
  lifeAction?: PiloLifeActionId;
};

export type PiloSchedulerSnapshot = {
  active: ScheduledPiloState;
  timeline: readonly PiloTimelineEntry[];
  seed: number;
};

type Subscriber = (snapshot: PiloSchedulerSnapshot) => void;

const DEFAULT_DURATION: Record<PiloStateLayer, number | null> = {
  interaction: null,
  system: 4_200,
  agent: 90_000,
  feedback: 3_600,
  context: null,
  inactivity: null,
  ambient: null,
};

const DEFAULT_REASON: Record<PiloSystemState, string> = {
  idle: "当前没有更高优先级的事件，安静陪伴",
  listening: "你正在和 Pilo 互动",
  thinking: "正在理解和推理",
  working: "正在执行任务",
  checking: "正在检查处理结果",
  waiting: "正在等待你的确认",
  success: "刚刚完成了一项操作",
  failure: "刚刚有一项操作未能完成",
  greeting: "正在回应你的靠近或移动",
  reading: "当前页面适合阅读与整理",
  resting: "你暂时没有操作，Pilo 也坐下休息",
  walking: "Pilo 正在移动到新的陪伴位置",
  stretching: "连续使用时间较长，提醒你活动一下",
};

function hashSeed(value: number) {
  let seed = value | 0;
  seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  return (seed ^ (seed >>> 16)) >>> 0;
}

export class PiloStateScheduler {
  private requests = new Map<string, ScheduledPiloState>();
  private cooldowns = new Map<string, number>();
  private subscribers = new Set<Subscriber>();
  private entries: PiloTimelineEntry[] = [];
  private activeId = "ambient:system";
  private timelineId = 0;
  private randomState: number;
  private requestSequence = 0;
  private activatedIds = new Set<string>();

  constructor(private seed = 20260809, private readonly maxTimeline = 80) {
    this.randomState = hashSeed(seed) || 1;
    const now = Date.now();
    this.requests.set(this.activeId, {
      id: this.activeId,
      state: "idle",
      layer: "ambient",
      priority: PILO_LAYER_PRIORITY.ambient,
      source: "system",
      reason: DEFAULT_REASON.idle,
      accessory: "none",
      interrupt: "same-or-higher",
      createdAt: now,
      expiresAt: null,
      cooldown: 0,
      cooldownKey: this.activeId,
      minimumDwell: 8_000,
      sequence: this.requestSequence,
    });
  }

  subscribe(subscriber: Subscriber) {
    this.subscribers.add(subscriber);
    subscriber(this.snapshot());
    return () => this.subscribers.delete(subscriber);
  }

  request(detail: PiloStateDetail, now = Date.now()) {
    if (detail.clear) return this.release(detail.id ?? detail.source, now);
    const layer = inferPiloStateLayer(detail);
    const source = detail.source ?? "unspecified";
    const id = detail.id ?? `${layer}:${source}`;
    if (layer === "feedback") {
      for (const entry of this.requests.values()) {
        if (entry.layer === "agent" && entry.source === source) {
          this.requests.delete(entry.id);
          this.pushTimeline("released", entry, now);
        }
      }
    }
    const cooldownKey = detail.cooldownKey ?? `${source}:${detail.state}`;
    const cooldownUntil = this.cooldowns.get(cooldownKey) ?? 0;
    if (cooldownUntil > now && this.requests.get(id)?.state !== detail.state) {
      this.pushTimeline("cooled-down", {
        id,
        state: detail.state,
        layer,
        priority: PILO_LAYER_PRIORITY[layer],
        source,
        reason: `冷却至 ${new Date(cooldownUntil).toLocaleTimeString("zh-CN", { hour12: false })}`,
        accessory: detail.accessory ?? "none",
        lifeAction: detail.lifeAction,
        interrupt: detail.interrupt ?? "same-or-higher",
        createdAt: now,
        expiresAt: null,
        cooldown: detail.cooldown ?? 0,
        cooldownKey,
        minimumDwell: Math.max(0, detail.minimumDwell ?? 0),
        sequence: ++this.requestSequence,
      }, now);
      this.emit();
      return false;
    }

    const duration = detail.duration === undefined ? DEFAULT_DURATION[layer] : detail.duration;
    const request: ScheduledPiloState = {
      id,
      state: detail.state,
      layer,
      priority: PILO_LAYER_PRIORITY[layer],
      source,
      reason: detail.reason ?? DEFAULT_REASON[detail.state],
      message: detail.message,
      accessory: detail.accessory ?? "none",
      lifeAction: detail.lifeAction,
      interrupt: detail.interrupt ?? (piloLifeActionContinuity(detail.lifeAction) === "finish-first" ? "higher" : "same-or-higher"),
      createdAt: now,
      expiresAt: duration && duration > 0 ? now + duration : null,
      cooldown: Math.max(0, detail.cooldown ?? 0),
      cooldownKey,
      minimumDwell: Math.max(0, detail.minimumDwell ?? 0),
      sequence: ++this.requestSequence,
    };
    this.requests.set(id, request);
    this.pushTimeline("requested", request, now);
    this.reconcile(now);
    return true;
  }

  release(idOrSource?: string, now = Date.now()) {
    if (!idOrSource) return false;
    const removed = [...this.requests.values()].filter((entry) => entry.id === idOrSource || entry.source === idOrSource);
    for (const entry of removed) {
      if (entry.id === "ambient:system") continue;
      this.requests.delete(entry.id);
      if (entry.cooldown > 0) this.cooldowns.set(entry.cooldownKey, now + entry.cooldown);
      this.pushTimeline("released", entry, now);
    }
    if (removed.length) this.reconcile(now);
    return removed.length > 0;
  }

  tick(now = Date.now()) {
    let changed = false;
    for (const entry of this.requests.values()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.requests.delete(entry.id);
        if (entry.cooldown > 0) this.cooldowns.set(entry.cooldownKey, now + entry.cooldown);
        this.pushTimeline("expired", entry, now);
        changed = true;
      }
    }
    for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key);
    if (changed) this.reconcile(now);
    return changed;
  }

  random() {
    let value = this.randomState += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  pick<T>(values: readonly T[]) {
    return values[Math.floor(this.random() * values.length)] ?? values[0];
  }

  snapshot(): PiloSchedulerSnapshot {
    const fallback = this.requests.get("ambient:system");
    const active = this.requests.get(this.activeId) ?? fallback;
    if (!active) throw new Error("Pilo scheduler lost its ambient state");
    return { active, timeline: [...this.entries], seed: this.seed };
  }

  private reconcile(now: number) {
    const previous = this.requests.get(this.activeId);
    const candidates = [...this.requests.values()].sort((left, right) => right.priority - left.priority || right.sequence - left.sequence);
    let next = candidates[0];
    if (previous && previous.id !== next?.id && previous.expiresAt !== null && previous.expiresAt > now) {
      const sameSourceReplacement = next?.source === previous.source && next.layer === previous.layer;
      const canInterrupt = sameSourceReplacement
        || previous.interrupt !== "never" && (
          next.priority > previous.priority
          || previous.interrupt === "same-or-higher" && next.priority === previous.priority
        );
      if (!canInterrupt) next = previous;
    }
    if (!next || next.id === this.activeId) {
      this.emit();
      return;
    }
    if (previous) this.pushTimeline("interrupted", previous, now);
    this.activeId = next.id;
    const wasActivated = this.activatedIds.has(next.id);
    this.activatedIds.add(next.id);
    this.pushTimeline(wasActivated ? "resumed" : "activated", next, now);
    this.emit();
  }

  private pushTimeline(action: PiloTimelineAction, entry: ScheduledPiloState, at: number) {
    this.entries.push({
      id: ++this.timelineId,
      at,
      action,
      state: entry.state,
      layer: entry.layer,
      source: entry.source,
      reason: entry.reason,
      lifeAction: entry.lifeAction,
    });
    if (this.entries.length > this.maxTimeline) this.entries.splice(0, this.entries.length - this.maxTimeline);
  }

  private emit() {
    const snapshot = this.snapshot();
    this.subscribers.forEach((subscriber) => subscriber(snapshot));
  }
}
