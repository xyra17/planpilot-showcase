"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

type ColumnBoundary = "name-goal" | "goal-date" | "date-end";
type ColumnWidths = { name: number; goal: number; date: number };

const STORAGE_KEY = "planpilot:knowledge-resource-columns:v1";
const DEFAULT_RATIOS: ColumnWidths = { name: 1.75, goal: 0.75, date: 0.34 };
const MIN_WIDTHS: ColumnWidths = { name: 220, goal: 140, date: 86 };

type ResourceColumnStyle = CSSProperties & {
  "--knowledge-resource-name-track": string;
  "--knowledge-resource-goal-track": string;
  "--knowledge-resource-date-track": string;
};

function normalizeRatios(widths: ColumnWidths): ColumnWidths {
  const total = widths.name + widths.goal + widths.date;
  if (!Number.isFinite(total) || total <= 0) return DEFAULT_RATIOS;
  return {
    name: widths.name / total,
    goal: widths.goal / total,
    date: widths.date / total,
  };
}

function readSavedRatios(): ColumnWidths {
  if (typeof window === "undefined") return DEFAULT_RATIOS;
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ColumnWidths> | null;
    if (!saved || ![saved.name, saved.goal, saved.date].every((value) => typeof value === "number" && value > 0)) {
      return DEFAULT_RATIOS;
    }
    return normalizeRatios(saved as ColumnWidths);
  } catch {
    return DEFAULT_RATIOS;
  }
}

function measureColumns(header: HTMLDivElement | null): ColumnWidths | null {
  if (!header) return null;
  const cells = header.children;
  if (cells.length < 4) return null;
  return {
    name: cells[1].getBoundingClientRect().width,
    goal: cells[2].getBoundingClientRect().width,
    date: cells[3].getBoundingClientRect().width,
  };
}

function resizeWidths(boundary: ColumnBoundary, widths: ColumnWidths, requestedDelta: number): ColumnWidths {
  const next = { ...widths };
  const [growing, compensating]: [keyof ColumnWidths, keyof ColumnWidths] = boundary === "name-goal"
    ? ["name", "goal"]
    : boundary === "goal-date"
      ? ["goal", "date"]
      : ["date", "goal"];
  const delta = Math.max(
    MIN_WIDTHS[growing] - widths[growing],
    Math.min(widths[compensating] - MIN_WIDTHS[compensating], requestedDelta),
  );
  next[growing] += delta;
  next[compensating] -= delta;
  return next;
}

export function useResourceTableColumns() {
  const headerRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ boundary: ColumnBoundary; startX: number; widths: ColumnWidths } | null>(null);
  const [ratios, setRatios] = useState<ColumnWidths>(DEFAULT_RATIOS);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [activeBoundary, setActiveBoundary] = useState<ColumnBoundary | null>(null);

  const applyWidths = useCallback((widths: ColumnWidths) => {
    setRatios(normalizeRatios(widths));
  }, []);

  const startResize = useCallback((boundary: ColumnBoundary, event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    const widths = measureColumns(headerRef.current);
    if (!widths) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = { boundary, startX: event.clientX, widths };
    setActiveBoundary(boundary);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resizeByKeyboard = useCallback((boundary: ColumnBoundary, event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const widths = measureColumns(headerRef.current);
    if (!widths) return;
    event.preventDefault();
    const step = event.shiftKey ? 24 : 8;
    applyWidths(resizeWidths(boundary, widths, event.key === "ArrowRight" ? step : -step));
  }, [applyWidths]);

  const resetColumns = useCallback(() => {
    setRatios(DEFAULT_RATIOS);
  }, []);

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      applyWidths(resizeWidths(resize.boundary, resize.widths, event.clientX - resize.startX));
    };
    const finish = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      setActiveBoundary(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (resizeRef.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, [applyWidths]);

  useEffect(() => {
    setRatios(readSavedRatios());
    setPreferencesLoaded(true);
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeRatios(ratios)));
  }, [preferencesLoaded, ratios]);

  const tableStyle = useMemo<ResourceColumnStyle>(() => ({
    "--knowledge-resource-name-track": `minmax(${MIN_WIDTHS.name}px, ${ratios.name}fr)`,
    "--knowledge-resource-goal-track": `minmax(${MIN_WIDTHS.goal}px, ${ratios.goal}fr)`,
    "--knowledge-resource-date-track": `minmax(${MIN_WIDTHS.date}px, ${ratios.date}fr)`,
  }), [ratios]);

  return {
    activeBoundary,
    headerRef,
    resetColumns,
    resizeByKeyboard,
    startResize,
    tableStyle,
  };
}

type ResizeHandleProps = {
  active: boolean;
  boundary: ColumnBoundary;
  headerRef: RefObject<HTMLDivElement>;
  label: string;
  onDoubleClick: () => void;
  onKeyDown: (boundary: ColumnBoundary, event: KeyboardEvent<HTMLSpanElement>) => void;
  onPointerDown: (boundary: ColumnBoundary, event: PointerEvent<HTMLSpanElement>) => void;
};

export function ResourceColumnResizeHandle({
  active,
  boundary,
  headerRef,
  label,
  onDoubleClick,
  onKeyDown,
  onPointerDown,
}: ResizeHandleProps) {
  const currentWidths = measureColumns(headerRef.current);
  const value = boundary === "name-goal"
    ? currentWidths?.name
    : boundary === "goal-date"
      ? currentWidths?.goal
      : currentWidths?.date;

  return (
    <span
      className={`knowledge-column-resize-handle ${active ? "is-active" : ""}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={value ? Math.round(value) : undefined}
      tabIndex={0}
      title="拖动调整列宽，双击恢复默认"
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDoubleClick();
      }}
      onKeyDown={(event) => onKeyDown(boundary, event)}
      onPointerDown={(event) => onPointerDown(boundary, event)}
    />
  );
}
