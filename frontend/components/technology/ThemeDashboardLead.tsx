"use client";

import Link from "next/link";
import type { CSSProperties, PointerEvent } from "react";
import {
  ArrowRight,
  Command,
  type LucideIcon,
  NotebookTabs,
  ScanLine,
  Search,
} from "lucide-react";
import { useTheme } from "@/components/technology/ThemeProvider";

export type DashboardLeadMetric = {
  label: string;
  value: string;
  unit?: string;
  detail: string;
  icon: LucideIcon;
  tone: "violet" | "mint" | "blue" | "amber";
  href: string;
  workspaceView?: "today" | "week";
};

export type DashboardLeadData = {
  metrics: DashboardLeadMetric[];
  nextTaskTitle: string | null;
  nextTaskTime: string | null;
  nextTaskDuration: string | null;
  actualTodayMinutes: number | null;
  plannedTodayMinutes: number;
  habitInsight: {
    eyebrow: string;
    title: string;
    description: string;
    href: string;
    actionLabel: string;
  };
};

function moveTechLight(event: PointerEvent<HTMLElement>) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = ((event.clientX - bounds.left) / bounds.width) * 100;
  const y = ((event.clientY - bounds.top) / bounds.height) * 100;
  event.currentTarget.style.setProperty("--tech-x", `${x}%`);
  event.currentTarget.style.setProperty("--tech-y", `${y}%`);
}

function resetTechLight(event: PointerEvent<HTMLElement>) {
  event.currentTarget.style.removeProperty("--tech-x");
  event.currentTarget.style.removeProperty("--tech-y");
}

function metricText(value: string, unit?: string) {
  return unit ? `${value} ${unit}` : value;
}

function TechLead({ data }: { data: DashboardLeadData }) {
  const { habitInsight } = data;
  return (
    <section
      className="theme-lead theme-lead-tech"
      aria-label="科技风学习洞察"
      onPointerMove={moveTechLight}
      onPointerLeave={resetTechLight}
    >
      <div className="tech-scan" aria-hidden="true" />
      <div className="theme-lead-copy">
        <span className="theme-lead-icon"><ScanLine size={19} /></span>
        <div>
          <small>{habitInsight.eyebrow}</small>
          <h2>{habitInsight.title}</h2>
          <div className="theme-lead-insight-line">
            <p>{habitInsight.description}</p>
            <Link aria-label={habitInsight.actionLabel} href={habitInsight.href}>{habitInsight.actionLabel} <ArrowRight size={14} /></Link>
          </div>
        </div>
        <div className="theme-lead-actions">
          <button
            type="button"
            className="theme-lead-search"
            onClick={() => window.dispatchEvent(new Event("planpilot:open-search"))}
          >
            <Search size={14} />
            <span>搜索任务</span>
          </button>
        </div>
      </div>
      <div className="tech-telemetry">
        {data.metrics.map(({ label, value, unit, detail, icon: Icon, href, workspaceView }) => (
          <article key={label}>
            <Link
              className="tech-metric-link"
              href={href}
              onClick={() => {
                if (!workspaceView) return;
                window.dispatchEvent(new CustomEvent("planpilot:set-workspace-view", {
                  detail: workspaceView,
                }));
              }}
            >
              <span className="tech-metric-icon"><Icon size={15} /></span>
              <div className="tech-metric-copy">
                <div className="tech-metric-heading">
                  <strong>{value}</strong>
                  <b className="tech-metric-unit">{unit}</b>
                  <span>{label}</span>
                </div>
                <small>{detail}</small>
              </div>
              <ArrowRight className="tech-metric-arrow" size={17} strokeWidth={2.35} />
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}

function NotebookLead({ data }: { data: DashboardLeadData }) {
  const { habitInsight } = data;
  return (
    <section className="theme-lead theme-lead-notebook" aria-label="手帐风今日手记">
      <div className="notebook-tape" aria-hidden="true" />
      <div className="notebook-note">
        <span className="notebook-kicker"><NotebookTabs size={15} /> LEARNING HABIT · PROFILE</span>
        <h2>{habitInsight.title}</h2>
        <p>{habitInsight.description}</p>
        <Link aria-label={habitInsight.actionLabel} href={habitInsight.href}>{habitInsight.actionLabel} <ArrowRight size={14} /></Link>
      </div>
      <div className="notebook-stamps">
        {data.metrics.map(({ label, value, unit, detail }, index) => (
          <article key={label} style={{ "--note-index": index } as CSSProperties}>
            <span>{label}</span>
            <strong>{metricText(value, unit)}</strong>
            <small>{detail}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function DarkLead({ data }: { data: DashboardLeadData }) {
  const { habitInsight } = data;
  return (
    <section className="theme-lead theme-lead-dark" aria-label="暗黑风专注控制台">
      <div className="dark-command-head">
        <span><i /> FOCUS ENGINE ONLINE</span>
        <small>MODEL / LONG-TERM HABIT · REAL DATA ONLY</small>
      </div>
      <div className="dark-focus-grid">
        <div className="dark-focus-primary">
          <Command size={18} />
          <small>LEARNER PROFILE</small>
          <h2>{habitInsight.title}</h2>
          <p>{habitInsight.description}</p>
          <Link aria-label={habitInsight.actionLabel} href={habitInsight.href}>{habitInsight.actionLabel} <ArrowRight size={14} /></Link>
        </div>
        <div className="dark-telemetry">
          {data.metrics.map(({ label, value, unit }) => (
            <article key={label}>
              <span>{label}</span>
              <strong>{metricText(value, unit)}</strong>
              <i />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ThemeDashboardLead({ data }: { data: DashboardLeadData }) {
  const { theme } = useTheme();

  if (theme === "notebook") return <NotebookLead data={data} />;
  if (theme === "dark") return <DarkLead data={data} />;
  return <TechLead data={data} />;
}
