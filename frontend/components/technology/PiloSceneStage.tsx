"use client";

import { Activity, ArrowRight, BookOpen, Laptop, Moon, SunMedium, Utensils, X } from "lucide-react";
import { motion } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { PiloSceneId, PiloScenePresentation } from "@/lib/technology/piloScenes";
import type { PiloActionPhase } from "@/lib/technology/piloRhythm";
import type { PiloAccessory } from "@/lib/technology/piloState";

const SCENE_ICONS = {
  morning: SunMedium,
  focus: Laptop,
  lunch: Utensils,
  dinner: Utensils,
  movement: Activity,
  review: BookOpen,
  night: Moon,
} as const;

const SCENE_ASSETS: Record<PiloSceneId, readonly [string, string]> = {
  morning: ["/pilo/scenes/v4/morning-01.webp", "/pilo/scenes/v4/morning-02.webp"],
  focus: ["/pilo/scenes/v4/focus-01.webp", "/pilo/scenes/v4/focus-02.webp"],
  lunch: ["/pilo/scenes/v4/lunch-01.webp", "/pilo/scenes/v4/lunch-02.webp"],
  dinner: ["/pilo/scenes/v4/dinner-01.webp", "/pilo/scenes/v4/dinner-02.webp"],
  movement: ["/pilo/scenes/v4/movement-01.webp", "/pilo/scenes/v4/movement-02.webp"],
  review: ["/pilo/scenes/v4/review-01.webp", "/pilo/scenes/v4/review-02.webp"],
  night: ["/pilo/scenes/v4/night-01.webp", "/pilo/scenes/v4/night-02.webp"],
};

type ScenePhase = "entering" | "holding" | "leaving";

function SceneArt({
  scene,
  phase,
  reduceMotion,
  onOpenCompanion,
}: {
  scene: PiloScenePresentation;
  phase: ScenePhase;
  reduceMotion: boolean;
  onOpenCompanion: () => void;
}) {
  const [baseFrame, alternateFrame] = SCENE_ASSETS[scene.id];
  return (
    <motion.button
      type="button"
      className="pilo-scene__visual"
      data-phase={phase}
      onClick={onOpenCompanion}
      aria-label={`和${scene.eyebrow}场景里的 Pilo 聊聊`}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: phase === "leaving" ? 0 : 1 }}
      transition={{ duration: reduceMotion ? 0 : phase === "leaving" ? .2 : .4 }}
    >
      <Image
        className="pilo-scene__frame pilo-scene__frame--base"
        src={baseFrame}
        alt=""
        fill
        sizes="(max-width: 420px) calc(100vw - 20px), 390px"
        priority={false}
      />
      <Image
        className="pilo-scene__frame pilo-scene__frame--alternate"
        src={alternateFrame}
        alt=""
        fill
        sizes="(max-width: 420px) calc(100vw - 20px), 390px"
        priority={false}
        aria-hidden="true"
      />
      <span className="pilo-scene__light" />
      {(scene.id === "lunch" || scene.id === "dinner") && <span className="pilo-scene__steam"><i /><i /></span>}
      <span className="pilo-scene__chat-hint">点击场景和 Pilo 聊聊</span>
    </motion.button>
  );
}

export function PiloSceneStage({
  scene,
  reduceMotion,
  onDismiss,
  onDisableTonight,
  onAction,
  onOpenCompanion,
  onOpenSettings,
}: {
  scene: PiloScenePresentation;
  reduceMotion: boolean;
  onDismiss: () => void;
  onDisableTonight: () => void;
  onAction: () => void;
  onOpenCompanion: () => void;
  onOpenSettings: (clientX: number, clientY: number) => void;
  accessories: readonly PiloAccessory[];
  actionPhase: PiloActionPhase;
}) {
  const Icon = SCENE_ICONS[scene.id];
  const [phase, setPhase] = useState<ScenePhase>(reduceMotion ? "holding" : "entering");
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduceMotion) {
      setPhase("holding");
      return;
    }
    const timer = window.setTimeout(() => setPhase("holding"), 520);
    return () => window.clearTimeout(timer);
  }, [reduceMotion, scene.id]);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  const leaveThen = (callback: () => void) => {
    if (closeTimerRef.current) return;
    if (reduceMotion) {
      callback();
      return;
    }
    setPhase("leaving");
    closeTimerRef.current = window.setTimeout(callback, 300);
  };

  const action = scene.href ? (
    <Link className="pilo-scene__primary" href={scene.href} onClick={onAction}>
      <span>{scene.actionLabel}</span><ArrowRight size={13} />
    </Link>
  ) : (
    <button type="button" className="pilo-scene__primary" onClick={onAction}>
      <span>{scene.actionLabel}</span><ArrowRight size={13} />
    </button>
  );

  return (
    <motion.section
      className={`pilo-scene pilo-scene--${scene.id}`}
      data-pilo-scene={scene.id}
      data-reduce-motion={reduceMotion ? "true" : "false"}
      aria-label={`Pilo ${scene.eyebrow}`}
      aria-live="polite"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 7 }}
      transition={{ duration: reduceMotion ? 0 : .26, ease: [0.22, 1, 0.36, 1] }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenSettings(event.clientX, event.clientY);
      }}
    >
      <SceneArt
        scene={scene}
        phase={phase}
        reduceMotion={reduceMotion}
        onOpenCompanion={onOpenCompanion}
      />
      <div className="pilo-scene__copy">
        <div className="pilo-scene__message">
          <span className="pilo-scene__eyebrow"><Icon size={14} />{scene.eyebrow}</span>
          <p>{scene.message}</p>
        </div>
        <div className="pilo-scene__actions">
          {action}
          {scene.id === "night" ? (
            <button type="button" className="pilo-scene__later" onClick={() => leaveThen(onDisableTonight)}>今晚不再提醒</button>
          ) : (
            <button type="button" className="pilo-scene__later" onClick={() => leaveThen(onDismiss)}>稍后</button>
          )}
        </div>
      </div>
      <button type="button" className="pilo-scene__close" onClick={() => leaveThen(onDismiss)} aria-label={`关闭${scene.eyebrow}`}><X size={16} /></button>
    </motion.section>
  );
}
