"use client";

import { Check, Cpu, FileText, Plus, Rocket, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { agentControlApi, type AgentVersions } from "@/lib/agent-control-api";
import { cn } from "@/lib/utils";

type VersionKind = "prompt" | "model" | "policy";

const KIND_LABEL: Record<VersionKind, string> = {
  prompt: "提示词",
  model: "模型",
  policy: "安全策略",
};

function nextVersion(value: string) {
  const match = value.match(/^(.*?)(\d+)$/);
  return match ? `${match[1]}${Number(match[2]) + 1}` : `${value}-2`;
}

export function StrategyManagerModal({
  open,
  versions,
  onClose,
  onChanged,
}: {
  open: boolean;
  versions: AgentVersions;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const active = useMemo(
    () => versions.deployments.find((item) => item.status === "active") ?? versions.deployments[0],
    [versions.deployments]
  );
  const activePrompt = versions.prompts.find((item) => item.id === active?.prompt_version_id);
  const activeModel = versions.models.find((item) => item.id === active?.model_config_id);
  const activePolicy = versions.policies.find((item) => item.id === active?.policy_version_id);

  const [tab, setTab] = useState<"deploy" | "create">("deploy");
  const [kind, setKind] = useState<VersionKind>("prompt");
  const [promptId, setPromptId] = useState("");
  const [modelId, setModelId] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [template, setTemplate] = useState("");
  const [provider, setProvider] = useState<"local" | "smart">("smart");
  const [modelName, setModelName] = useState("");
  const [temperature, setTemperature] = useState("0.2");
  const [maxTokens, setMaxTokens] = useState("700");
  const [rules, setRules] = useState("{}");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPromptId(active?.prompt_version_id ?? "");
    setModelId(active?.model_config_id ?? "");
    setPolicyId(active?.policy_version_id ?? "");
    setName(activePrompt?.name ?? "pilo_coach_insight_prompt");
    setVersion(nextVersion(activePrompt?.version ?? "pilo-coach-v1"));
    setTemplate(activePrompt?.template ?? "");
    setProvider(activeModel?.provider === "local" ? "local" : "smart");
    setModelName(activeModel?.model_name ?? "");
    setTemperature(String(activeModel?.temperature ?? 0.2));
    setMaxTokens(String(activeModel?.max_tokens ?? 700));
    setRules(JSON.stringify(activePolicy?.rules ?? { require_user_confirmation: true }, null, 2));
    setChangeNote("");
    setError(null);
    setNotice(null);
    setTab("deploy");
  }, [open, active, activePrompt, activeModel, activePolicy]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [open, busy, onClose]);

  const switchKind = (next: VersionKind) => {
    setKind(next);
    setError(null);
    setNotice(null);
    if (next === "prompt") {
      setName(activePrompt?.name ?? "pilo_coach_insight_prompt");
      setVersion(nextVersion(activePrompt?.version ?? "pilo-coach-v1"));
      setTemplate(activePrompt?.template ?? "");
    } else if (next === "model") {
      setName(activeModel?.name ?? "coach-model");
      setVersion(nextVersion(activeModel?.version ?? "v1"));
    } else {
      setName(activePolicy?.name ?? "coach-safety-policy");
      setVersion(nextVersion(activePolicy?.version ?? "v1"));
      setRules(JSON.stringify(activePolicy?.rules ?? { require_user_confirmation: true }, null, 2));
    }
    setChangeNote("");
  };

  const deploy = async () => {
    if (!promptId || !modelId || !policyId) return setError("请选择完整的提示词、模型和安全策略版本。");
    if (promptId === active?.prompt_version_id && modelId === active?.model_config_id && policyId === active?.policy_version_id) {
      return setError("当前组合已经在生产环境中使用，无需重复发布。");
    }
    setBusy("deploy");
    setError(null);
    try {
      await agentControlApi.deployVersions({
        agent_type: "coach",
        environment: "production",
        prompt_version_id: promptId,
        model_config_id: modelId,
        policy_version_id: policyId,
      });
      await onChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生产策略发布失败");
    } finally {
      setBusy(null);
    }
  };

  const createVersion = async () => {
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      if (kind === "prompt") {
        await agentControlApi.createPromptVersion({
          agent_type: "coach",
          name,
          version,
          template,
          variables_schema: activePrompt?.variables_schema ?? {},
          output_schema: activePrompt?.output_schema ?? {},
          change_note: changeNote,
        });
      } else if (kind === "model") {
        await agentControlApi.createModelConfig({
          name,
          version,
          provider,
          model_name: modelName,
          temperature: Number(temperature),
          max_tokens: Number(maxTokens),
        });
      } else {
        await agentControlApi.createPolicyVersion({
          agent_type: "coach",
          name,
          version,
          rules: JSON.parse(rules) as Record<string, unknown>,
          change_note: changeNote,
        });
      }
      await onChanged();
      setNotice(`${KIND_LABEL[kind]}候选版本 ${version} 已创建，请批准后再发布。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "候选版本创建失败");
    } finally {
      setBusy(null);
    }
  };

  const approve = async (nextKind: VersionKind, id: string) => {
    setBusy(`approve:${id}`);
    setError(null);
    try {
      await agentControlApi.approveVersion(nextKind, id);
      if (nextKind === "prompt") setPromptId(id);
      else if (nextKind === "model") setModelId(id);
      else setPolicyId(id);
      await onChanged();
      setNotice(`${KIND_LABEL[nextKind]}版本已批准并选入待发布组合。`);
      setTab("deploy");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "版本批准失败");
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;
  const candidates = [
    ...versions.prompts.filter((item) => item.status === "candidate").map((item) => ({ ...item, kind: "prompt" as const })),
    ...versions.models.filter((item) => item.status === "candidate").map((item) => ({ ...item, kind: "model" as const })),
    ...versions.policies.filter((item) => item.status === "candidate").map((item) => ({ ...item, kind: "policy" as const })),
  ];
  const selectedPrompt = versions.prompts.find((item) => item.id === promptId);
  const selectedModel = versions.models.find((item) => item.id === modelId);
  const selectedPolicy = versions.policies.find((item) => item.id === policyId);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="strategy-dialog-title" className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-gray-100 bg-gradient-to-r from-indigo-50 to-white px-6 py-5">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-[.16em] text-violet-600">Production strategy</span>
            <h2 id="strategy-dialog-title" className="mt-1 text-xl font-semibold text-gray-900">生产策略管理</h2>
            <p className="mt-1 text-xs text-gray-500">当前修订 {active?.revision ?? "—"} · 修改会创建新版本与新修订，历史调用保持不变。</p>
          </div>
          <button type="button" onClick={onClose} disabled={!!busy} aria-label="关闭策略管理" className="flex h-9 w-9 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-500 transition hover:border-violet-200 hover:text-violet-700 disabled:opacity-50"><X size={17} /></button>
        </header>

        <div className="flex gap-1 border-b border-gray-100 bg-gray-50 px-6 pt-3">
          {(["deploy", "create"] as const).map((item) => (
            <button key={item} type="button" onClick={() => setTab(item)} className={cn("rounded-t-xl px-4 py-2.5 text-xs font-semibold transition", tab === item ? "bg-white text-violet-700 shadow-[0_-1px_0_#e5e7eb,1px_0_0_#e5e7eb,-1px_0_0_#e5e7eb]" : "text-gray-500 hover:text-gray-800")}>{item === "deploy" ? "查看与发布" : "创建候选版本"}</button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {error && <div className="mb-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700">{error}</div>}
          {notice && <div className="mb-4 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-xs text-emerald-700">{notice}</div>}

          {tab === "deploy" ? (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-3">
                <VersionSelect icon={FileText} label="提示词" value={promptId} onChange={setPromptId} options={versions.prompts} />
                <VersionSelect icon={Cpu} label="模型" value={modelId} onChange={setModelId} options={versions.models} model />
                <VersionSelect icon={ShieldCheck} label="安全策略" value={policyId} onChange={setPolicyId} options={versions.policies} />
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <VersionDetail title="提示词详情" rows={selectedPrompt ? [["名称", selectedPrompt.name], ["版本说明", selectedPrompt.change_note || "无"], ["内容摘要", selectedPrompt.content_hash.slice(0, 14)]] : []} />
                <VersionDetail title="模型详情" rows={selectedModel ? [["路由", selectedModel.provider], ["模型", selectedModel.model_name], ["采样", `T ${selectedModel.temperature} · ${selectedModel.max_tokens} tokens`]] : []} />
                <VersionDetail title="策略详情" rows={selectedPolicy ? [["名称", selectedPolicy.name], ["用户确认", selectedPolicy.rules.require_user_confirmation === true ? "必须" : "未开启"], ["规则数", `${Object.keys(selectedPolicy.rules).length} 项`]] : []} />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <details className="group rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4">
                  <summary className="cursor-pointer list-none text-xs font-semibold text-indigo-700">查看提示词完整内容 <span className="float-right text-[10px] font-normal text-indigo-400 group-open:hidden">展开</span></summary>
                  <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-[10px] leading-5 text-gray-600">{selectedPrompt?.template || "未选择提示词版本"}</pre>
                </details>
                <details className="group rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
                  <summary className="cursor-pointer list-none text-xs font-semibold text-emerald-700">查看安全策略规则 <span className="float-right text-[10px] font-normal text-emerald-500 group-open:hidden">展开</span></summary>
                  <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-[10px] leading-5 text-gray-600">{selectedPolicy ? JSON.stringify(selectedPolicy.rules, null, 2) : "未选择安全策略版本"}</pre>
                </details>
              </div>
              {candidates.length > 0 && (
                <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
                  <h3 className="text-sm font-semibold text-gray-900">待批准候选版本</h3>
                  <div className="mt-3 space-y-2">
                    {candidates.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2.5"><div><strong className="text-xs text-gray-800">{KIND_LABEL[item.kind]} · {item.version}</strong><p className="mt-0.5 text-[10px] text-gray-400">{item.name}</p></div><button type="button" onClick={() => void approve(item.kind, item.id)} disabled={!!busy} className="rounded-lg bg-amber-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-amber-700 disabled:opacity-50"><Check size={12} className="mr-1 inline" />批准</button></div>)}
                  </div>
                </section>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap gap-2">
                {(["prompt", "model", "policy"] as VersionKind[]).map((item) => <button key={item} type="button" onClick={() => switchKind(item)} className={cn("rounded-xl border px-4 py-2 text-xs font-semibold transition", kind === item ? "border-violet-300 bg-violet-50 text-violet-700" : "border-gray-200 bg-white text-gray-500 hover:border-gray-300")}>{KIND_LABEL[item]}</button>)}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="配置名称"><input value={name} onChange={(event) => setName(event.target.value)} /></Field>
                <Field label="新版本号"><input value={version} onChange={(event) => setVersion(event.target.value)} /></Field>
                {kind === "model" && <><Field label="服务路由"><select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}><option value="smart">云端 DeepSeek（smart）</option><option value="local">本地 Qwen（local）</option></select></Field><Field label="模型名称"><input value={modelName} onChange={(event) => setModelName(event.target.value)} /></Field><Field label="Temperature"><input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(event.target.value)} /></Field><Field label="最大 Tokens"><input type="number" min="64" max="32000" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} /></Field></>}
              </div>
              {kind === "prompt" && <Field label="完整提示词模板"><textarea rows={10} value={template} onChange={(event) => setTemplate(event.target.value)} /></Field>}
              {kind === "policy" && <Field label="安全规则（JSON）"><textarea rows={10} className="font-mono" value={rules} onChange={(event) => setRules(event.target.value)} /></Field>}
              {kind !== "model" && <Field label="版本变更说明"><textarea rows={3} value={changeNote} onChange={(event) => setChangeNote(event.target.value)} placeholder="说明修改原因、预期影响和回滚关注点" /></Field>}
              <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-[11px] leading-5 text-blue-700">新建内容首先进入“候选”状态，批准后才能加入生产组合；发布时会自动生成下一条修订记录。</div>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 bg-gray-50 px-6 py-4">
          <p className="text-[10px] text-gray-400">所有创建、批准与发布操作都会保留管理员审计记录。</p>
          <div className="flex gap-2"><button type="button" onClick={onClose} disabled={!!busy} className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-600 disabled:opacity-50">取消</button>{tab === "deploy" ? <button type="button" onClick={() => void deploy()} disabled={!!busy} className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50"><Rocket size={14} className="mr-1.5 inline" />{busy === "deploy" ? "发布中…" : "发布为新修订"}</button> : <button type="button" onClick={() => void createVersion()} disabled={!!busy} className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50"><Plus size={14} className="mr-1.5 inline" />{busy === "create" ? "创建中…" : "创建候选版本"}</button>}</div>
        </footer>
      </div>
    </div>
  );
}

function VersionSelect({ icon: Icon, label, value, onChange, options, model = false }: { icon: typeof FileText; label: string; value: string; onChange: (value: string) => void; options: Array<{ id: string; name: string; version: string; status: string; model_name?: string; provider?: string }>; model?: boolean }) {
  const available = options.filter((item) => item.status === "approved" && (!model || item.provider === "local" || item.provider === "smart"));
  return <label className="rounded-2xl border border-gray-200 bg-gray-50 p-4"><span className="flex items-center gap-2 text-xs font-semibold text-gray-700"><Icon size={15} className="text-violet-600" />{label}</span><select value={available.some((item) => item.id === value) ? value : ""} onChange={(event) => onChange(event.target.value)} className="mt-3 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-xs text-gray-800"><option value="">请选择版本</option>{available.map((item) => <option key={item.id} value={item.id}>{model ? item.model_name : item.name} · {item.version}</option>)}</select><span className="mt-2 block text-[10px] text-gray-400">{model ? "只显示可执行的已批准路由；退役配置仅留审计" : "仅显示已批准版本"}</span></label>;
}

function VersionDetail({ title, rows }: { title: string; rows: Array<[string, string | undefined]> }) {
  return <div className="rounded-2xl border border-gray-100 bg-white p-4"><h3 className="text-xs font-semibold text-gray-800">{title}</h3><dl className="mt-3 space-y-2">{rows.map(([label, value]) => <div key={label} className="flex items-start justify-between gap-3 text-[10px]"><dt className="text-gray-400">{label}</dt><dd className="break-all text-right font-medium text-gray-600">{value ?? "—"}</dd></div>)}</dl></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs font-semibold text-gray-600">{label}<div className="mt-2 [&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:border-gray-200 [&_input]:bg-white [&_input]:px-3 [&_input]:py-2.5 [&_input]:text-sm [&_select]:w-full [&_select]:rounded-xl [&_select]:border [&_select]:border-gray-200 [&_select]:bg-white [&_select]:px-3 [&_select]:py-2.5 [&_select]:text-sm [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:rounded-xl [&_textarea]:border [&_textarea]:border-gray-200 [&_textarea]:bg-white [&_textarea]:px-3 [&_textarea]:py-2.5 [&_textarea]:text-sm [&_textarea]:leading-6">{children}</div></label>;
}
