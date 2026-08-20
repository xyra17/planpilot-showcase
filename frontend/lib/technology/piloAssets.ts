import type { PiloMood } from "@/components/technology/PiloAvatar";
import type { PiloAccessory } from "@/lib/technology/piloState";

export type PiloAssetCoverage = "ready" | "fallback";

export type PiloAssetResolution = {
  mood: PiloMood;
  accessory: PiloAccessory;
  coverage: PiloAssetCoverage;
  reason: string;
};

/**
 * Only combinations backed by a complete rendered pose or atlas row belong
 * here. Accessories are never composited over Pilo at runtime.
 */
export const PILO_ACCESSORY_MATRIX: Record<PiloAccessory, Partial<Record<PiloMood, PiloMood>>> = {
  none: {},
  glasses: {
    idle: "idle",
    listening: "listening",
    thinking: "thinking",
    reading: "reading",
    working: "working",
    checking: "checking",
  },
  scarf: {
    idle: "idle",
    listening: "listening",
    sitting: "scarf",
    scarf: "scarf",
  },
  headband: {
    idle: "idle",
    listening: "listening",
    stretching: "stretching",
  },
  earmuffs: {
    idle: "idle",
    listening: "listening",
  },
  laurel: {
    idle: "idle",
    listening: "listening",
  },
  beltbag: {
    idle: "idle",
    listening: "listening",
  },
  wristwarmers: {
    idle: "idle",
    listening: "listening",
  },
};

export const PILO_ACCESSORY_LABELS: Record<PiloAccessory, string> = {
  none: "经典造型",
  glasses: "圆框眼镜",
  scarf: "短围巾",
  headband: "运动头带",
  earmuffs: "低轮廓耳机",
  laurel: "月桂花环",
  beltbag: "探索腰包",
  wristwarmers: "云朵护腕",
};

export const PILO_ASSET_INVENTORY = [
  { pose: "idle", accessory: "none", asset: "/pilo/v2/spritesheet.webp#row=0", frames: 6 },
  { pose: "walking", accessory: "none", asset: "/pilo/v2/spritesheet.webp#rows=1,2", frames: 8 },
  { pose: "greeting", accessory: "none", asset: "/pilo/v2/spritesheet.webp#row=3", frames: 4 },
  { pose: "stretching", accessory: "headband", asset: "/pilo/v2/spritesheet.webp#row=4", frames: 5 },
  { pose: "failure", accessory: "none", asset: "/pilo/v2/spritesheet.webp#row=5", frames: 8 },
  { pose: "waiting", accessory: "none", asset: "/pilo/v2/spritesheet.webp#row=6", frames: 6 },
  { pose: "listening", accessory: "none", asset: "/pilo/v2/spritesheet.webp#row=0", frames: 6 },
  { pose: "working", accessory: "glasses", asset: "/pilo/v2/spritesheet.webp#row=7", frames: 6 },
  { pose: "reading/checking", accessory: "glasses", asset: "/pilo/v2/spritesheet.webp#row=8", frames: 6 },
  { pose: "thinking", accessory: "none", asset: "/pilo/states/pilo-thinking.webp", frames: 1 },
  { pose: "thinking", accessory: "glasses", asset: "/pilo/states/pilo-glasses.webp", frames: 1 },
  { pose: "idle/listening", accessory: "glasses", asset: "/pilo/outfits/pilo-glasses.webp", frames: 1 },
  { pose: "sitting", accessory: "none", asset: "/pilo/states/pilo-sitting.webp", frames: 1 },
  { pose: "idle/sitting", accessory: "scarf", asset: "/pilo/states/pilo-scarf.webp", frames: 1 },
  { pose: "idle/listening", accessory: "scarf", asset: "/pilo/outfits/pilo-scarf.webp", frames: 1 },
  { pose: "idle/listening", accessory: "headband", asset: "/pilo/outfits/pilo-headband.webp", frames: 1 },
  { pose: "idle/listening", accessory: "earmuffs", asset: "/pilo/outfits/pilo-earmuffs.webp", frames: 1 },
  { pose: "idle/listening", accessory: "laurel", asset: "/pilo/outfits/pilo-laurel.webp", frames: 1 },
  { pose: "idle/listening", accessory: "beltbag", asset: "/pilo/outfits/pilo-beltbag.webp", frames: 1 },
  { pose: "idle/listening", accessory: "wristwarmers", asset: "/pilo/outfits/pilo-wristwarmers.webp", frames: 1 },
  { pose: "tea-break", accessory: "none", asset: "/pilo/life/tea-break/*.png", frames: 8 },
  { pose: "capture-idea", accessory: "glasses", asset: "/pilo/life/capture-idea/*.png", frames: 8 },
  { pose: "check-timer", accessory: "none", asset: "/pilo/life/check-timer/*.png", frames: 8 },
  { pose: "tidy-desk", accessory: "glasses", asset: "/pilo/life/tidy-desk/*.png", frames: 8 },
  { pose: "nurture-growth", accessory: "wristwarmers", asset: "/pilo/life/nurture-growth/*.png", frames: 8 },
  { pose: "relief", accessory: "none", asset: "/pilo/life/relief/*.png", frames: 8 },
  { pose: "nap", accessory: "none", asset: "/pilo/life/nap/*.png", frames: 8 },
  { pose: "sign-off", accessory: "none", asset: "/pilo/life/sign-off/*.png", frames: 8 },
] as const;

export function resolvePiloAsset(mood: PiloMood, accessory: PiloAccessory = "none"): PiloAssetResolution {
  if (accessory === "none") {
    return { mood, accessory, coverage: "ready", reason: "使用当前姿态的完整渲染素材" };
  }
  const renderedMood = PILO_ACCESSORY_MATRIX[accessory][mood];
  if (renderedMood) {
    return { mood: renderedMood, accessory, coverage: "ready", reason: `使用${PILO_ACCESSORY_LABELS[accessory]}的完整渲染素材` };
  }
  return {
    mood,
    accessory: "none",
    coverage: "fallback",
    reason: `当前姿态还没有${PILO_ACCESSORY_LABELS[accessory]}的完整渲染版本，保留动作语义且不叠加贴图`,
  };
}
