"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CircleHelp, X } from "lucide-react";

export type ConfirmTone = "danger" | "warning" | "primary";

export type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  kicker?: string;
  tone?: ConfirmTone;
};
type PendingConfirm = ConfirmOptions & { resolve: (value: boolean) => void };

type ConfirmationDialogProps = ConfirmOptions & {
  onCancel: () => void;
  onConfirm: () => void;
};

const ConfirmContext = createContext<{
  confirmAction: (options: ConfirmOptions) => Promise<boolean>;
}>({ confirmAction: async () => false });

export function ConfirmationDialog({
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  kicker,
  tone = "primary",
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const generatedId = useId().replace(/:/g, "");
  const titleId = `confirm-title-${generatedId}`;
  const descriptionId = `confirm-description-${generatedId}`;
  const resolvedKicker = kicker ?? (tone === "danger" ? "删除确认" : tone === "warning" ? "请确认修改" : "操作确认");
  const Icon = tone === "primary" ? CircleHelp : AlertTriangle;

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="pp-confirm-backdrop" onMouseDown={onCancel}>
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={`pp-confirm-dialog is-${tone}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" onClick={onCancel} aria-label="关闭确认窗口" className="pp-confirm-close">
          <X size={18} />
        </button>
        <header className="pp-confirm-heading">
          <span className="pp-confirm-icon">
            <Icon size={19} />
          </span>
          <div>
            <h2 className="pp-confirm-kicker">{resolvedKicker}</h2>
            <p id={titleId} className="pp-confirm-title">{title}</p>
          </div>
        </header>
        <p id={descriptionId} className="pp-confirm-description">{description}</p>
        <footer className="pp-confirm-actions">
          <button ref={cancelRef} onClick={onCancel} className="pp-confirm-cancel">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`pp-confirm-submit ${tone === "danger" ? "pp-danger-button" : tone === "warning" ? "pp-warning-button" : ""}`}
          >
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirmAction = useCallback((options: ConfirmOptions) => (
    new Promise<boolean>((resolve) => setPending({ ...options, resolve }))
  ), []);

  const finish = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={{ confirmAction }}>
      {children}
      {pending && (
        <ConfirmationDialog
          title={pending.title}
          description={pending.description}
          confirmLabel={pending.confirmLabel}
          cancelLabel={pending.cancelLabel}
          kicker={pending.kicker}
          tone={pending.tone}
          onCancel={() => finish(false)}
          onConfirm={() => finish(true)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirmDialog() {
  return useContext(ConfirmContext);
}
