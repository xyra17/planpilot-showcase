import type { PiloLifeActionId, PiloStateLayer, PiloSystemState } from "@/lib/technology/piloState";

export const PILO_PRESENCE_LOG_KEY = "pp-pilo-presence-log-v1";

export type PiloPresenceKind = "scene" | "suggestion" | "action";

export type PiloPresenceEntry = {
  id: string;
  at: number;
  kind: PiloPresenceKind;
  title: string;
  reason: string;
  state?: PiloSystemState;
  layer?: PiloStateLayer;
  lifeAction?: PiloLifeActionId;
};

export type PiloPresenceLog = {
  day: string;
  entries: PiloPresenceEntry[];
};

export function piloPresenceDay(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function normalizePiloPresenceLog(value: Partial<PiloPresenceLog> | null | undefined, now = Date.now()): PiloPresenceLog {
  const day = piloPresenceDay(now);
  if (!value || value.day !== day || !Array.isArray(value.entries)) return { day, entries: [] };
  return {
    day,
    entries: value.entries
      .filter((entry): entry is PiloPresenceEntry => Boolean(entry?.id && entry?.at && entry?.title && entry?.reason))
      .slice(-24),
  };
}

export function recordPiloPresence(log: PiloPresenceLog, entry: PiloPresenceEntry, now = Date.now()): PiloPresenceLog {
  const current = normalizePiloPresenceLog(log, now);
  const latest = current.entries[current.entries.length - 1];
  if (latest?.id === entry.id && now - latest.at < 30_000) return current;
  return { day: current.day, entries: [...current.entries, entry].slice(-24) };
}

export function piloPresenceSummary(log: PiloPresenceLog) {
  const counts = log.entries.reduce((summary, entry) => {
    summary[entry.kind] += 1;
    return summary;
  }, { scene: 0, suggestion: 0, action: 0 });
  return {
    ...counts,
    total: log.entries.length,
    // The overview is a truthful daily timeline. Keep every retained entry
    // instead of reporting the full count while only exposing four rows.
    recent: [...log.entries].reverse(),
  };
}
