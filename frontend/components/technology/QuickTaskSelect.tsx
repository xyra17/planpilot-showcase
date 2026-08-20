"use client";

import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, Flag, Target, Timer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export type QuickTaskSelectOption = {
  value: string;
  label: string;
  description: string;
  tone?: "high" | "medium" | "low";
};

type QuickTaskSelectProps = {
  ariaLabel: string;
  kind: "goal" | "duration" | "priority";
  menuLabel: string;
  options: QuickTaskSelectOption[];
  value: string;
  onValueChange: (value: string) => void;
};

function OptionMark({ kind, option }: { kind: QuickTaskSelectProps["kind"]; option: QuickTaskSelectOption }) {
  if (kind === "priority") {
    return <span className={`quick-task-select-dot is-${option.tone ?? "medium"}`} aria-hidden="true" />;
  }

  if (kind === "duration") {
    return <span className="quick-task-select-minutes" aria-hidden="true">{Number.parseInt(option.value, 10)}</span>;
  }

  return <span className="quick-task-select-goal-mark" aria-hidden="true"><Target size={14} /></span>;
}

export function QuickTaskSelect({
  ariaLabel,
  kind,
  menuLabel,
  options,
  value,
  onValueChange,
}: QuickTaskSelectProps) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const current = useMemo(
    () => options.find((option) => option.value === value) ?? options[0],
    [options, value],
  );

  useEffect(() => {
    setPortalContainer(document.querySelector<HTMLElement>(".app-shell"));
  }, []);

  return (
    <Select.Root value={current?.value ?? ""} onValueChange={onValueChange}>
      <Select.Trigger
        className={`quick-task-select-trigger is-${kind}`}
        aria-label={ariaLabel}
      >
        <span className="quick-task-select-trigger-value">
          {kind === "priority" && current ? <OptionMark kind={kind} option={current} /> : null}
          <span>{current?.label ?? "暂无可选项"}</span>
        </span>
        <Select.Icon asChild><ChevronDown size={15} aria-hidden="true" /></Select.Icon>
      </Select.Trigger>

      <Select.Portal container={portalContainer ?? undefined}>
        <Select.Content
          className={`quick-task-select-content is-${kind}`}
          position="popper"
          sideOffset={7}
          align="start"
          collisionPadding={12}
          aria-label={menuLabel}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.stopPropagation();
          }}
        >
          <div className="quick-task-select-heading" aria-hidden="true">
            <span>{kind === "goal" ? <Target size={14} /> : kind === "duration" ? <Timer size={14} /> : <Flag size={14} />}</span>
            <strong>{menuLabel}</strong>
          </div>
          <Select.Viewport className="quick-task-select-viewport">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                className={`quick-task-select-option${option.tone ? ` is-${option.tone}` : ""}`}
              >
                <OptionMark kind={kind} option={option} />
                <Select.ItemText asChild>
                  <span className="quick-task-select-option-copy">
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </Select.ItemText>
                <Select.ItemIndicator className="quick-task-select-check">
                  <Check size={14} aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
