"use client";

import { AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";

type DataSyncNoticeProps = {
  title: string;
  message?: string;
  loading?: boolean;
  retryLabel?: string;
  onRetry?: () => void;
};

export function DataSyncNotice({
  title,
  message,
  loading = false,
  retryLabel = "重试",
  onRetry,
}: DataSyncNoticeProps) {
  const Icon = loading ? LoaderCircle : AlertCircle;

  return (
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
      {!loading && onRetry && (
        <button type="button" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />
          {retryLabel}
        </button>
      )}
    </aside>
  );
}
