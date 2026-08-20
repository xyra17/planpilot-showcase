"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type WorkspaceTab = {
  key: string;
  label: string;
  icon: LucideIcon;
};

export default function WorkspaceHeader({
  tabs,
  activeKey,
  onChange,
  actions,
}: {
  tabs: WorkspaceTab[];
  activeKey: string;
  onChange?: (key: string) => void;
  actions?: ReactNode;
}) {
  return (
    <header
      className="workspace-header flex flex-shrink-0 items-end justify-between gap-4 border-b-2 border-gray-200 bg-white px-6 pt-4"
      style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}
    >
      <nav className="flex min-w-0 items-center gap-1" aria-label="工作区导航">
        {tabs.map(({ key, label, icon: Icon }) => {
          const active = key === activeKey;
          const content = (
            <>
              <Icon size={17} />
              <span>{label}</span>
            </>
          );
          const className = `-mb-px flex items-center gap-2 whitespace-nowrap border-b-[3px] px-5 py-3 text-base font-semibold transition ${
            active ? "" : "border-transparent text-gray-500 hover:text-gray-700"
          }`;
          const style = active
            ? { borderColor: "var(--accent)", color: "var(--accent)" }
            : undefined;

          return onChange ? (
            <button
              key={key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onChange(key)}
              className={className}
              style={style}
            >
              {content}
            </button>
          ) : (
            <div key={key} aria-current={active ? "page" : undefined} className={className} style={style}>
              {content}
            </div>
          );
        })}
      </nav>
      {actions && <div className="workspace-header-actions mb-2 flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
