"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Preview = { scanned: number; referenced: number; orphaned: number; deleted: number; bytes_reclaimed: number };

export default function AdminStoragePage() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = async () => setPreview(await api.get<Preview>("/api/v1/admin/storage/gc/preview"));
  useEffect(() => { void load(); }, []);
  const run = async (mode: "immediate" | "scheduled") => {
    setBusy(true); setMessage("");
    try {
      const result = await api.post<Preview>("/api/v1/admin/storage/gc", { mode, ...(mode === "scheduled" ? { run_at: new Date(Date.now() + 60_000).toISOString() } : {}) });
      setMessage(mode === "immediate" ? `已清理 ${result.deleted} 个文件` : "已安排 1 分钟后执行清理");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  };
  return <section className="mx-auto max-w-3xl space-y-6">
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">存储垃圾回收</h2>
      <p className="mt-2 text-sm text-slate-500">仅扫描数据库已无引用且超过 48 小时的文件。执行前建议先刷新预览。</p>
      {preview && <div className="mt-5 grid grid-cols-3 gap-3 text-center text-sm"><div className="rounded-xl bg-slate-50 p-3"><b>{preview.scanned}</b><span className="block text-slate-500">扫描对象</span></div><div className="rounded-xl bg-amber-50 p-3"><b>{preview.orphaned}</b><span className="block text-slate-500">可清理对象</span></div><div className="rounded-xl bg-emerald-50 p-3"><b>{(preview.bytes_reclaimed / 1024 / 1024).toFixed(1)} MB</b><span className="block text-slate-500">预计释放</span></div></div>}
      <div className="mt-6 flex flex-wrap gap-3"><button disabled={busy} onClick={() => void load()} className="rounded-lg border px-4 py-2 text-sm">刷新预览</button><button disabled={busy || !preview?.orphaned} onClick={() => void run("immediate")} className="rounded-lg bg-violet-600 px-4 py-2 text-sm text-white disabled:opacity-50">立即清理</button><button disabled={busy || !preview?.orphaned} onClick={() => void run("scheduled")} className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">定时清理（1 分钟后）</button></div>
      {message && <p className="mt-4 text-sm text-slate-600">{message}</p>}
    </div>
  </section>;
}
