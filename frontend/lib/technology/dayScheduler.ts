export type ScheduleStrategy = "balanced" | "compact";
export type ScheduleOperation = "replan_all" | "replan_future" | "append_unscheduled";

export type ScheduleTimeRange = {
  startMinute: number;
  endMinute: number;
};

export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
export type AvailabilityClockRange = { start: string; end: string };
export type WeeklyAvailability = Partial<Record<WeekdayKey, AvailabilityClockRange[]>>;

type TimezoneDateParts = { year: number; month: number; day: number };

function datePartsInTimezone(timezone: string, now = new Date()): TimezoneDateParts {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    return {
      year: Number(parts.find((part) => part.type === "year")?.value ?? now.getFullYear()),
      month: Number(parts.find((part) => part.type === "month")?.value ?? now.getMonth() + 1),
      day: Number(parts.find((part) => part.type === "day")?.value ?? now.getDate()),
    };
  } catch {
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }
}

export function getIsoDateForTimezone(timezone: string, now = new Date()): string {
  const { year, month, day } = datePartsInTimezone(timezone, now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getWeekDatesForTimezone(timezone: string, now = new Date()): string[] {
  const { year, month, day } = datePartsInTimezone(timezone, now);
  const current = new Date(Date.UTC(year, month - 1, day));
  const weekday = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() - weekday + 1);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(current);
    date.setUTCDate(current.getUTCDate() + index);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  });
}

/** Return the Monday–Sunday range for an already-normalized local calendar date. */
export function getWeekDatesForIsoDate(isoDate: string): string[] {
  const [year, month, day] = isoDate.split("-").map(Number);
  const current = new Date(Date.UTC(year, month - 1, day));
  const weekday = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() - weekday + 1);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(current);
    date.setUTCDate(current.getUTCDate() + index);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  });
}

export type DayScheduleTask = {
  id: string;
  title: string;
  goalTitle: string;
  durationMinutes: number;
  priority: string;
  preferredStartMinute?: number;
  done: boolean;
};

export type DayScheduleBlock = {
  id: string;
  label: string;
  taskId?: string;
  goalTitle?: string;
  startHour: number;
  durationMinutes: number;
  color: string;
  progress: number;
};

export type UnscheduledTask = {
  taskId: string;
  reason: string;
};

export type DayScheduleRequest = {
  tasks: DayScheduleTask[];
  existingBlocks: DayScheduleBlock[];
  availability: ScheduleTimeRange[];
  operation: ScheduleOperation;
  strategy: ScheduleStrategy;
  nowMinute: number;
  colors: string[];
};

export type DayScheduleResult = {
  blocks: DayScheduleBlock[];
  scheduledTaskIds: string[];
  unscheduled: UnscheduledTask[];
};

const AVAILABILITY_PRESETS: Record<string, ScheduleTimeRange> = {
  early_morning: { startMinute: 6 * 60, endMinute: 9 * 60 },
  morning: { startMinute: 9 * 60, endMinute: 12 * 60 },
  afternoon: { startMinute: 13 * 60, endMinute: 18 * 60 },
  evening: { startMinute: 18 * 60, endMinute: 22 * 60 },
  late_night: { startMinute: 22 * 60, endMinute: 24 * 60 },
};

export const DEFAULT_AVAILABILITY: ScheduleTimeRange[] = [
  { startMinute: 9 * 60, endMinute: 11 * 60 },
  { startMinute: 14 * 60, endMinute: 16 * 60 },
  { startMinute: 20 * 60, endMinute: 22 * 60 },
];

function mergeRanges(ranges: ScheduleTimeRange[]): ScheduleTimeRange[] {
  const sorted = ranges
    .filter((range) => range.endMinute > range.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute);
  const merged: ScheduleTimeRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.startMinute <= previous.endMinute) {
      previous.endMinute = Math.max(previous.endMinute, range.endMinute);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function availabilityFromPreferences(preferences?: string[]): ScheduleTimeRange[] {
  if (!preferences?.length) return DEFAULT_AVAILABILITY.map((range) => ({ ...range }));
  const ranges = preferences
    .map((preference) => AVAILABILITY_PRESETS[preference])
    .filter((range): range is ScheduleTimeRange => Boolean(range));
  return ranges.length ? mergeRanges(ranges) : DEFAULT_AVAILABILITY.map((range) => ({ ...range }));
}

function minuteToClock(minute: number): string {
  if (minute >= 24 * 60) return "23:59";
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function weeklyAvailabilityFromPreferences(
  preferences?: string[],
  studyDays: string[] = [...WEEKDAY_KEYS],
): WeeklyAvailability {
  const ranges = availabilityFromPreferences(preferences).map((range) => ({
    start: minuteToClock(range.startMinute),
    end: minuteToClock(range.endMinute),
  }));
  return Object.fromEntries(
    WEEKDAY_KEYS.map((day) => [day, studyDays.includes(day) ? ranges.map((range) => ({ ...range })) : []]),
  ) as WeeklyAvailability;
}

export function clockToMinute(value: string): number | undefined {
  return parseTimeToMinute(value);
}

export function availabilityFromClockRanges(ranges?: AvailabilityClockRange[]): ScheduleTimeRange[] {
  return mergeRanges((ranges ?? []).flatMap((range) => {
    const startMinute = clockToMinute(range.start);
    const endMinute = clockToMinute(range.end);
    return startMinute === undefined || endMinute === undefined || endMinute <= startMinute
      ? []
      : [{ startMinute, endMinute }];
  }));
}

export function getWeekdayKey(timezone: string, now = new Date()): WeekdayKey {
  try {
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" })
      .format(now)
      .toLowerCase();
    return WEEKDAY_KEYS.find((day) => weekday.startsWith(day)) ?? "mon";
  } catch {
    return WEEKDAY_KEYS[(now.getDay() + 6) % 7];
  }
}

export function availabilityForToday(
  weeklyAvailability: WeeklyAvailability,
  timezone: string,
  now = new Date(),
): ScheduleTimeRange[] {
  return availabilityFromClockRanges(weeklyAvailability[getWeekdayKey(timezone, now)]);
}

/** Resolve a user's local calendar date without applying the server timezone. */
export function availabilityForDate(
  weeklyAvailability: WeeklyAvailability,
  isoDate: string,
): ScheduleTimeRange[] {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return [];
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  if (Number.isNaN(value.getTime())) return [];
  const weekday = WEEKDAY_KEYS[(value.getUTCDay() + 6) % 7];
  return availabilityFromClockRanges(weeklyAvailability[weekday]);
}

export function parseTimeToMinute(value: string): number | undefined {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

export function getCurrentMinute(timezone: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

function subtractOccupied(
  availability: ScheduleTimeRange[],
  blocks: DayScheduleBlock[],
  gapMinutes: number,
): ScheduleTimeRange[] {
  let free = availability.map((range) => ({ ...range }));
  const occupied = blocks
    .map((block) => ({
      startMinute: Math.round(block.startHour * 60),
      endMinute: Math.round(block.startHour * 60 + block.durationMinutes + gapMinutes),
    }))
    .sort((a, b) => a.startMinute - b.startMinute);

  for (const busy of occupied) {
    free = free.flatMap((range) => {
      if (busy.endMinute <= range.startMinute || busy.startMinute >= range.endMinute) return [range];
      const next: ScheduleTimeRange[] = [];
      if (busy.startMinute > range.startMinute) {
        next.push({ startMinute: range.startMinute, endMinute: busy.startMinute });
      }
      if (busy.endMinute < range.endMinute) {
        next.push({ startMinute: busy.endMinute, endMinute: range.endMinute });
      }
      return next;
    });
  }
  return free;
}

function taskPriority(priority: string): number {
  if (priority === "核心") return 0;
  if (priority === "低优先级" || priority === "复习" || priority === "整理") return 2;
  return 1;
}

function unscheduledReason(
  task: DayScheduleTask,
  free: ScheduleTimeRange[],
  availability: ScheduleTimeRange[],
  nowMinute: number,
): string {
  const latestEnd = availability.reduce((latest, range) => Math.max(latest, range.endMinute), 0);
  if (!availability.length || nowMinute >= latestEnd) return "今天的可用时段已经结束";
  const longestFree = free.reduce(
    (longest, range) => Math.max(longest, range.endMinute - range.startMinute),
    0,
  );
  if (longestFree < task.durationMinutes) {
    return `没有连续 ${task.durationMinutes} 分钟的空闲时间`;
  }
  return "与已有安排或期望开始时间冲突";
}

export function planDaySchedule(request: DayScheduleRequest): DayScheduleResult {
  const gapMinutes = request.strategy === "balanced" ? 10 : 0;
  const roundedNow = Math.ceil(request.nowMinute / 15) * 15;
  const availability = mergeRanges(request.availability)
    .map((range) => ({
      startMinute: Math.max(range.startMinute, roundedNow),
      endMinute: range.endMinute,
    }))
    .filter((range) => range.endMinute > range.startMinute);
  const existingTaskIds = new Set(
    request.existingBlocks.map((block) => block.taskId).filter((taskId): taskId is string => Boolean(taskId)),
  );
  const preservedBlocks = request.operation === "append_unscheduled"
    ? request.existingBlocks
    : request.operation === "replan_future"
      ? request.existingBlocks.filter((block) => Math.round(block.startHour * 60) < roundedNow)
      : [];
  const preservedTaskIds = new Set(
    preservedBlocks.map((block) => block.taskId).filter((taskId): taskId is string => Boolean(taskId)),
  );
  const candidates = request.tasks
    .filter((task) => !task.done)
    .filter((task) => !preservedTaskIds.has(task.id))
    .filter((task) => request.operation !== "append_unscheduled" || !existingTaskIds.has(task.id))
    .sort((a, b) => {
      const preferredDifference = Number(b.preferredStartMinute !== undefined) - Number(a.preferredStartMinute !== undefined);
      if (preferredDifference) return preferredDifference;
      const priorityDifference = taskPriority(a.priority) - taskPriority(b.priority);
      if (priorityDifference) return priorityDifference;
      return b.durationMinutes - a.durationMinutes;
    });

  const plannedBlocks: DayScheduleBlock[] = [];
  const scheduledTaskIds: string[] = [];
  const unscheduled: UnscheduledTask[] = [];

  for (const task of candidates) {
    const free = subtractOccupied(availability, [...preservedBlocks, ...plannedBlocks], gapMinutes);
    const preferred = task.preferredStartMinute;
    const preferredRange = preferred === undefined
      ? undefined
      : free.find((range) => preferred >= range.startMinute && preferred + task.durationMinutes <= range.endMinute);
    const target = preferredRange
      ? { range: preferredRange, startMinute: preferred! }
      : free
          .filter((range) => range.endMinute - range.startMinute >= task.durationMinutes)
          .map((range) => ({ range, startMinute: range.startMinute }))
          .sort((a, b) => {
            const aWaste = a.range.endMinute - a.startMinute - task.durationMinutes;
            const bWaste = b.range.endMinute - b.startMinute - task.durationMinutes;
            return aWaste - bWaste || a.startMinute - b.startMinute;
          })[0];

    if (!target) {
      const compactCanFit = request.strategy === "balanced"
        && subtractOccupied(availability, [...preservedBlocks, ...plannedBlocks], 0)
          .some((range) => range.endMinute - range.startMinute >= task.durationMinutes);
      unscheduled.push({
        taskId: task.id,
        reason: compactCanFit
          ? `均衡方式下空间不足，可切换紧凑方式安排`
          : unscheduledReason(task, free, availability, roundedNow),
      });
      continue;
    }

    plannedBlocks.push({
      id: `technology-schedule-${task.id}`,
      label: task.title,
      taskId: task.id,
      goalTitle: task.goalTitle,
      startHour: target.startMinute / 60,
      durationMinutes: task.durationMinutes,
      color: request.colors[(preservedBlocks.length + plannedBlocks.length) % request.colors.length],
      progress: 0,
    });
    scheduledTaskIds.push(task.id);
  }

  return {
    blocks: [...preservedBlocks, ...plannedBlocks].sort((a, b) => a.startHour - b.startHour),
    scheduledTaskIds,
    unscheduled,
  };
}
