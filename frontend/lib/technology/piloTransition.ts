import { scopedStorageKey } from "@/lib/technology/scopedStorage";

export const PILO_COACH_TRANSITION_KEY = "pp-pilo-coach-transition-v2";

export type PiloCoachTransition = {
  createdAt: number;
  startX: number;
  startY: number;
};

const TRANSITION_TTL_MS = 4_000;

function transitionStorageKey() {
  if (typeof window === "undefined") return scopedStorageKey("pilo-coach-transition-v2", null);
  try {
    const cachedUser = JSON.parse(window.localStorage.getItem("user_info") ?? "null") as { id?: string } | null;
    return scopedStorageKey("pilo-coach-transition-v2", cachedUser?.id ?? null);
  } catch {
    return scopedStorageKey("pilo-coach-transition-v2", null);
  }
}

export function writePiloCoachTransition(transition: PiloCoachTransition) {
  if (typeof window === "undefined") return;
  const serialized = JSON.stringify(transition);
  const key = transitionStorageKey();
  window.sessionStorage.setItem(key, serialized);
  if (key.includes(":guest:")) window.sessionStorage.setItem(PILO_COACH_TRANSITION_KEY, serialized);
}

export function capturePiloCoachTransition() {
  if (typeof document === "undefined") return false;
  const source = document.querySelector<HTMLElement>(".pilo-companion__pet")?.getBoundingClientRect();
  if (!source) return false;
  writePiloCoachTransition({
    createdAt: Date.now(),
    startX: source.left + source.width / 2,
    startY: source.top + source.height / 2,
  });
  return true;
}

export function readPiloCoachTransition(): PiloCoachTransition | null {
  if (typeof window === "undefined") return null;
  try {
    const key = transitionStorageKey();
    const stored = window.sessionStorage.getItem(key)
      ?? (key.includes(":guest:") ? window.sessionStorage.getItem(PILO_COACH_TRANSITION_KEY) : null);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as PiloCoachTransition;
    if (
      !Number.isFinite(parsed.startX)
      || !Number.isFinite(parsed.startY)
      || !Number.isFinite(parsed.createdAt)
      || Date.now() - parsed.createdAt > TRANSITION_TTL_MS
    ) {
      clearPiloCoachTransition();
      return null;
    }
    return parsed;
  } catch {
    clearPiloCoachTransition();
    return null;
  }
}

export function clearPiloCoachTransition() {
  if (typeof window !== "undefined") {
    const key = transitionStorageKey();
    window.sessionStorage.removeItem(key);
    if (key.includes(":guest:")) window.sessionStorage.removeItem(PILO_COACH_TRANSITION_KEY);
  }
}
