"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  Bell,
  Bot,
  BrainCircuit,
  CalendarCheck2,
  FileText,
  Library,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Target,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PiloCompanion } from "@/components/technology/PiloCompanion";
import { UserAvatar } from "@/components/technology/UserAvatar";
import { useTheme } from "@/components/technology/ThemeProvider";
import { useAuth } from "@/components/technology/AuthProvider";
import { api } from "@/lib/api";
import { productApi } from "@/lib/technology/productApi";
import {
  PRODUCT_DATA_EVENT,
  PRODUCT_STORAGE_KEYS,
  readProductArray,
} from "@/lib/technology/productData";
import { capturePiloCoachTransition } from "@/lib/technology/piloTransition";
import { GUEST_RESOURCES } from "@/lib/technology/guestData";

const NAV_GROUPS = [
  {
    label: "计划管理",
    items: [
      { label: "今日计划", href: "/studio/work", icon: CalendarCheck2, match: "today" },
      { label: "目标管理", href: "/studio/work/goals", icon: Target, match: "goals" },
    ],
  },
  {
    label: "知识管理",
    items: [
      { label: "知识空间", href: "/studio/work/knowledge", icon: Library, match: "knowledge" },
      { label: "学习笔记", href: "/studio/work/notes", icon: FileText, match: "notes" },
    ],
  },
  {
    label: "智能助学",
    items: [
      { label: "学习伙伴", href: "/studio/coach", icon: Bot, match: "coach" },
    ],
  },
];

const BRAND_MARKS = {
  default: "/brand/planpilot-tech.svg",
  notebook: "/brand/planpilot-notebook.svg",
  dark: "/brand/planpilot-tech.svg",
} as const;

type SearchItem = {
  id: string;
  label: string;
  meta: string;
  href: string;
};

type NotificationItem = {
  id: string;
  date: string;
  summary: string;
  is_read: boolean;
  generated_at: string;
};

const DEFAULT_SEARCH_ITEMS: SearchItem[] = [
  { id: "task-guest-skill", label: "完成 Pandas 分组聚合练习", meta: "今日任务 · 掌握 Python 数据分析", href: "/studio/work" },
  { id: "goal-guest-skill", label: "掌握 Python 数据分析", meta: "目标 · 进度 63%", href: "/studio/work/goals" },
  { id: "note-guest-design", label: "自然映射不是“看起来像”", meta: "笔记 · 设计心理学主题阅读", href: "/studio/work/notes" },
];

export function ProductShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const { theme } = useTheme();
  const [brandImageFailed, setBrandImageFailed] = useState(false);
  const { user, status: authStatus } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [showSidebarGreeting, setShowSidebarGreeting] = useState(false);
  const [query, setQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState<SearchItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const searchRequestRef = useRef(0);
  const notificationRequestRef = useRef(0);
  const scrollbarTimersRef = useRef<Map<HTMLElement, number>>(new Map());
  const pageScrollbarTimerRef = useRef<number | null>(null);
  const searchReturnFocus = useRef<HTMLElement | null>(null);
  const inSettings = pathname.startsWith("/studio/settings");
  const searchItems = searchIndex.filter((item) =>
    `${item.label}${item.meta}`.toLowerCase().includes(query.toLowerCase()),
  );
  const sidebarDate = useMemo(
    () => new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long",
    }).format(new Date()),
    [],
  );
  const sidebarGreeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 6) return "夜深了";
    if (hour < 12) return "早上好";
    if (hour < 18) return "下午好";
    return "晚上好";
  }, []);

  useEffect(() => {
    setBrandImageFailed(false);
  }, [theme]);

  useEffect(() => {
    const interval = window.setInterval(
      () => setShowSidebarGreeting((current) => !current),
      9_000,
    );
    return () => window.clearInterval(interval);
  }, []);

  const refreshSearchItems = useCallback(async () => {
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setSearchIndex([]);
    if (authStatus === "authenticated" && !user?.id) return;
    if (authStatus === "authenticated") {
      try {
        const [tasks, goals, notes, resources] = await Promise.all([
          productApi.listTasks(),
          productApi.listGoals(),
          productApi.listNotes(),
          productApi.listKnowledgeFiles(),
        ]);
        if (requestId !== searchRequestRef.current) return;
        setSearchIndex([
          ...tasks.map((task) => ({ id: `task-${task.id}`, label: task.title, meta: `任务 · ${task.goalTitle}${task.done ? " · 已完成" : ""}`, href: "/studio/work" })),
          ...goals.map((goal) => ({ id: `goal-${goal.id}`, label: goal.title, meta: `目标 · ${goal.status}`, href: "/studio/work/goals" })),
          ...notes.map((note) => ({ id: `note-${note.id}`, label: note.title, meta: `笔记 · ${note.goalTitle || "未关联"}`, href: "/studio/work/notes" })),
          ...resources.map((resource) => ({ id: `resource-${resource.id}`, label: resource.name, meta: `资料 · ${resource.status === "ready" ? "AI 已索引" : "处理中"}`, href: "/studio/work/knowledge" })),
        ]);
      } catch {
        if (requestId === searchRequestRef.current) setSearchIndex([]);
      }
      return;
    }
    if (authStatus === "loading") return;
    const tasks = readProductArray<{
      id: number;
      title: string;
      goal: string;
      done: boolean;
    }>(PRODUCT_STORAGE_KEYS.tasks, []);
    const goals = readProductArray<{
      id: number;
      name: string;
      progress: number;
      status: string;
    }>(PRODUCT_STORAGE_KEYS.goals, []);
    const notes = readProductArray<{
      id: number;
      title: string;
      date: string;
      goal: string;
    }>(PRODUCT_STORAGE_KEYS.notes, []);

    const dynamicItems: SearchItem[] = [
      ...tasks.map((task) => ({
        id: `task-${task.id}`,
        label: task.title,
        meta: `今日任务 · ${task.goal}${task.done ? " · 已完成" : ""}`,
        href: "/studio/work",
      })),
      ...goals.map((goal) => ({
        id: `goal-${goal.id}`,
        label: goal.name,
        meta: `目标 · ${goal.status} · 进度 ${goal.progress}%`,
        href: "/studio/work/goals",
      })),
      ...notes.map((note) => ({
        id: `note-${note.id}`,
        label: note.title,
        meta: `笔记 · ${note.goal} · ${note.date}`,
        href: "/studio/work/notes",
      })),
    ];

    setSearchIndex([
      ...(dynamicItems.length ? dynamicItems : DEFAULT_SEARCH_ITEMS),
      ...GUEST_RESOURCES.map((resource) => ({
        id: `resource-${resource.id}`,
        label: resource.name,
        meta: `资料 · ${resource.library}`,
        href: "/studio/work/knowledge",
      })),
    ]);
  }, [authStatus, user?.id]);

  function closeSearch() {
    setSearchOpen(false);
    window.requestAnimationFrame(() => searchReturnFocus.current?.focus());
  }

  function keepSearchFocus(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled])',
      ),
    ).filter((element) => !element.hasAttribute("hidden"));
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    function openSearch() {
      searchReturnFocus.current = document.activeElement as HTMLElement | null;
      void refreshSearchItems();
      setSearchOpen(true);
      setNotificationsOpen(false);
    }

    window.addEventListener("planpilot:open-search", openSearch);
    return () => window.removeEventListener("planpilot:open-search", openSearch);
  }, [refreshSearchItems]);

  useEffect(() => {
    void refreshSearchItems();
    const refresh = () => { void refreshSearchItems(); };
    window.addEventListener(PRODUCT_DATA_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(PRODUCT_DATA_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refreshSearchItems]);

  useEffect(() => {
    const requestId = notificationRequestRef.current + 1;
    notificationRequestRef.current = requestId;
    setNotifications([]);
    if (authStatus !== "authenticated") {
      return;
    }
    void api.get<{ items: NotificationItem[] }>("/api/v1/notifications")
      .then((payload) => {
        if (requestId === notificationRequestRef.current) setNotifications(payload.items);
      })
      .catch(() => {
        if (requestId === notificationRequestRef.current) setNotifications([]);
      });
  }, [authStatus, user?.id]);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchReturnFocus.current = document.activeElement as HTMLElement | null;
        refreshSearchItems();
        setSearchOpen(true);
        setNotificationsOpen(false);
        return;
      }

      if (event.key !== "Escape") return;

      if (searchOpen) {
        event.preventDefault();
        closeSearch();
        return;
      }

      setNotificationsOpen(false);
      setMobileOpen(false);
    }

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [refreshSearchItems, searchOpen]);

  const revealActiveScrollbar = useCallback((element: HTMLElement) => {
    const currentTimer = scrollbarTimersRef.current.get(element);
    if (currentTimer) window.clearTimeout(currentTimer);
    element.classList.add("is-scrolling");
    const nextTimer = window.setTimeout(() => {
      element.classList.remove("is-scrolling");
      scrollbarTimersRef.current.delete(element);
    }, 720);
    scrollbarTimersRef.current.set(element, nextTimer);
  }, []);

  useEffect(() => {
    const scrollbarTimers = scrollbarTimersRef.current;

    function revealPageScrollbar() {
      document.documentElement.classList.add("is-scrolling");
      if (pageScrollbarTimerRef.current) window.clearTimeout(pageScrollbarTimerRef.current);
      pageScrollbarTimerRef.current = window.setTimeout(() => {
        document.documentElement.classList.remove("is-scrolling");
        pageScrollbarTimerRef.current = null;
      }, 720);
    }

    window.addEventListener("scroll", revealPageScrollbar, { passive: true });
    return () => {
      window.removeEventListener("scroll", revealPageScrollbar);
      if (pageScrollbarTimerRef.current) window.clearTimeout(pageScrollbarTimerRef.current);
      document.documentElement.classList.remove("is-scrolling");
      scrollbarTimers.forEach((timer, element) => {
        window.clearTimeout(timer);
        element.classList.remove("is-scrolling");
      });
      scrollbarTimers.clear();
    };
  }, []);

  return (
    <div
      className={`app-shell shell-theme-${theme}`}
      onScrollCapture={(event) => {
        if (event.target instanceof HTMLElement) revealActiveScrollbar(event.target);
      }}
      onPointerMove={(event) => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        event.currentTarget.style.setProperty("--page-glow-x", `${event.clientX}px`);
        event.currentTarget.style.setProperty("--page-glow-y", `${event.clientY}px`);
        event.currentTarget.dataset.pointerGlow = "active";
      }}
      onPointerLeave={(event) => {
        delete event.currentTarget.dataset.pointerGlow;
      }}
    >
      <div className="shell-atmosphere" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="page-pointer-glow" aria-hidden="true" />
      <aside className={`sidebar ${mobileOpen ? "is-open" : ""}`}>
        <div className="sidebar-head">
          <div className="sidebar-brand-row">
            <Link className="app-brand" href="/studio/work">
              <span className="brand-symbol" aria-hidden="true">
                {brandImageFailed ? (
                  <BrainCircuit className="brand-mark brand-mark-fallback" size={26} strokeWidth={1.8} />
                ) : (
                  <Image
                    className="brand-mark"
                    src={BRAND_MARKS[theme]}
                    alt=""
                    width={32}
                    height={32}
                    priority
                    unoptimized
                    onError={() => setBrandImageFailed(true)}
                  />
                )}
              </span>
              <span>PlanPilot</span>
            </Link>
            <span
              className="sidebar-rotating-status"
              aria-label={`${sidebarDate}；${sidebarGreeting}，${user?.username ?? "学习者"}。`}
              title={showSidebarGreeting ? `${sidebarGreeting}，${user?.username ?? "学习者"}。` : sidebarDate}
            >
              <span key={showSidebarGreeting ? "greeting" : "date"}>
                {showSidebarGreeting
                  ? <>{sidebarGreeting}，<em className="sidebar-username">{user?.username ?? "学习者"}</em>。</>
                  : sidebarDate}
              </span>
            </span>
            <button
              type="button"
              aria-label="通知"
              className={`notification-button sidebar-notification ${notifications.some((item) => !item.is_read) ? "has-unread" : ""}`}
              aria-expanded={notificationsOpen}
              onClick={() => {
                setNotificationsOpen((current) => {
                  const next = !current;
                  if (next && authStatus === "authenticated" && notifications.some((item) => !item.is_read)) {
                    void api.patch("/api/v1/notifications/mark-read", {}).then(() => {
                      setNotifications((items) => items.map((item) => ({ ...item, is_read: true })));
                    }).catch(() => undefined);
                  }
                  return next;
                });
                setSearchOpen(false);
              }}
            >
              <Bell size={16} />
            </button>
          </div>
          <button
            type="button"
            className="mobile-close"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        {notificationsOpen && (
          <div className="notification-popover sidebar-notification-popover">
            <header>
              <div>
                <strong>通知</strong>
                <span>{notifications.filter((item) => !item.is_read).length} 条未读</span>
              </div>
              <button
                type="button"
                onClick={() => setNotificationsOpen(false)}
                aria-label="关闭通知"
              >
                <X size={14} />
              </button>
            </header>
            {notifications.length ? notifications.slice(0, 6).map((item) => (
              <Link href="/studio/work" key={item.id} onClick={() => setNotificationsOpen(false)}>
                <span className="notice-icon"><Bot size={15} /></span>
                <div>
                  <strong>学习简报</strong>
                  <small>{item.summary || "今日学习简报已生成"}</small>
                  <time>{item.date}</time>
                </div>
              </Link>
            )) : (
              <div className="notification-empty"><Bell size={17} /><span>{authStatus === "authenticated" ? "暂时没有新通知" : "登录后查看学习简报"}</span></div>
            )}
          </div>
        )}

        <nav className="sidebar-nav" aria-label="产品导航">
          {NAV_GROUPS.map((group) => (
            <section className="sidebar-nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active =
                  item.match === "today"
                    ? pathname === "/studio/work"
                    : item.match === "goals"
                      ? pathname.startsWith("/studio/work/goals")
                      : item.match === "knowledge"
                        ? pathname.startsWith("/studio/work/knowledge")
                        : item.match === "notes"
                          ? pathname.startsWith("/studio/work/notes")
                        : pathname === "/studio/coach" || pathname.startsWith("/studio/coach/proposals");
                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={active ? "is-active" : ""}
                    onClick={(event) => {
                      setMobileOpen(false);
                      if (
                        item.match !== "coach"
                        || pathname.startsWith("/studio/coach")
                        || event.metaKey
                        || event.ctrlKey
                        || event.shiftKey
                        || event.altKey
                        || event.button !== 0
                      ) return;
                      capturePiloCoachTransition();
                    }}
                  >
                    <Icon size={17} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </section>
          ))}
        </nav>

        <div className="sidebar-foot">
          {user?.is_admin && (
            <Link href="/admin" className="admin-product-entry sidebar-admin-entry">
              <span><ShieldCheck size={14} /></span>
              <span>
                <strong>进入管理后台</strong>
                <small>产品证据与系统运营</small>
              </span>
              <ArrowUpRight size={13} />
            </Link>
          )}
          <div className="sidebar-account-card">
            <div className="sidebar-console-status" aria-hidden="true">
              <i />
              <span>{theme === "notebook" ? "LEARNING JOURNAL" : "WORKSPACE"}</span>
              <b>READY</b>
            </div>
            <div className="sidebar-account-row">
              <UserAvatar className="sidebar-account-avatar" avatarUrl={user?.avatar_url} username={user?.username ?? "访客"} size={32} />
              <div>
                <strong>{user?.username ?? "访客"}</strong>
                {user?.is_admin && <small>管理员</small>}
              </div>
              <Link
                href="/studio/settings"
                className={`profile-settings sidebar-account-settings ${inSettings ? "is-active" : ""}`}
                aria-label="设置"
              >
                <Settings size={15} />
              </Link>
            </div>
          </div>
        </div>
      </aside>

      {mobileOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <div className="app-main">
        <button
          type="button"
          className="mobile-menu shell-mobile-menu"
          aria-label="打开导航"
          onClick={() => setMobileOpen(true)}
        >
          <Menu size={19} />
        </button>
        <main className="page-content">{children}</main>
      </div>

      {searchOpen && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={closeSearch}
        >
          <section
            className="global-search"
            role="dialog"
            aria-modal="true"
            aria-label="全局搜索"
            onKeyDown={keepSearchFocus}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <Search size={18} />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索任务、目标、笔记或资料…"
              />
              <button type="button" onClick={closeSearch}>
                ESC
              </button>
            </header>
            <div className="search-results">
              <small>{query ? "搜索结果" : "最近访问"}</small>
              {searchItems.length ? (
                searchItems.map((item) => (
                  <Link
                    key={item.id}
                    href={item.href}
                    onClick={closeSearch}
                  >
                    <span><Search size={14} /></span>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.meta}</small>
                    </div>
                    <span>打开</span>
                  </Link>
                ))
              ) : (
                <div className="search-empty">
                  没有找到“{query}”，换个关键词试试。
                </div>
              )}
            </div>
          </section>
        </div>
      )}
      <PiloCompanion />
    </div>
  );
}
