"use client";

import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";

import { resolvePiloAsset } from "@/lib/technology/piloAssets";
import type { PiloActionPhase } from "@/lib/technology/piloRhythm";
import type { PiloAccessory, PiloLifeActionId } from "@/lib/technology/piloState";

export type PiloMood =
  | "idle"
  | "listening"
  | "waiting"
  | "thinking"
  | "working"
  | "checking"
  | "success"
  | "stretching"
  | "failure"
  | "greeting"
  | "reading"
  | "sitting"
  | "walking"
  | "walking-left"
  | "walking-right"
  | "scarf";

type AtlasState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

type AtlasAnimation = {
  row: number;
  durations: readonly number[];
  loop?: boolean;
  holdFrame?: number;
};

type AssetGeometry = {
  scale: number;
  offsetY: number;
};

const ATLAS_PATH = "/pilo/v2/spritesheet.webp";
const LIFE_ACTION_PHASE_FRAMES: Record<PiloActionPhase, readonly number[]> = {
  entering: [0, 1, 2],
  holding: [3, 4, 5],
  leaving: [6, 7],
};
const LIFE_ACTION_PHASE_FRAME_OVERRIDES: Partial<Record<PiloLifeActionId, Record<PiloActionPhase, readonly number[]>>> = {
  // Wave once, lower the hand, then remain settled instead of holding the
  // raised-hand pose for the entire sign-off duration.
  "sign-off": {
    entering: [0, 1, 2],
    holding: [3, 4, 5, 6],
    leaving: [7],
  },
};
const ATLAS_LIFE_ACTION_PHASE_FRAMES: Partial<Record<PiloLifeActionId, Record<PiloActionPhase, readonly number[]>>> = {
  read: { entering: [0, 1], holding: [2, 3, 4, 5], leaving: [5, 1, 0] },
  work: { entering: [0, 1], holding: [2, 3, 4, 5], leaving: [5, 1, 0] },
  wait: { entering: [0, 1], holding: [2, 3, 4, 5], leaving: [5, 1, 0] },
  stretch: { entering: [0, 1], holding: [2, 3], leaving: [4, 0] },
  comfort: { entering: [0, 1, 2], holding: [3, 4, 5], leaving: [6, 7] },
  finish: { entering: [0, 1, 2], holding: [3], leaving: [3, 0] },
  walk: { entering: [0, 1], holding: [2, 3, 4, 5, 6], leaving: [7, 0] },
};
const LIFE_ACTION_DURATIONS = [150, 150, 170, 260, 260, 260, 190, 220] as const;
// These actions tell one small story and must settle on their final holding
// frame. Looping the middle frames makes a prop jump back to its start.
const ONE_SHOT_LIFE_ACTIONS = new Set<PiloLifeActionId>([
  "check-timer",
  "tidy-desk",
  "nurture-growth",
  "relief",
  "sign-off",
]);
const LIFE_ACTION_ASSETS: Partial<Record<PiloLifeActionId, string>> = {
  "tea-break": "/pilo/life/tea-break",
  "capture-idea": "/pilo/life/capture-idea",
  "check-timer": "/pilo/life/check-timer",
  "tidy-desk": "/pilo/life/tidy-desk",
  "nurture-growth": "/pilo/life/nurture-growth",
  relief: "/pilo/life/relief",
  nap: "/pilo/life/nap",
  "sign-off": "/pilo/life/sign-off",
};
const LIFE_ACTION_COPY: Partial<Record<PiloLifeActionId, string>> = {
  "tea-break": "Pilo 正捧着小杯子安静茶歇",
  "capture-idea": "Pilo 正拿出小本子记录灵感",
  "check-timer": "Pilo 正低头查看专注计时器",
  "tidy-desk": "Pilo 正合上电脑整理收尾",
  "nurture-growth": "Pilo 正照顾代表长期目标的小芽",
  relief: "Pilo 坐下来松了一口气",
  nap: "Pilo 盖着小毯子短暂打盹",
  "sign-off": "Pilo 正挥手结束今天的学习",
};

const ATLAS_ANIMATIONS: Record<AtlasState, AtlasAnimation> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280], loop: false, holdFrame: 3 },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280], loop: false, holdFrame: 4 },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
};

const MOOD_STATE: Exclude<Record<PiloMood, AtlasState | null>, never> = {
  idle: "idle",
  listening: null,
  waiting: "waiting",
  thinking: "review",
  working: "running",
  checking: "review",
  success: "waving",
  stretching: "jumping",
  failure: "failed",
  greeting: "waving",
  reading: "review",
  sitting: null,
  walking: "running-right",
  "walking-left": "running-left",
  "walking-right": "running-right",
  scarf: null,
};

const MOTION_SEMANTIC: Record<AtlasState, string> = {
  idle: "calm-idle",
  "running-right": "travel-right",
  "running-left": "travel-left",
  waving: "single-response",
  jumping: "seated-stretch",
  failed: "self-comfort",
  waiting: "hold-star-wait",
  running: "focused-work",
  review: "read-or-review",
};

const STATIC_ASSETS: Partial<Record<PiloMood, string>> = {
  listening: "/pilo/states/pilo-listening.webp",
  thinking: "/pilo/states/pilo-thinking.webp",
  sitting: "/pilo/states/pilo-sitting.webp",
  scarf: "/pilo/states/pilo-scarf.webp",
};

const ACCESSORY_STATIC_ASSETS: Partial<Record<`${PiloAccessory}:${PiloMood}`, string>> = {
  "glasses:thinking": "/pilo/states/pilo-glasses.webp",
};

const PASSIVE_OUTFIT_ASSETS: Partial<Record<PiloAccessory, string>> = {
  glasses: "/pilo/outfits/pilo-glasses.webp",
  scarf: "/pilo/outfits/pilo-scarf.webp",
  headband: "/pilo/outfits/pilo-headband.webp",
  earmuffs: "/pilo/outfits/pilo-earmuffs.webp",
  laurel: "/pilo/outfits/pilo-laurel.webp",
  beltbag: "/pilo/outfits/pilo-beltbag.webp",
  wristwarmers: "/pilo/outfits/pilo-wristwarmers.webp",
};

const PASSIVE_OUTFIT_LAYER_CLASS: Partial<Record<PiloAccessory, string>> = {
  glasses: "is-face",
  scarf: "is-neck",
  headband: "is-headband",
  earmuffs: "is-earmuffs",
  laurel: "is-laurel",
  beltbag: "is-waist",
  wristwarmers: "is-wrists",
};

const REDUCED_MOTION_ASSETS: Partial<Record<PiloMood, string>> = {
  reading: "/pilo/states/pilo-reading.webp",
  walking: "/pilo/states/pilo-walking.webp",
  "walking-left": "/pilo/states/pilo-walking.webp",
  "walking-right": "/pilo/states/pilo-walking.webp",
};

// Supplemental renders use larger transparent margins than the v2 atlas.
// Normalize their visible height and baseline so a pose swap never looks like
// Pilo is being compressed, while leaving full-size outfit renders untouched.
const SUPPLEMENTAL_GEOMETRY: Record<string, AssetGeometry> = {
  "/pilo/states/pilo-thinking.webp": { scale: 1.117, offsetY: -0.009 },
  "/pilo/states/pilo-listening.webp": { scale: 1.075, offsetY: -0.004 },
  "/pilo/states/pilo-sitting.webp": { scale: 1.138, offsetY: -0.013 },
  "/pilo/states/pilo-scarf.webp": { scale: 1.067, offsetY: 0 },
  "/pilo/states/pilo-glasses.webp": { scale: 1.063, offsetY: 0.006 },
  "/pilo/states/pilo-reading.webp": { scale: 1.122, offsetY: -0.011 },
  "/pilo/states/pilo-walking.webp": { scale: 1.171, offsetY: -0.009 },
};

const MOOD_COPY: Record<PiloMood, string> = {
  idle: "Pilo 正安静地呼吸和眨眼",
  listening: "Pilo 正专注听你说话",
  waiting: "Pilo 捧着星光等待你的确认",
  thinking: "Pilo 正在专注思考",
  working: "Pilo 戴着眼镜在小电脑前工作",
  checking: "Pilo 正戴着眼镜检查结果",
  success: "Pilo 正轻轻挥手回应",
  stretching: "Pilo 戴着运动头带提醒你活动一下",
  failure: "Pilo 遇到阻碍，稍稍泄气",
  greeting: "Pilo 正在挥手问候",
  reading: "Pilo 戴着眼镜安静看书",
  sitting: "Pilo 坐下来安静休息",
  walking: "Pilo 正慢慢走动",
  "walking-left": "Pilo 正慢慢向左走",
  "walking-right": "Pilo 正慢慢向右走",
  scarf: "Pilo 围着短围巾温暖陪伴",
};

export function PiloAvatar({
  mood = "idle",
  size = 56,
  className = "",
  priority = false,
  illuminated = false,
  accessory = "none",
  accessories,
  frameOverride,
  instant = false,
  lifeAction,
  actionPhase = "holding",
}: {
  mood?: PiloMood;
  size?: number;
  className?: string;
  priority?: boolean;
  illuminated?: boolean;
  accessory?: PiloAccessory;
  accessories?: readonly PiloAccessory[];
  frameOverride?: number;
  instant?: boolean;
  lifeAction?: PiloLifeActionId;
  actionPhase?: PiloActionPhase;
}) {
  const reduceMotion = useReducedMotion();
  const [frame, setFrame] = useState(0);
  const asset = useMemo(() => resolvePiloAsset(mood, accessory), [accessory, mood]);
  const resolvedMood = asset.mood;
  const atlasState = MOOD_STATE[resolvedMood];
  const animation = atlasState ? ATLAS_ANIMATIONS[atlasState] : null;
  const lifeActionBase = lifeAction ? LIFE_ACTION_ASSETS[lifeAction] : undefined;
  const lifeActionFrames = lifeActionBase
    ? (lifeAction ? LIFE_ACTION_PHASE_FRAME_OVERRIDES[lifeAction]?.[actionPhase] : undefined) ?? LIFE_ACTION_PHASE_FRAMES[actionPhase]
    : null;
  const atlasLifeActionFrames = !lifeActionBase && lifeAction ? ATLAS_LIFE_ACTION_PHASE_FRAMES[lifeAction]?.[actionPhase] : null;
  const activeActionFrames = lifeActionFrames ?? atlasLifeActionFrames;
  const renderedFrame = activeActionFrames && !activeActionFrames.includes(frame) ? activeActionFrames[0] : frame;
  const passiveAccessories = useMemo(() => Array.from(new Set(
    (accessories ?? []).filter((item) => item !== "none" && PASSIVE_OUTFIT_ASSETS[item]),
  )), [accessories]);
  const canShowPassiveCombination = !lifeActionBase && (resolvedMood === "idle" || resolvedMood === "listening") && passiveAccessories.length > 0;
  // Outfit files are complete character renders rather than isolated accessory
  // layers. Cropping one over a life-action frame creates a visible rectangular
  // seam because the pose, lighting and body proportions do not match. Keep the
  // user's outfit selection, but show it again only after the action settles.
  const canLayerPassiveAccessories = false;
  const primaryPassiveAccessory = canShowPassiveCombination ? passiveAccessories[0] : asset.accessory;
  const passiveOutfitAsset = !lifeActionBase && (resolvedMood === "idle" || resolvedMood === "listening")
    ? PASSIVE_OUTFIT_ASSETS[primaryPassiveAccessory]
    : undefined;
  const lifeActionAsset = lifeActionBase ? `${lifeActionBase}/${String(renderedFrame).padStart(2, "0")}.png` : undefined;
  const staticAsset = lifeActionAsset ?? ACCESSORY_STATIC_ASSETS[`${asset.accessory}:${resolvedMood}`]
    ?? passiveOutfitAsset
    ?? STATIC_ASSETS[resolvedMood]
    ?? (reduceMotion ? REDUCED_MOTION_ASSETS[resolvedMood] : undefined);
  const assetGeometry = staticAsset ? SUPPLEMENTAL_GEOMETRY[staticAsset] : undefined;
  useEffect(() => {
    const sequence = activeActionFrames ?? animation?.durations.map((_, index) => index) ?? [];
    setFrame(sequence[0] ?? 0);
    if (frameOverride !== undefined || reduceMotion || sequence.length < 2) return;
    const shouldLoop = activeActionFrames
      ? actionPhase === "holding" && !ONE_SHOT_LIFE_ACTIONS.has(lifeAction ?? "read")
      : animation?.loop !== false;
    let cancelled = false;
    let timer = 0;
    const advance = (position: number) => {
      const current = sequence[position] ?? sequence[0] ?? 0;
      timer = window.setTimeout(() => {
        if (cancelled) return;
        const nextPosition = position + 1;
        if (nextPosition >= sequence.length) {
          if (!shouldLoop) {
            // A supplemental life action owns its own frame sequence. Reusing
            // the underlying mood atlas holdFrame can jump it backwards after
            // the one-shot story completes (success uses frame 3, while the
            // watering action must settle on frame 5).
            setFrame(activeActionFrames ? current : animation?.holdFrame ?? current);
            return;
          }
          setFrame(sequence[0] ?? 0);
          advance(0);
          return;
        }
        setFrame(sequence[nextPosition] ?? current);
        advance(nextPosition);
      }, lifeActionBase ? LIFE_ACTION_DURATIONS[current] : animation?.durations[current] ?? 180);
    };
    advance(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [actionPhase, activeActionFrames, animation, frameOverride, lifeAction, lifeActionBase, reduceMotion]);

  const row = animation?.row ?? 0;
  const column = frameOverride ?? renderedFrame;
  const spriteStyle = {
    backgroundImage: `url(${ATLAS_PATH})`,
    backgroundPosition: `${column / 7 * 100}% ${row / 10 * 100}%`,
  } as React.CSSProperties;
  const basePoseContent = staticAsset ? (
    <>
      <Image
        src={staticAsset}
        alt=""
        width={256}
        height={256}
        draggable={false}
        priority={priority}
        sizes={`${size}px`}
        unoptimized
        style={assetGeometry ? {
          "--pilo-visual-scale": assetGeometry.scale,
          "--pilo-visual-offset-y": `${assetGeometry.offsetY * 100}%`,
        } as React.CSSProperties : undefined}
      />
      {canShowPassiveCombination && passiveAccessories.slice(1).map((item) => (
        <Image
          className={`pilo-avatar__outfit-layer ${PASSIVE_OUTFIT_LAYER_CLASS[item] ?? ""}`}
          src={PASSIVE_OUTFIT_ASSETS[item]!}
          alt=""
          width={256}
          height={256}
          draggable={false}
          sizes={`${size}px`}
          unoptimized
          key={item}
        />
      ))}
    </>
  ) : (
    <span className="pilo-avatar__sprite" style={spriteStyle} aria-hidden="true" />
  );
  const poseContent = (
    <>
      {basePoseContent}
      {canLayerPassiveAccessories && passiveAccessories.map((item) => (
        <Image
          className={`pilo-avatar__outfit-layer ${PASSIVE_OUTFIT_LAYER_CLASS[item] ?? ""}`}
          src={PASSIVE_OUTFIT_ASSETS[item]!}
          alt=""
          width={256}
          height={256}
          draggable={false}
          sizes={`${size}px`}
          unoptimized
          key={`life-${item}`}
        />
      ))}
    </>
  );

  return (
    <span
      className={`pilo-avatar pilo-avatar--${resolvedMood} ${illuminated ? "is-illuminated" : ""} ${className}`.trim()}
      style={{ "--pilo-size": `${size}px` } as React.CSSProperties}
      role="img"
      aria-label={lifeAction && LIFE_ACTION_COPY[lifeAction] ? LIFE_ACTION_COPY[lifeAction] : MOOD_COPY[resolvedMood]}
      data-pilo-mood={resolvedMood}
      data-pilo-accessory={canShowPassiveCombination || canLayerPassiveAccessories ? passiveAccessories.join(" ") : asset.accessory}
      data-pilo-asset-coverage={asset.coverage}
      data-pilo-frame={column}
      data-pilo-life-action={lifeAction ?? "none"}
      title={asset.coverage === "fallback" ? asset.reason : undefined}
      data-pilo-atlas-state={staticAsset ? "supplemental" : atlasState ?? "supplemental"}
      data-pilo-motion-semantic={staticAsset ? lifeAction ?? resolvedMood : atlasState ? MOTION_SEMANTIC[atlasState] : resolvedMood}
      data-pilo-visual-scale={assetGeometry?.scale ?? 1}
    >
      <motion.span
        className="pilo-avatar__body"
        initial={false}
        animate={{ y: 0 }}
        transition={{ duration: 0 }}
      >
        <motion.span
          className="pilo-avatar__pose"
          initial={false}
          animate={{ opacity: 1 }}
          transition={{ duration: instant || reduceMotion ? 0 : .08, ease: "linear" }}
        >
          {poseContent}
        </motion.span>
      </motion.span>
      <span className="pilo-avatar__aura" aria-hidden="true" />
      <span className="pilo-avatar__chest-glow" aria-hidden="true" />
      <span className="pilo-avatar__status" aria-hidden="true" />
    </span>
  );
}
