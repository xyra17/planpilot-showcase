"use client";

export const PILO_STATE_EVENT = "planpilot:pilo-state";

export type PiloSystemState =
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "checking"
  | "waiting"
  | "success"
  | "failure"
  | "greeting"
  | "reading"
  | "resting"
  | "walking"
  | "stretching";

export type PiloStateLayer = "interaction" | "system" | "agent" | "feedback" | "context" | "inactivity" | "ambient";
export type PiloInterruptRule = "same-or-higher" | "higher" | "never";
export type PiloAccessory =
  | "none"
  | "glasses"
  | "scarf"
  | "headband"
  | "earmuffs"
  | "laurel"
  | "beltbag"
  | "wristwarmers";

export type PiloLifeActionId =
  | "read"
  | "work"
  | "rest"
  | "walk"
  | "wait"
  | "stretch"
  | "comfort"
  | "finish"
  | "tea-break"
  | "capture-idea"
  | "check-timer"
  | "tidy-desk"
  | "nurture-growth"
  | "relief"
  | "nap"
  | "sign-off";

export type PiloStateDetail = {
  state: PiloSystemState;
  id?: string;
  layer?: PiloStateLayer;
  source?: string;
  reason?: string;
  duration?: number;
  cooldown?: number;
  cooldownKey?: string;
  minimumDwell?: number;
  interrupt?: PiloInterruptRule;
  message?: string;
  accessory?: PiloAccessory;
  lifeAction?: PiloLifeActionId;
  clear?: boolean;
};

export type PiloAgentPhase =
  | "thinking"
  | "retrieving"
  | "tool"
  | "generating"
  | "verifying"
  | "waiting"
  | "failed"
  | "recovering"
  | "done";

const AGENT_PHASE_STATE: Record<PiloAgentPhase, PiloSystemState> = {
  thinking: "thinking",
  retrieving: "reading",
  tool: "working",
  generating: "working",
  verifying: "checking",
  waiting: "waiting",
  failed: "failure",
  recovering: "thinking",
  done: "success",
};

const AGENT_PHASE_REASON: Record<PiloAgentPhase, string> = {
  thinking: "正在理解你的问题",
  retrieving: "正在检索相关资料",
  tool: "正在执行所需工具",
  generating: "正在组织回答",
  verifying: "正在检查结果是否可靠",
  waiting: "正在等待你的确认",
  failed: "本轮处理遇到了阻碍",
  recovering: "正在尝试恢复本轮处理",
  done: "本轮处理已经完成",
};

export function inferPiloStateLayer(detail: Pick<PiloStateDetail, "state" | "source" | "layer">): PiloStateLayer {
  if (detail.layer) return detail.layer;
  if (detail.source?.startsWith("agent:")) return detail.state === "success" || detail.state === "failure" ? "feedback" : "agent";
  if (detail.state === "success" || detail.state === "failure") return "system";
  if (detail.state === "stretching") return "inactivity";
  if (detail.state === "listening" || detail.state === "greeting" || detail.state === "walking") return "interaction";
  if (detail.state === "reading" || detail.state === "resting") return "context";
  if (detail.state === "idle") return "ambient";
  return "agent";
}

export function signalPiloState(state: PiloSystemState, detail: Omit<PiloStateDetail, "state"> = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PiloStateDetail>(PILO_STATE_EVENT, {
    detail: { state, ...detail },
  }));
}

export function clearPiloState(source: string, layer?: PiloStateLayer) {
  signalPiloState("idle", { source, layer, clear: true });
}

export function signalPiloAgentPhase(
  phase: PiloAgentPhase,
  options: {
    source?: string;
    reason?: string;
    tool?: string;
    duration?: number;
    message?: string;
  } = {},
) {
  const source = options.source ?? "agent:stream";
  const feedback = phase === "done" || phase === "failed";
  if (feedback) clearPiloState(source, "agent");
  const reason = options.reason
    ?? (options.tool ? `${AGENT_PHASE_REASON[phase]}：${options.tool}` : AGENT_PHASE_REASON[phase]);
  signalPiloState(AGENT_PHASE_STATE[phase], {
    id: feedback ? `${source}:${phase}` : source,
    layer: feedback ? "system" : "agent",
    source,
    reason,
    message: options.message,
    duration: options.duration ?? (feedback ? (phase === "done" ? 3_200 : 4_200) : 90_000),
    cooldown: feedback ? 1_200 : 0,
    interrupt: feedback ? "same-or-higher" : "higher",
    accessory: phase === "retrieving" || phase === "verifying" ? "glasses" : undefined,
  });
}

export async function withPiloState<T>(
  task: () => Promise<T>,
  options: { source?: string; working?: PiloSystemState; success?: PiloSystemState; failure?: PiloSystemState } = {},
): Promise<T> {
  const source = options.source ?? "agent:task";
  signalPiloState(options.working ?? "working", {
    source,
    layer: "agent",
    reason: "正在处理这项操作",
    duration: 90_000,
  });
  try {
    const result = await task();
    signalPiloState(options.success ?? "success", {
      source,
      layer: "system",
      reason: "操作已经完成",
      duration: 3_600,
    });
    return result;
  } catch (error) {
    signalPiloState(options.failure ?? "failure", {
      source,
      layer: "system",
      reason: "操作未能完成",
      duration: 4_200,
    });
    throw error;
  }
}
