"use client";

import { Check, ChevronDown, Clock3 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const CLOCK_HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const CLOCK_MINUTES = Array.from({ length: 12 }, (_, step) => String(step * 5).padStart(2, "0"));

export function normalizeClockValue(value: string): string | null {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  const candidate = /^\d{3,4}$/.test(digits)
    ? `${digits.slice(0, -2).padStart(2, "0")}:${digits.slice(-2)}`
    : trimmed;
  const match = candidate.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function formatClockDraft(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

type ClockTimePickerProps = {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  align?: "start" | "end";
  variant?: "compact" | "form";
  autoFocus?: boolean;
};

export function ClockTimePicker({
  ariaLabel,
  value,
  onChange,
  label,
  align = "start",
  variant = "compact",
  autoFocus = false,
}: ClockTimePickerProps) {
  const inputId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedHourRef = useRef<HTMLButtonElement>(null);
  const selectedMinuteRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [pendingHour, setPendingHour] = useState(value.slice(0, 2) || "18");
  const [pendingMinute, setPendingMinute] = useState(value.slice(3, 5) || "00");

  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const alignSelectedOptions = () => {
      for (const option of [selectedHourRef.current, selectedMinuteRef.current]) {
        const list = option?.parentElement;
        if (!option || !list) continue;
        list.scrollTop = option.offsetTop - list.offsetTop;
      }
    };

    // Align once before paint so consumers never observe the list at scrollTop
    // zero, then repeat after the opening layout/animation has settled.
    alignSelectedOptions();
    const frame = window.requestAnimationFrame(alignSelectedOptions);
    return () => window.cancelAnimationFrame(frame);
  }, [open, pendingHour, pendingMinute]);

  function openPicker() {
    const parsed = normalizeClockValue(draft) ?? value;
    setPendingHour(parsed.slice(0, 2) || "18");
    setPendingMinute(parsed.slice(3, 5) || "00");
    setOpen((current) => !current);
  }

  function commitManualValue() {
    const normalized = normalizeClockValue(draft);
    if (!normalized) {
      setDraft(value);
      return;
    }
    setDraft(normalized);
    onChange(normalized);
  }

  function applyPickedTime() {
    const next = `${pendingHour}:${pendingMinute}`;
    setDraft(next);
    onChange(next);
    setOpen(false);
  }

  const minuteOptions = CLOCK_MINUTES.includes(pendingMinute)
    ? CLOCK_MINUTES
    : [...CLOCK_MINUTES, pendingMinute].sort((a, b) => Number(a) - Number(b));

  return <div
    className={`clock-time-picker availability-time-field is-${align} is-${variant}`}
    ref={rootRef}
  >
    {label && <label htmlFor={inputId} className="availability-time-label">{label}</label>}
    <div className="availability-time-control">
      <span className="availability-time-input">
        <input
          id={inputId}
          aria-label={ariaLabel}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={5}
          placeholder="00:00"
          value={draft}
          autoFocus={autoFocus}
          onChange={(event) => setDraft(formatClockDraft(event.target.value))}
          onBlur={commitManualValue}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Backspace" && event.currentTarget.selectionStart === 3 && event.currentTarget.selectionEnd === 3) {
              event.preventDefault();
              event.currentTarget.setSelectionRange(2, 2);
            }
            if (event.key === "Delete" && event.currentTarget.selectionStart === 2 && event.currentTarget.selectionEnd === 2) {
              event.preventDefault();
              event.currentTarget.setSelectionRange(3, 3);
            }
            if (event.key === "ArrowDown" && event.altKey) {
              event.preventDefault();
              openPicker();
            }
          }}
        />
      </span>
      <button
        type="button"
        className="availability-time-picker-trigger"
        aria-label={`选择${ariaLabel}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={openPicker}
      ><ChevronDown size={15} /></button>
      {open && <div
        className="availability-time-popover"
        role="dialog"
        aria-label={`选择${ariaLabel}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <header><span><Clock3 size={14} />选择时间</span><strong>{pendingHour}:{pendingMinute}</strong></header>
        <div className="availability-time-columns">
          <section aria-label="选择小时"><span>小时</span><div className="availability-time-options">
            {CLOCK_HOURS.map((hour) => <button
              type="button"
              key={hour}
              ref={pendingHour === hour ? selectedHourRef : undefined}
              aria-label={`${hour} 时`}
              aria-pressed={pendingHour === hour}
              className={pendingHour === hour ? "is-selected" : ""}
              onClick={() => setPendingHour(hour)}
            >{hour}</button>)}
          </div></section>
          <section aria-label="选择分钟"><span>分钟</span><div className="availability-time-options">
            {minuteOptions.map((minute) => <button
              type="button"
              key={minute}
              ref={pendingMinute === minute ? selectedMinuteRef : undefined}
              aria-label={`${minute} 分`}
              aria-pressed={pendingMinute === minute}
              className={pendingMinute === minute ? "is-selected" : ""}
              onClick={() => setPendingMinute(minute)}
            >{minute}</button>)}
          </div></section>
        </div>
        <footer>
          <small>也可以直接键入时间</small>
          <span className="availability-time-actions">
            <button type="button" className="is-cancel" onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="is-apply" onClick={applyPickedTime}><Check size={13} />应用时间</button>
          </span>
        </footer>
      </div>}
    </div>
  </div>;
}
