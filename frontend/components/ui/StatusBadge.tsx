import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type StatusTone = "neutral" | "info" | "progress" | "success" | "warning" | "danger";

type StatusBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: StatusTone;
  icon?: ReactNode;
  pulse?: boolean;
  compact?: boolean;
};

export function StatusBadge({
  tone = "neutral",
  icon,
  pulse = false,
  compact = false,
  className,
  children,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "pp-status-badge",
        `pp-tone-${tone}`,
        compact && "is-compact",
        className
      )}
      data-tone={tone}
      {...props}
    >
      {icon ?? <span className={cn("pp-status-dot", pulse && "is-pulsing")} aria-hidden="true" />}
      <span>{children}</span>
    </span>
  );
}
