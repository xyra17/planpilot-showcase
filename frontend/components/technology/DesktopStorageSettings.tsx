"use client";

import { Check, Download, FolderOpen, HardDrive, Laptop, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

type ModelPreferences = { modelDirectory: string; selectedModel: string; models: PlanPilotDesktopModel[] };
type DesktopEnvironment = { isDesktop: true; appVersion: string; installationId: string; deviceName: string; platform: string };

function bytes(value: number): string {
  if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export function DesktopStorageSettings() {
  const bridge = typeof window !== "undefined" ? window.planpilotDesktop : undefined;
  const [environment, setEnvironment] = useState<DesktopEnvironment | null>(null);
  const [models, setModels] = useState<ModelPreferences | null>(null);
  const [privateDirectory, setPrivateDirectory] = useState("");
  const [modelUrl, setModelUrl] = useState("");
  const [privateName, setPrivateName] = useState("本机私密空间");
  const [busy, setBusy] = useState<"models" | "download" | "private" | "">("");
  const [message, setMessage] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<{ receivedBytes: number; totalBytes: number } | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.onModelDownloadProgress((value) => active && setDownloadProgress(value));
    void Promise.all([bridge.getEnvironment(), bridge.getModelPreferences(), bridge.getPrivateSpacePreferences()])
      .then(async ([nextEnvironment, nextModels, privatePreferences]) => {
        if (!active) return;
        setEnvironment(nextEnvironment);
        setModels(nextModels);
        setPrivateDirectory(privatePreferences.privateSpaceDirectory);
        try {
          await api.put("/api/v1/devices/current", {
            installation_id: nextEnvironment.installationId,
            name: nextEnvironment.deviceName,
            platform: nextEnvironment.platform,
            app_version: nextEnvironment.appVersion,
          });
        } catch { /* Device registration is retried on the next authenticated settings visit. */ }
      })
      .catch((error) => active && setMessage(error instanceof Error ? error.message : "桌面设置读取失败"));
    return () => { active = false; unsubscribe(); };
  }, [bridge]);

  const progressText = useMemo(() => {
    if (!downloadProgress) return "";
    if (!downloadProgress.totalBytes) return `已下载 ${bytes(downloadProgress.receivedBytes)}`;
    return `${Math.min(100, Math.round(downloadProgress.receivedBytes / downloadProgress.totalBytes * 100))}% · ${bytes(downloadProgress.receivedBytes)} / ${bytes(downloadProgress.totalBytes)}`;
  }, [downloadProgress]);

  if (!bridge) return <article id="settings-desktop" className="settings-card settings-task-card desktop-storage-card">
    <header className="settings-section-head"><span><Laptop size={17} /></span><div><h2>桌面端与本机能力</h2><p>模型目录、本机文件和私密空间只能在 PlanPilot Desktop 中管理。</p></div></header>
    <div className="desktop-only-callout"><strong>当前正在浏览器中使用</strong><p>你的云端目标、计划、笔记和资料会正常同步；打开桌面端可连接本机目录与模型。</p></div>
  </article>;
  const desktopBridge = bridge;

  async function chooseDirectory() {
    setBusy("models"); setMessage("");
    try { const value = await desktopBridge.chooseModelDirectory(); if (value) setModels(value); }
    catch (error) { setMessage(error instanceof Error ? error.message : "目录选择失败"); }
    finally { setBusy(""); }
  }

  async function refreshModels() {
    setBusy("models"); setMessage("");
    try { setModels(await desktopBridge.getModelPreferences()); }
    catch (error) { setMessage(error instanceof Error ? error.message : "模型扫描失败"); }
    finally { setBusy(""); }
  }

  async function selectModel(modelPath: string) {
    setBusy("models"); setMessage("");
    try { setModels(await desktopBridge.selectModel(modelPath)); setMessage("模型选择已保存在本机"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "模型切换失败"); }
    finally { setBusy(""); }
  }

  async function download() {
    if (!modelUrl.trim()) return;
    setBusy("download"); setMessage(""); setDownloadProgress(null);
    try { setModels(await desktopBridge.downloadModel(modelUrl.trim())); setModelUrl(""); setMessage("模型包已下载并加入目录"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "模型下载失败"); }
    finally { setBusy(""); }
  }

  async function preparePrivateSpace() {
    setBusy("private"); setMessage("");
    try {
      const result = await desktopBridge.preparePrivateSpace(privateName);
      if (result) { setPrivateDirectory(result.manifest.storageRoot); setMessage("私密空间目录已准备；本地数据引擎接通前不会迁入学习数据"); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "私密空间准备失败"); }
    finally { setBusy(""); }
  }

  return <article id="settings-desktop" className="settings-card settings-task-card desktop-storage-card">
    <header className="settings-section-head"><span><Laptop size={17} /></span><div><h2>桌面端与本机能力</h2><p>{environment ? `${environment.deviceName} · PlanPilot ${environment.appVersion}` : "正在读取桌面环境…"}</p></div></header>

    <div className="desktop-setting-group">
      <div className="desktop-setting-heading"><div><strong>本地模型</strong><p>模型包保存在你指定的目录。PlanPilot 会发现 GGUF 和 Safetensors 文件并记住当前选择。</p></div><div><button type="button" onClick={() => void chooseDirectory()} disabled={Boolean(busy)}><FolderOpen size={14} />选择目录</button><button type="button" onClick={() => void refreshModels()} disabled={Boolean(busy) || !models?.modelDirectory} aria-label="重新扫描模型"><RefreshCw size={14} /></button></div></div>
      <code className="desktop-path">{models?.modelDirectory || "尚未选择模型目录"}</code>
      {models?.models.length ? <div className="desktop-model-list">{models.models.map((model) => <button type="button" key={model.path} className={models.selectedModel === model.path ? "is-selected" : ""} onClick={() => void selectModel(model.path)} disabled={Boolean(busy)}><span><strong>{model.name}</strong><small>{model.kind === "embedding" ? "Embedding" : "生成模型"} · {bytes(model.sizeBytes)}</small></span>{models.selectedModel === model.path && <Check size={15} />}</button>)}</div> : <p className="desktop-empty">目录中还没有可识别的模型。</p>}
      <div className="desktop-download-row"><input type="url" value={modelUrl} onChange={(event) => setModelUrl(event.target.value)} placeholder="HTTPS 模型文件直链（.gguf / .safetensors）" aria-label="模型下载地址" /><button type="button" disabled={busy === "download" || !models?.modelDirectory || !modelUrl.trim()} onClick={() => void download()}>{busy === "download" ? <LoaderCircle size={14} className="is-spinning" /> : <Download size={14} />}下载</button></div>
      {progressText && busy === "download" && <small className="desktop-progress">{progressText}</small>}
      <p className="desktop-boundary">当前版本已实现目录扫描、HTTPS 下载与模型选择；选中的模型尚未接入 Pilo 推理链路。</p>
    </div>

    <div className="desktop-setting-group">
      <div className="desktop-setting-heading"><div><strong>本机私密空间</strong><p>指定这台 Mac 上的存储目录，原文和空间标识不会上传。</p></div></div>
      <div className="desktop-private-row"><input value={privateName} onChange={(event) => setPrivateName(event.target.value)} aria-label="私密空间名称" /><button type="button" onClick={() => void preparePrivateSpace()} disabled={Boolean(busy)}>{busy === "private" ? <LoaderCircle size={14} className="is-spinning" /> : <HardDrive size={14} />}{privateDirectory ? "更换目录" : "准备目录"}</button></div>
      {privateDirectory && <code className="desktop-path">{privateDirectory}</code>}
      <p className="desktop-boundary is-warning">这里只会创建系统加密的空间标识和隔离目录。目标、任务、笔记、向量索引与 Pilo 的完整离线读写尚未开放，因此当前不会显示“进入私密空间”。</p>
    </div>
    {message && <p className="desktop-settings-message" role="status">{message}</p>}
  </article>;
}
