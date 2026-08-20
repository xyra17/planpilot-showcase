"use client";

import { signalPiloState } from "@/lib/technology/piloState";
import { readScopedJson, writeScopedJson } from "@/lib/technology/scopedStorage";

export const PRODUCT_STORAGE_KEYS = {
  tasks: "planpilot-v2-tasks",
  goals: "planpilot-v2-goals",
  notes: "planpilot-v2-notes",
} as const;

export const PRODUCT_DATA_EVENT = "planpilot:data-updated";

export function readProductArray<T>(key: string, fallback: T[]): T[] {
  const parsed = readScopedJson<T[]>(key, null, fallback, key);
  return Array.isArray(parsed) ? parsed : fallback;
}

export function writeProductArray<T>(key: string, value: T[], options: { notifyPilo?: boolean } = {}) {
  if (typeof window === "undefined") return;

  writeScopedJson(key, null, value, key);
  window.dispatchEvent(
    new CustomEvent(PRODUCT_DATA_EVENT, {
      detail: { key },
    }),
  );
  if (options.notifyPilo) signalPiloState("success", { source: key, duration: 3_400 });
}
