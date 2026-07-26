"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

type ToastTone = "success" | "error" | "info";
type ToastItem = { id: number; message: string; tone: ToastTone };
type ToastApi = { showToast: (message: string, tone?: ToastTone) => void };

const ToastContext = createContext<ToastApi>({ showToast: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setItems((current) => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => remove(id), 3600);
  }, [remove]);

  const value = useMemo(() => ({ showToast }), [showToast]);
  const toneClass: Record<ToastTone, string> = {
    success: "border-emerald-200 text-emerald-700",
    error: "border-red-200 text-red-600",
    info: "border-gray-200 text-gray-600",
  };
  const ToneIcon: Record<ToastTone, typeof Info> = {
    success: CheckCircle2,
    error: AlertCircle,
    info: Info,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {items.map((item) => {
          const Icon = ToneIcon[item.tone];
          return (
            <div key={item.id} className={`pointer-events-auto flex items-start gap-2 rounded-xl border bg-white px-3 py-2.5 shadow-xl ${toneClass[item.tone]}`}>
              <Icon size={15} className="mt-0.5 flex-shrink-0" />
              <p className="min-w-0 flex-1 text-sm leading-5">{item.message}</p>
              <button onClick={() => remove(item.id)} aria-label="关闭提示" className="rounded p-0.5 opacity-60 hover:opacity-100">
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
