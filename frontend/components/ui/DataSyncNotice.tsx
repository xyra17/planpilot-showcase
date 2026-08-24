"use client";

import { AlertCircle, LoaderCircle, LogIn, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { navigateToLogin, noticeRequiresLogin } from "@/lib/technology/noticeActions";

type DataSyncNoticeProps = {
  title: string;
  message?: string;
  loading?: boolean;
  retryLabel?: string;
  onRetry?: () => void;
  loginHref?: string;
};

export function DataSyncNotice({
  title,
  message,
  loading = false,
  retryLabel = "重试",
  onRetry,
  loginHref,
}: DataSyncNoticeProps) {
  const Icon = loading ? LoaderCircle : AlertCircle;
  const requiresLogin = !loading && noticeRequiresLogin(message);
  const ActionIcon = requiresLogin ? LogIn : RefreshCw;
  const actionLabel = requiresLogin ? "去登录" : retryLabel;
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  const notice = (
    <aside
      className={`pp-data-sync-notice ${loading ? "is-loading" : "is-error"}`}
      role={loading ? "status" : "alert"}
      aria-live={loading ? "polite" : "assertive"}
    >
      <span className="pp-data-sync-notice-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="pp-data-sync-notice-copy">
        <strong>{title}</strong>
        {message && <small>{message}</small>}
      </span>
      {!loading && (requiresLogin || onRetry) && (
        <button type="button" onClick={requiresLogin ? () => navigateToLogin(loginHref) : onRetry}>
          <ActionIcon size={14} aria-hidden="true" />
          {actionLabel}
        </button>
      )}
    </aside>
  );

  return portalTarget ? createPortal(notice, portalTarget) : null;
}
