"use client";

import { ArrowRight, Check, LayoutDashboard, Moon, NotebookPen } from "lucide-react";
import { useEffect, useState } from "react";

import { useAuthStore } from "@/lib/stores/authStore";

type Surface = "base" | "notebook" | "dark";

const SURFACES = [
  { id: "base" as const, title: "原生外观", description: "使用所选布局自身的设计语言", icon: LayoutDashboard },
  { id: "notebook" as const, title: "手帐纸张", description: "复古纸张、铅笔线与暖色墨迹", icon: NotebookPen },
  { id: "dark" as const, title: "暗黑模式", description: "低亮度夜间界面", icon: Moon },
];

export default function AppearanceOnboardingPage() {
  const { user, initFromStorage, updateUser } = useAuthStore();
  const [surface, setSurface] = useState<Surface>("base");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    initFromStorage();
  }, [initFromStorage]);

  async function finish() {
    setBusy(true);
    setError("");
    const accent = surface === "notebook" ? "wood" : "violet";
    localStorage.setItem("planpilot-experience", "technology");
    localStorage.setItem("planpilot-surface-theme", surface);
    localStorage.setItem("planpilot-accent", accent);

    try {
      if (user) await updateUser({ ui_experience: "technology", ui_theme: surface, ui_accent: accent });
      window.location.assign("/studio/work");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "偏好保存失败，请重试");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f4f5f8] px-5 py-10 text-slate-900">
      <section className="mx-auto max-w-5xl overflow-hidden rounded-[28px] border border-slate-200/80 bg-white shadow-[0_28px_80px_rgba(28,35,55,0.10)]">
        <header className="border-b border-slate-100 px-7 py-7 sm:px-10">
          <span className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-500">Welcome to PlanPilot</span>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">选择适合你的工作台外观。</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">科技型布局已经为你准备好，这里只需选择日常使用的材质主题。</p>
        </header>

        <div className="space-y-9 px-7 py-8 sm:px-10">
          <section>
            <div className="mb-4"><small className="font-semibold text-indigo-500">APPEARANCE</small><h2 className="mt-1 text-xl font-semibold">选择材质主题</h2><p className="mt-1 text-sm text-slate-500">材质只改变色彩与质感，导航和页面结构保持一致。</p></div>
            <div className="grid gap-3 sm:grid-cols-3">
              {SURFACES.map((item) => {
                const Icon = item.icon;
                const selected = surface === item.id;
                return <button key={item.id} type="button" aria-pressed={selected} onClick={() => setSurface(item.id)} className={`relative flex min-h-[112px] flex-col items-start rounded-xl border p-4 text-left transition-all duration-300 hover:border-indigo-300 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${selected ? "border-indigo-500 bg-indigo-50/60" : "border-slate-200"}`}><Icon size={19} /><strong className="mt-3 text-sm">{item.title}</strong><small className="mt-1 leading-5 text-slate-500">{item.description}</small>{selected && <Check className="absolute right-3 top-3 text-indigo-600" size={15} />}</button>;
              })}
            </div>
          </section>
        </div>

        <footer className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50/70 px-7 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-10">
          <span className="text-sm text-slate-500">当前：科技工作台 · {SURFACES.find((item) => item.id === surface)?.title}</span>
          <div className="flex items-center gap-3">{error && <span className="text-sm text-red-600">{error}</span>}<button type="button" disabled={busy} onClick={() => void finish()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white transition-all duration-300 hover:-translate-y-0.5 hover:bg-indigo-700 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-60">{busy ? "正在保存…" : "进入 PlanPilot"}<ArrowRight size={17} /></button></div>
        </footer>
      </section>
    </main>
  );
}
