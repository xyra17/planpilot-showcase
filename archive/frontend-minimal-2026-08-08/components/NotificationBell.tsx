"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

interface NotificationItem {
  id: string;
  date: string;
  summary: string;
  is_read: boolean;
  generated_at: string;
  generated_by: string;
}

interface NotificationsResponse {
  unread_count: number;
  items: NotificationItem[];
}

async function fetchNotifications(): Promise<NotificationsResponse | null> {
  try {
    return await api.get<NotificationsResponse>("/api/v1/notifications");
  } catch {
    return null;
  }
}

async function markAllRead(): Promise<void> {
  try {
    await api.patch("/api/v1/notifications/mark-read", {});
  } catch {
    // ignore
  }
}

async function clearNotifications(): Promise<void> {
  try {
    await api.del("/api/v1/notifications");
  } catch {
    // ignore
  }
}

export function NotificationBell() {
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const result = await fetchNotifications();
    if (result) setData(result);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const handleOpen = async () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPanelPos({ top: rect.bottom + 6, left: rect.left });
    }
    setOpen((v) => !v);
    if (!open && data && data.unread_count > 0) {
      await markAllRead();
      setData((prev) => prev ? { ...prev, unread_count: 0, items: prev.items.map(i => ({ ...i, is_read: true })) } : prev);
    }
  };

  const handleClear = async () => {
    await clearNotifications();
    setData((prev) => prev ? { ...prev, unread_count: 0, items: [] } : prev);
  };

  const unread = data?.unread_count ?? 0;

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleOpen}
        className="relative w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 transition"
        title="通知"
      >
        <Bell size={15} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full text-[9px] font-bold flex items-center justify-center px-0.5 text-white"
            style={{ background: "var(--accent)" }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="w-72 bg-white border border-gray-100 rounded-xl shadow-lg overflow-hidden"
          style={{ position: "fixed", top: panelPos.top, left: panelPos.left, zIndex: 9999 }}
        >
          <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">每日简报</span>
            {!!data?.items?.length && (
              <button onClick={handleClear} className="text-xs text-gray-400 hover:text-red-400 transition">清除</button>
            )}
          </div>
          <ul className="max-h-72 overflow-y-auto divide-y divide-gray-50">
            {!data?.items?.length && (
              <li className="px-4 py-6 text-center text-sm text-gray-400">暂无简报</li>
            )}
            {data?.items?.map((item) => (
              <li key={item.id} className={cn("px-4 py-3 hover:bg-gray-50 transition", !item.is_read && "bg-accent-light/40")}>
                <div className="text-xs text-gray-400 mb-1">{item.date}</div>
                <p className="text-sm text-gray-700 line-clamp-2">{item.summary}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
