import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 px-5 text-center ${compact ? "py-8" : "py-14"}`}>
      {Icon && (
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100 text-gray-400">
          <Icon size={18} />
        </span>
      )}
      <p className="text-sm font-medium text-gray-600">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs leading-5 text-gray-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
