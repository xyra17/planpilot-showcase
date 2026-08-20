"use client";

import { BrainCircuit } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "pp-coach-fab-pos";
const SIZE = 44;
const MARGIN = 10;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * CoachFAB — 可拖动浮动学习伙伴入口。
 * 仅在工作区（work 模式）中显示，进入学习伙伴模式后自动隐藏。
 * 拖动可自由定位，位置保存至 localStorage；
 * 未拖动时点击跳转至科技工作台的学习伙伴页。
 */
export function CoachFAB() {
  const pathname = usePathname();
  const router = useRouter();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const hasMoved = useRef(false);
  const origin = useRef({ px: 0, py: 0, x: 0, y: 0 });

  const isCoachMode = pathname.startsWith("/studio/coach");

  useEffect(() => {
    const defaultPos = {
      x: window.innerWidth - SIZE - MARGIN - 20,
      y: window.innerHeight - SIZE - MARGIN - 20,
    };
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const p = JSON.parse(saved) as { x: number; y: number };
        setPos({
          x: clamp(p.x, MARGIN, window.innerWidth - SIZE - MARGIN),
          y: clamp(p.y, MARGIN, window.innerHeight - SIZE - MARGIN),
        });
        return;
      }
    } catch {}
    setPos(defaultPos);
  }, []);

  const snap = useCallback(
    (x: number, y: number) => ({
      x: clamp(x, MARGIN, window.innerWidth - SIZE - MARGIN),
      y: clamp(y, MARGIN, window.innerHeight - SIZE - MARGIN),
    }),
    []
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      dragging.current = true;
      hasMoved.current = false;
      origin.current = {
        px: e.clientX,
        py: e.clientY,
        x: pos?.x ?? window.innerWidth - SIZE - MARGIN - 20,
        y: pos?.y ?? window.innerHeight - SIZE - MARGIN - 20,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [pos]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!dragging.current) return;
      const dx = e.clientX - origin.current.px;
      const dy = e.clientY - origin.current.py;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) hasMoved.current = true;
      setPos(snap(origin.current.x + dx, origin.current.y + dy));
    },
    [snap]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      if (!hasMoved.current) {
        router.push("/studio/coach");
      } else {
        const dx = e.clientX - origin.current.px;
        const dy = e.clientY - origin.current.py;
        const final = snap(origin.current.x + dx, origin.current.y + dy);
        setPos(final);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(final));
        } catch {}
      }
    },
    [router, snap]
  );

  if (isCoachMode || pos === null) return null;

  return (
    <button
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      aria-label="打开学习伙伴"
      title="学习伙伴"
      className="coach-fab fixed z-40 flex items-center justify-center rounded-full text-white select-none touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2"
      style={{
        left: pos.x,
        top: pos.y,
        width: SIZE,
        height: SIZE,
        background: "linear-gradient(135deg, var(--pp-coach, #7657d8), #9a7ff0)",
        boxShadow: "0 4px 14px rgba(118, 87, 216, 0.38), 0 1px 4px rgba(0,0,0,0.10)",
        cursor: dragging.current ? "grabbing" : "grab",
      }}
    >
      <BrainCircuit size={16} />
    </button>
  );
}
