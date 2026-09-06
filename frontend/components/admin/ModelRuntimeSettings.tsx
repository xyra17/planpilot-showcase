"use client";

import { AlertTriangle, CheckCircle2, Cloud, Cpu, Database, Loader2, PlugZap, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { agentControlApi, type ModelProbeResult, type RuntimeModelSettings } from "@/lib/agent-control-api";
import { cn } from "@/lib/utils";

type Provider = RuntimeModelSettings["cloud_provider"];
type FormState = Omit<RuntimeModelSettings, "local_api_key_configured" | "cloud_api_key_configured" | "embedding_api_key_configured" | "updated_at" | "updated_by"> & {
  local_api_key: string;
  cloud_api_key: string;
  embedding_api_key: string;
};

const PROVIDERS: Array<{ id: Provider; label: string; baseUrl: string; routine: string; pro: string }> = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", routine: "deepseek-v4-flash", pro: "deepseek-v4-pro" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", routine: "glm-5", pro: "glm-5" },
  { id: "doubao", label: "豆包方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", routine: "doubao-seed-2-0-lite-260215", pro: "doubao-seed-2-0-lite-260215" },
  { id: "custom", label: "自定义", baseUrl: "", routine: "", pro: "" },
];

function toForm(settings: RuntimeModelSettings): FormState {
  return {
    local_enabled: settings.local_enabled,
    local_base_url: settings.local_base_url,
    local_model_name: settings.local_model_name,
    local_max_concurrency: settings.local_max_concurrency,
    cloud_enabled: settings.cloud_enabled,
    cloud_provider: settings.cloud_provider,
    cloud_base_url: settings.cloud_base_url,
    cloud_model_name: settings.cloud_model_name,
    cloud_pro_model_name: settings.cloud_pro_model_name,
    cloud_routine_max_concurrency: settings.cloud_routine_max_concurrency,
    cloud_pro_max_concurrency: settings.cloud_pro_max_concurrency,
    embedding_enabled: settings.embedding_enabled,
    embedding_base_url: settings.embedding_base_url,
    embedding_model_name: settings.embedding_model_name,
    embedding_dimensions: settings.embedding_dimensions,
    embedding_max_concurrency: settings.embedding_max_concurrency,
    coach_agent_enabled: settings.coach_agent_enabled,
    local_api_key: "",
    cloud_api_key: "",
    embedding_api_key: "",
  };
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cn("relative h-7 w-12 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400", checked ? "bg-cyan-600" : "bg-gray-300")}>
      <span className={cn("absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition", checked ? "left-6" : "left-1")} />
    </button>
  );
}

function Field({ label, value, onChange, placeholder, type = "text", hint }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; hint?: string }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-gray-700">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100" />
      {hint && <span className="font-normal leading-5 text-gray-400">{hint}</span>}
    </label>
  );
}

function ConcurrencyField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-gray-700">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        min={1}
        max={32}
        value={value}
        onChange={(event) => onChange(Math.max(1, Math.min(32, Number(event.target.value) || 1)))}
        className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-900 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100"
      />
    </label>
  );
}

export function ModelRuntimeSettings() {
  const [saved, setSaved] = useState<RuntimeModelSettings | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "probe" | null>("load");
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [probes, setProbes] = useState<ModelProbeResult[]>([]);

  useEffect(() => {
    agentControlApi.getRuntimeModelSettings()
      .then((settings) => { setSaved(settings); setForm(toForm(settings)); })
      .catch((error) => setMessage({ tone: "error", text: error instanceof Error ? error.message : "模型配置加载失败" }))
      .finally(() => setBusy(null));
  }, []);

  const changed = useMemo(() => Boolean(saved && form && JSON.stringify(toForm(saved)) !== JSON.stringify({ ...form, local_api_key: "", cloud_api_key: "", embedding_api_key: "" })) || Boolean(form?.local_api_key || form?.cloud_api_key || form?.embedding_api_key), [form, saved]);
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => current ? { ...current, [key]: value } : current);

  const chooseProvider = (provider: Provider) => {
    const preset = PROVIDERS.find((item) => item.id === provider)!;
    setForm((current) => current ? {
      ...current,
      cloud_provider: provider,
      cloud_base_url: preset.baseUrl || current.cloud_base_url,
      cloud_model_name: preset.routine || current.cloud_model_name,
      cloud_pro_model_name: preset.pro || current.cloud_pro_model_name,
    } : current);
  };

  const save = async () => {
    if (!form) return;
    setBusy("save"); setMessage(null);
    try {
      const next = await agentControlApi.updateRuntimeModelSettings({ ...form, clear_local_api_key: false, clear_cloud_api_key: false, clear_embedding_api_key: false });
      setSaved(next); setForm(toForm(next)); setMessage({ tone: "success", text: "模型配置已加密保存，新的 API 与 Worker 调用会立即使用。" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally { setBusy(null); }
  };

  const probe = async () => {
    setBusy("probe"); setMessage(null);
    try {
      const result = await agentControlApi.probeRuntimeModels();
      setProbes(result);
      setMessage({ tone: result.every((item) => !item.configured || item.reachable) ? "success" : "error", text: "连接检查完成。" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "连接检查失败" });
    } finally { setBusy(null); }
  };

  if (busy === "load" || !form || !saved) return <section className="pp-admin-panel rounded-3xl border border-gray-100 bg-white p-6"><div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={17} className="animate-spin" />正在加载模型运行配置…</div></section>;

  return (
    <section className="pp-admin-panel pp-admin-panel-cyan rounded-3xl border border-gray-100 bg-white p-5 shadow-[var(--shadow-xs)]">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div><div className="flex items-center gap-2"><ShieldCheck size={18} className="text-cyan-600" /><h2 className="text-base font-semibold text-gray-900">模型运行配置</h2></div><p className="mt-1 max-w-3xl text-xs leading-5 text-gray-500">配置会加密保存在本地共享数据卷。API Key 写入后不会再次返回浏览器；API 与 Celery Worker 会热读取同一份配置。</p></div>
        <span className="shrink-0 rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-semibold text-cyan-700">管理员可写 · 全局生效</span>
      </div>

      <div className="mt-4 rounded-2xl border border-cyan-100 bg-cyan-50/60 px-4 py-3 text-xs leading-5 text-cyan-900">
        <strong>并发上限是 PlanPilot 同时放行的请求数，不是模型厂商标称性能。</strong> 本地模型通常受显存和推理队列限制；云端模型受账号限流、成本和任务风险影响。修改后，新请求会立即使用新的限制。
      </div>

      <div className="mt-4 grid gap-4">
        <div className="rounded-2xl border border-gray-200 p-4">
          <div className="flex items-center justify-between gap-4"><div className="flex items-center gap-2"><Cpu size={17} className="text-violet-600" /><div><h3 className="text-sm font-semibold text-gray-900">本机 Qwen</h3><p className="text-xs text-gray-500">云端模型断网、超时或服务异常时自动使用。</p></div></div><Toggle checked={form.local_enabled} onChange={(value) => update("local_enabled", value)} label="启用本机 Qwen" /></div>
          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_10rem]"><Field label="OpenAI-compatible Base URL" value={form.local_base_url} onChange={(value) => update("local_base_url", value)} /><Field label="模型名" value={form.local_model_name} onChange={(value) => update("local_model_name", value)} /><ConcurrencyField label="对话并发上限" value={form.local_max_concurrency} onChange={(value) => update("local_max_concurrency", value)} /></div>
        </div>

        <div className="rounded-2xl border border-gray-200 p-4">
          <div className="flex items-center justify-between gap-4"><div className="flex items-center gap-2"><Cloud size={17} className="text-cyan-600" /><div><h3 className="text-sm font-semibold text-gray-900">云端生成模型</h3><p className="text-xs text-gray-500">Flash 优先处理日常与结构化任务；Pro 用于关键评分和终审。</p></div></div><Toggle checked={form.cloud_enabled} onChange={(value) => update("cloud_enabled", value)} label="启用云端模型" /></div>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="云端模型供应商">{PROVIDERS.map((provider) => <button key={provider.id} type="button" onClick={() => chooseProvider(provider.id)} className={cn("rounded-full border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300", form.cloud_provider === provider.id ? "border-cyan-600 bg-cyan-600 text-white" : "border-gray-200 bg-white text-gray-600 hover:border-cyan-300 hover:text-cyan-700")}>{provider.label}</button>)}</div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2"><Field label="Base URL" value={form.cloud_base_url} onChange={(value) => update("cloud_base_url", value)} placeholder="https://…" /><Field label="API Key" type="password" value={form.cloud_api_key} onChange={(value) => update("cloud_api_key", value)} placeholder={saved.cloud_api_key_configured ? "已保存；留空保持不变" : "输入 API Key"} hint="密钥只写入后端加密文件，不会回显。" /><Field label="日常/结构化模型名" value={form.cloud_model_name} onChange={(value) => update("cloud_model_name", value)} /><Field label="高质量模型名" value={form.cloud_pro_model_name} onChange={(value) => update("cloud_pro_model_name", value)} /><ConcurrencyField label="任务模型并发上限" value={form.cloud_routine_max_concurrency} onChange={(value) => update("cloud_routine_max_concurrency", value)} /><ConcurrencyField label="安全判断并发上限" value={form.cloud_pro_max_concurrency} onChange={(value) => update("cloud_pro_max_concurrency", value)} /></div>
        </div>

        <div className="rounded-2xl border border-gray-200 p-4">
          <div className="flex items-center justify-between gap-4"><div className="flex items-center gap-2"><Database size={17} className="text-emerald-600" /><div><h3 className="text-sm font-semibold text-gray-900">知识库 Embedding</h3><p className="text-xs text-gray-500">独立于生成模型，维度固定为 1024。</p></div></div><Toggle checked={form.embedding_enabled} onChange={(value) => update("embedding_enabled", value)} label="启用知识库 Embedding" /></div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2"><Field label="Embedding Base URL" value={form.embedding_base_url} onChange={(value) => update("embedding_base_url", value)} /><Field label="Embedding 模型名" value={form.embedding_model_name} onChange={(value) => update("embedding_model_name", value)} /><Field label="API Key（本地服务可留空）" type="password" value={form.embedding_api_key} onChange={(value) => update("embedding_api_key", value)} placeholder={saved.embedding_api_key_configured ? "已保存；留空保持不变" : "local"} /><ConcurrencyField label="知识检索并发上限" value={form.embedding_max_concurrency} onChange={(value) => update("embedding_max_concurrency", value)} /></div>
        </div>
      </div>

      {probes.length > 0 && <div className="mt-4 grid gap-2 sm:grid-cols-3">{probes.map((item) => <div key={item.target} className={cn("rounded-xl border px-3 py-2 text-xs", item.reachable ? "border-emerald-200 bg-emerald-50 text-emerald-700" : item.configured ? "border-amber-200 bg-amber-50 text-amber-700" : "border-gray-200 bg-gray-50 text-gray-500")}><div className="flex items-center gap-1.5 font-semibold">{item.reachable ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{item.target === "local" ? "本机模型" : item.target === "cloud" ? "云端模型" : "Embedding"}</div><p className="mt-1 truncate">{item.detail}{item.reachable && !item.model_match ? "，模型名未在列表中" : ""}</p></div>)}</div>}
      {message && <div role="status" className={cn("mt-4 rounded-xl px-3 py-2 text-xs", message.tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")}>{message.text}</div>}
      <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={probe} disabled={Boolean(busy)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 text-sm font-semibold text-gray-700 transition hover:border-cyan-300 hover:text-cyan-700 disabled:opacity-50">{busy === "probe" ? <Loader2 size={15} className="animate-spin" /> : <PlugZap size={15} />}检查已保存连接</button><button type="button" onClick={save} disabled={Boolean(busy) || !changed} className="inline-flex h-10 items-center gap-2 rounded-xl bg-gray-950 px-4 text-sm font-semibold text-white transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-40">{busy === "save" ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}保存并切换</button></div>
    </section>
  );
}
