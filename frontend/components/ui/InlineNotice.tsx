import type { HTMLAttributes, ReactNode } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

import { cn } from "@/lib/utils";
import type { StatusTone } from "./StatusBadge";

type InlineNoticeProps = HTMLAttributes<HTMLDivElement> & {
  tone?: Exclude<StatusTone, "progress">;
  title?: string;
  icon?: ReactNode;
  action?: ReactNode;
};

const ICONS = {
  neutral: Info,
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
};

export function InlineNotice({
  tone = "info",
  title,
  icon,
  action,
  className,
  children,
  ...props
}: InlineNoticeProps) {
  const Icon = ICONS[tone];
  return (
    <div
      className={cn("pp-inline-notice", `pp-tone-${tone}`, className)}
      role={tone === "danger" ? "alert" : "status"}
      {...props}
    >
      <span className="pp-inline-notice-icon" aria-hidden="true">
        {icon ?? <Icon size={16} />}
      </span>
      <div className="pp-inline-notice-content">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action && <div className="pp-inline-notice-action">{action}</div>}
    </div>
  );
}
