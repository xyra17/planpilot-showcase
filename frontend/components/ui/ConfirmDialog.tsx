"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
};
type PendingConfirm = ConfirmOptions & { resolve: (value: boolean) => void };

const ConfirmContext = createContext<{
  confirmAction: (options: ConfirmOptions) => Promise<boolean>;
}>({ confirmAction: async () => false });

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirmAction = useCallback((options: ConfirmOptions) => (
    new Promise<boolean>((resolve) => setPending({ ...options, resolve }))
  ), []);

  const finish = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finish, pending]);

  return (
    <ConfirmContext.Provider value={{ confirmAction }}>
      {children}
      {pending && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[1px]" onMouseDown={() => finish(false)}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="global-confirm-title"
            aria-describedby="global-confirm-description"
            className="w-full max-w-sm rounded-2xl border border-gray-100 bg-white p-5 shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
                <AlertTriangle size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="global-confirm-title" className="text-base font-semibold text-gray-900">{pending.title}</h2>
                <p id="global-confirm-description" className="mt-1.5 text-sm leading-6 text-gray-500">{pending.description}</p>
              </div>
              <button onClick={() => finish(false)} aria-label="关闭确认窗口" className="rounded-lg p-1 text-gray-400 hover:bg-gray-100">
                <X size={14} />
              </button>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button ref={cancelRef} onClick={() => finish(false)} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
                {pending.cancelLabel ?? "取消"}
              </button>
              <button
                onClick={() => finish(true)}
                className={`rounded-xl px-4 py-2 text-sm font-medium text-white ${pending.tone === "danger" ? "bg-red-500 hover:bg-red-600" : ""}`}
                style={pending.tone === "danger" ? undefined : { backgroundColor: "var(--accent)" }}
              >
                {pending.confirmLabel ?? "确认"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirmDialog() {
  return useContext(ConfirmContext);
}
