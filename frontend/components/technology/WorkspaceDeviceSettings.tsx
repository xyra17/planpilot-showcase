"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  GitMerge,
  LoaderCircle,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/components/technology/AuthProvider";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";

type Workspace = {
  id: string;
  name: string;
  kind: "cloud" | string;
  is_default: boolean;
  version: number;
  updated_at: string;
};

type Device = {
  id: string;
  installation_id: string;
  name: string;
  platform: string;
  app_version: string;
  last_seen_at: string;
  revoked_at: string | null;
};

type OfflineConflict = {
  id: string;
  operation_id: string;
  operation_type: "create" | "update" | "delete";
  entity_type: "goal" | "task" | "note" | "knowledge_item";
  entity_id: string | null;
  base_version: number;
  server_version: number;
  local_snapshot: Record<string, unknown>;
  server_snapshot: Record<string, unknown>;
  status: "conflict";
  created_at: string | null;
};

const ENTITY_LABELS: Record<OfflineConflict["entity_type"], string> = {
  goal: "目标",
  task: "任务",
  note: "笔记",
  knowledge_item: "资料",
};

function formatDate(value: string | null): string {
  if (!value) return "时间未知";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function snapshotText(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2) || "{}";
}

export function WorkspaceDeviceSettings() {
  const { status } = useAuth();
  const { confirmAction } = useConfirmDialog();
  const bridge = typeof window !== "undefined" ? window.planpilotDesktop : undefined;
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [conflicts, setConflicts] = useState<OfflineConflict[]>([]);
  const [installationId, setInstallationId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    if (status !== "authenticated") return;
    setLoading(true);
    setLoadError("");
    try {
      const environment = bridge ? await bridge.getEnvironment() : null;
      if (environment) {
        setInstallationId(environment.installationId);
        await api.put<Device>("/api/v1/devices/current", {
          installation_id: environment.installationId,
          name: environment.deviceName,
          platform: environment.platform,
          app_version: environment.appVersion,
        });
      } else {
        setInstallationId("");
      }
      const [nextWorkspaces, nextDevices, nextConflicts] = await Promise.all([
        api.get<Workspace[]>("/api/v1/workspaces"),
        api.get<Device[]>("/api/v1/devices"),
        api.get<{ items: OfflineConflict[] }>("/api/v1/sync/operations?status=conflict"),
      ]);
      setWorkspaces(nextWorkspaces);
      setDevices(nextDevices);
      setConflicts(nextConflicts.items);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "空间与设备信息读取失败");
    } finally {
      setLoading(false);
    }
  }, [bridge, status]);

  useEffect(() => {
    if (status !== "authenticated") {
      setWorkspaces([]);
      setDevices([]);
      setConflicts([]);
      return;
    }
    void load();
  }, [load, status]);

  const activeDevices = useMemo(() => devices.filter((device) => !device.revoked_at), [devices]);

  async function revokeDevice(device: Device) {
    const confirmed = await confirmAction({
      kicker: "设备权限",
      title: `撤销“${device.name}”的同步权限？`,
      description: "该设备下次同步时必须重新登记。此操作不会远程删除设备上的本地文件。",
      confirmLabel: "确认撤销",
      cancelLabel: "保留设备",
      tone: "warning",
    });
    if (!confirmed) return;
    setBusyKey(`device:${device.id}`);
    setMessage("");
    try {
      await api.del(`/api/v1/devices/${device.id}`);
      setDevices((current) => current.map((item) => item.id === device.id
        ? { ...item, revoked_at: new Date().toISOString() }
        : item));
      setMessage(`已撤销“${device.name}”的同步权限`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "设备撤销失败");
    } finally {
      setBusyKey("");
    }
  }

  async function resolveConflict(conflict: OfflineConflict, action: "keep_both" | "keep_server") {
    const keepBoth = action === "keep_both";
    const confirmed = await confirmAction({
      kicker: "离线冲突确认",
      title: keepBoth ? "保留服务器版本和本机副本？" : "只保留服务器版本？",
      description: keepBoth
        ? "两个快照都会保留；当前会进入待创建副本队列，不会覆盖服务器版本。"
        : "服务器对象不会改变；这条本机修改不会再进入应用队列。",
      confirmLabel: keepBoth ? "确认保留两份" : "确认保留服务器版",
      cancelLabel: "返回比较",
      tone: keepBoth ? "primary" : "warning",
    });
    if (!confirmed) return;
    setBusyKey(`conflict:${conflict.operation_id}`);
    setMessage("");
    try {
      await api.post(`/api/v1/sync/operations/${encodeURIComponent(conflict.operation_id)}/resolve`, { action });
      setConflicts((current) => current.filter((item) => item.operation_id !== conflict.operation_id));
      setMessage(keepBoth
        ? "已保留双方快照；本机版本进入待创建副本队列"
        : "已确认使用服务器版本");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "冲突处理失败");
    } finally {
      setBusyKey("");
    }
  }

  return <article id="settings-spaces" className="settings-card settings-task-card workspace-device-card">
    <header className="settings-section-head">
      <span><Cloud size={17} /></span>
      <div><h2>空间与设备</h2><p>查看默认云空间、已登记设备，并逐条确认离线冲突。</p></div>
      {status === "authenticated" && <button type="button" className="workspace-device-refresh" onClick={() => void load()} disabled={loading || Boolean(busyKey)} aria-label="刷新空间与设备"><RefreshCw size={14} className={loading ? "is-spinning" : ""} /></button>}
    </header>

    {status !== "authenticated" ? <div className="workspace-device-login-note">
      <strong>登录后管理云空间与设备</strong>
      <p>本机私密空间仍可在上方管理；设备登记和离线冲突属于账号同步能力。</p>
    </div> : <>
      <section className="workspace-device-group" aria-labelledby="workspace-cloud-heading">
        <div className="workspace-device-group-heading"><div><Cloud size={15} /><span><strong id="workspace-cloud-heading">云空间</strong><small>当前阶段固定使用个人默认空间</small></span></div><em>多空间与团队空间尚未开放</em></div>
        {workspaces.length ? <div className="workspace-cloud-list">{workspaces.map((workspace) => <div key={workspace.id} className="workspace-cloud-row">
          <span className="workspace-cloud-icon"><Cloud size={15} /></span>
          <span><strong>{workspace.name}</strong><small>{workspace.kind === "cloud" ? "云端同步" : workspace.kind} · 版本 {workspace.version}</small></span>
          {workspace.is_default && <em><CheckCircle2 size={12} />默认</em>}
        </div>)}</div> : !loading && <p className="workspace-device-empty">尚未找到可用空间。</p>}
      </section>

      <section className="workspace-device-group" aria-labelledby="workspace-device-heading">
        <div className="workspace-device-group-heading"><div><MonitorSmartphone size={15} /><span><strong id="workspace-device-heading">已登记设备</strong><small>{activeDevices.length} 台设备拥有同步权限</small></span></div></div>
        {devices.length ? <div className="workspace-device-list">{devices.map((device) => {
          const current = Boolean(installationId) && device.installation_id === installationId;
          const revoked = Boolean(device.revoked_at);
          return <div key={device.id} className={`workspace-device-row ${revoked ? "is-revoked" : ""}`}>
            <span className="workspace-device-icon"><MonitorSmartphone size={15} /></span>
            <span className="workspace-device-copy"><span><strong>{device.name}</strong>{current && <em>当前设备</em>}{revoked && <em className="is-revoked">已撤销</em>}</span><small title={device.last_seen_at}>最后在线 {formatDate(device.last_seen_at)} · {device.platform} · {device.app_version}</small></span>
            {!revoked && !current && <button type="button" onClick={() => void revokeDevice(device)} disabled={Boolean(busyKey)}>{busyKey === `device:${device.id}` ? <LoaderCircle size={13} className="is-spinning" /> : <ShieldCheck size={13} />}撤销</button>}
          </div>;
        })}</div> : !loading && <p className="workspace-device-empty">还没有桌面设备登记到这个账号。</p>}
      </section>

      <section className="workspace-device-group workspace-conflict-group" aria-labelledby="workspace-conflict-heading">
        <div className="workspace-device-group-heading"><div><GitMerge size={15} /><span><strong id="workspace-conflict-heading">离线冲突</strong><small>默认不覆盖，比较双方后由你确认</small></span></div>{conflicts.length > 0 && <em className="is-alert">{conflicts.length} 条待处理</em>}</div>
        {conflicts.length ? <div className="workspace-conflict-list">{conflicts.map((conflict) => <article key={conflict.operation_id} className="workspace-conflict-item">
          <header><span><AlertTriangle size={14} /><strong>{ENTITY_LABELS[conflict.entity_type]}发生版本冲突</strong></span><small>本机 v{conflict.base_version} · 服务器 v{conflict.server_version} · {formatDate(conflict.created_at)}</small></header>
          <div className="workspace-conflict-compare">
            <section><strong>本机快照</strong><pre>{snapshotText(conflict.local_snapshot)}</pre></section>
            <section><strong>服务器快照</strong><pre>{snapshotText(conflict.server_snapshot)}</pre></section>
          </div>
          <footer><button type="button" className="is-secondary" disabled={Boolean(busyKey)} onClick={() => void resolveConflict(conflict, "keep_server")}>保留服务器版</button><button type="button" className="is-primary" disabled={Boolean(busyKey)} onClick={() => void resolveConflict(conflict, "keep_both")}>{busyKey === `conflict:${conflict.operation_id}` ? <LoaderCircle size={13} className="is-spinning" /> : <GitMerge size={13} />}保留两份</button></footer>
        </article>)}</div> : !loading && <div className="workspace-conflict-empty"><CheckCircle2 size={16} /><span><strong>没有待确认冲突</strong><small>同步遇到版本分歧时会在这里保留双方快照。</small></span></div>}
      </section>
    </>}

    {loading && !workspaces.length && <p className="workspace-device-loading"><LoaderCircle size={14} className="is-spinning" />正在读取空间与设备…</p>}
    {loadError && <p className="workspace-device-error" role="alert">{loadError}</p>}
    {message && <p className="workspace-device-message" role="status">{message}</p>}
  </article>;
}
