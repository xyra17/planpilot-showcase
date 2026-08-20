"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  useTheme, type ThemeMode,
} from "@/lib/theme-context";
import { JOURNAL_PALETTES, STYLE_COLOR_OPTIONS, THEME_LABELS } from "@/lib/theme-presets";
import { useAuthStore } from "@/lib/stores/authStore";
import { api } from "@/lib/api";
import { Monitor, Moon, Eye, Leaf, Pencil, NotebookPen, Check, ChevronDown, ChevronRight, LogOut, X, Trash2, Globe, Settings2, UserRound, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: ThemeMode; label: string; desc: string; icon: React.ElementType; preview: string }[] = [
  { value: "default",  label: "简约原生", desc: "保留原版页面与自然阅读节奏", icon: Leaf, preview: "bg-white border-gray-200"      },
  { value: "dark",     label: "暗黑", desc: "深色背景，护眼减蓝光",     icon: Moon,    preview: "bg-slate-800 border-slate-600"  },
  { value: "eye-care", label: "护眼", desc: "暖黄纸质感，长时阅读友好", icon: Eye,     preview: "bg-amber-50 border-amber-200"   },
  { value: "journal",  label: "手账纸稿", desc: "纸张、铅笔与便签质感", icon: NotebookPen, preview: "bg-[#f2eadb] border-[#9a8b75]" },
];

function CollapseSection({
  title, kicker, description, open, onToggle, children,
}: {
  title: string; kicker: string; description: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="settings-collapse-section bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <button
        onClick={onToggle}
        className="settings-collapse-toggle w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition"
      >
        <span className="settings-collapse-title-wrap">
          <span className="settings-collapse-kicker">{kicker}</span>
          <span className="settings-collapse-title">{title}</span>
          <span className="settings-collapse-description">{description}</span>
        </span>
        {open
          ? <ChevronDown size={16} className="text-gray-400" />
          : <ChevronRight size={16} className="text-gray-400" />}
      </button>
      {open && <div className="settings-collapse-content px-5 pb-5">{children}</div>}
    </div>
  );
}

function InnerCollapse({
  title, open, onToggle, children,
}: {
  title: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="settings-inner-collapse border border-gray-100 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="settings-inner-collapse-toggle w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition"
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{title}</span>
        {open
          ? <ChevronDown size={14} className="text-gray-400" />
          : <ChevronRight size={14} className="text-gray-400" />}
      </button>
      {open && <div className="settings-inner-collapse-content px-4 pb-4">{children}</div>}
    </div>
  );
}

export default function SettingsPage() {
  const {
    mode, colorScheme, journalPalette,
    setMode, setColorScheme, setJournalPalette,
  } = useTheme();
  const { user, logout, updateUser, changePassword } = useAuthStore();
  const router = useRouter();
  const [personalOpen, setPersonalOpen] = useState(true);
  const [colorOpen, setColorOpen] = useState(true);
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [savingUsername, setSavingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [editingEmail, setEditingEmail] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteCountdown, setDeleteCountdown] = useState(3);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [editingPassword, setEditingPassword] = useState(false);
  const [currentPwInput, setCurrentPwInput] = useState("");
  const [newPwInput, setNewPwInput] = useState("");
  const [confirmPwInput, setConfirmPwInput] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const currentPwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!deleteOpen) return;
    setDeleteCountdown(3);
    const timer = setInterval(() => {
      setDeleteCountdown((c) => {
        if (c <= 1) { clearInterval(timer); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [deleteOpen]);

  async function handleDeleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.del("/api/v1/auth/me");
      logout();
      router.replace("/login");
    } catch (e) {
      setDeleteError((e as Error).message);
      setDeleting(false);
    }
  }

  function handleLogout() {
    logout();
    router.replace("/login");
  }

  async function chooseTechnologyExperience() {
    localStorage.setItem("planpilot-experience", "technology");
    try {
      await updateUser({ ui_experience: "technology" });
    } finally {
      window.location.assign("/studio/work");
    }
  }

  async function chooseClassicTheme(nextMode: ThemeMode) {
    setMode(nextMode);
    const uiTheme = nextMode === "journal" ? "notebook" : nextMode === "dark" ? "dark" : "base";
    try {
      await updateUser({ ui_experience: "minimal", ui_theme: uiTheme });
    } catch {
      // The visual choice remains available on this device when sync is offline.
    }
  }

  function startEditUsername() {
    setUsernameInput(user?.username ?? "");
    setUsernameError(null);
    setEditingUsername(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancelEditUsername() {
    setEditingUsername(false);
    setUsernameError(null);
  }

  async function saveUsername() {
    const trimmed = usernameInput.trim();
    if (trimmed === user?.username) { setEditingUsername(false); return; }
    if (trimmed.length < 2 || trimmed.length > 32) {
      setUsernameError("用户名长度需在 2~32 个字符之间");
      return;
    }
    setSavingUsername(true);
    setUsernameError(null);
    try {
      await updateUser({ username: trimmed });
      setEditingUsername(false);
    } catch (e) {
      setUsernameError((e as Error).message);
    } finally {
      setSavingUsername(false);
    }
  }

  function startEditEmail() {
    setEmailInput(user?.email ?? "");
    setEmailError(null);
    setEditingEmail(true);
    setTimeout(() => emailRef.current?.focus(), 0);
  }

  function cancelEditEmail() {
    setEditingEmail(false);
    setEmailError(null);
  }

  function startEditPassword() {
    setCurrentPwInput("");
    setNewPwInput("");
    setConfirmPwInput("");
    setPasswordError(null);
    setPasswordSuccess(false);
    setEditingPassword(true);
    setTimeout(() => currentPwRef.current?.focus(), 0);
  }

  function cancelEditPassword() {
    setEditingPassword(false);
    setPasswordError(null);
  }

  async function savePassword() {
    if (!currentPwInput) { setPasswordError("请输入当前密码"); return; }
    if (newPwInput.length < 6) { setPasswordError("新密码不能少于 6 位"); return; }
    if (newPwInput !== confirmPwInput) { setPasswordError("两次输入的密码不一致"); return; }
    setSavingPassword(true);
    setPasswordError(null);
    try {
      await changePassword(currentPwInput, newPwInput);
      setEditingPassword(false);
      setPasswordSuccess(true);
      setTimeout(() => setPasswordSuccess(false), 3000);
    } catch (e) {
      setPasswordError((e as Error).message);
    } finally {
      setSavingPassword(false);
    }
  }

  async function saveEmail() {
    const trimmed = emailInput.trim();
    if (trimmed === user?.email) { setEditingEmail(false); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError("请输入有效的邮箱地址");
      return;
    }
    setSavingEmail(true);
    setEmailError(null);
    try {
      await updateUser({ email: trimmed });
      setEditingEmail(false);
    } catch (e) {
      setEmailError((e as Error).message);
    } finally {
      setSavingEmail(false);
    }
  }

  const joinDate = user?.created_at
    ? (() => { const d = new Date(user.created_at); return `${d.getFullYear()}年${d.getMonth() + 1}月`; })()
    : "—";

  return (
    <div className="settings-page settings-page-flat settings-page-v2">
      <header className="settings-v2-header">
        <div className="settings-v2-heading">
          <div className="settings-v2-heading-icon" aria-hidden="true"><Settings2 size={22} /></div>
          <div>
            <p className="settings-v2-eyebrow">PREFERENCES</p>
            <h1>设置</h1>
            <p className="settings-v2-subtitle">调整 PlanPilot 的工作方式、材质主题和账号信息。</p>
          </div>
        </div>
        <div className="settings-v2-save-state"><CheckCircle2 size={16} /><span>更改会自动保存</span></div>
      </header>

      <div className="settings-v2-grid">
        {/* ── 个性化（可折叠） ── */}
        <CollapseSection
          title="个性化你的 PlanPilot 使用体验"
          kicker="界面偏好"
          description="先选择产品布局，再选择材质和配色。"
          open={personalOpen}
          onToggle={() => setPersonalOpen((v) => !v)}
        >
          <div className="mb-6">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">一级 · 产品布局</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={chooseTechnologyExperience}
                className="group flex min-h-[96px] items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-indigo-300 hover:bg-indigo-50/60 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-indigo-200"><Monitor size={18} /></span>
                <span><strong className="block text-sm text-gray-800">风格 A · 科技工作台</strong><small className="mt-1 block text-xs leading-5 text-gray-500">切换到信号优先、紧凑高效的新版界面。</small></span>
              </button>
              <div className="relative flex min-h-[96px] items-start gap-3 rounded-xl border-2 border-accent bg-accent-light p-4 text-left">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-accent shadow-sm"><Leaf size={18} /></span>
                <span><strong className="block text-sm text-accent">风格 B · 原版简约空间</strong><small className="mt-1 block text-xs leading-5 text-gray-500">完整保留原版 PlanPilot 的页面、侧栏与交互结构。</small></span>
                <Check className="absolute right-3 top-3 text-accent" size={15} />
              </div>
            </div>
          </div>

          {/* 界面风格 */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">二级 · 材质主题</p>
            <div className="grid grid-cols-2 gap-3">
              {THEME_OPTIONS.filter((opt) => opt.value !== "eye-care").map((opt) => {
                const Icon = opt.icon;
                const active = mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    data-testid={`theme-mode-${opt.value}`}
                    onClick={() => void chooseClassicTheme(opt.value)}
                    className={cn(
                      "theme-style-option relative flex items-start gap-3 p-4 rounded-xl border-2 text-left transition",
                      active ? "border-accent bg-accent-light" : "border-gray-100 bg-gray-50 hover:border-gray-200"
                    )}
                  >
                    <div className={cn("w-10 h-10 rounded-xl border-2 flex items-center justify-center flex-shrink-0", opt.preview)}>
                      <Icon size={16} className={active ? "text-accent" : "text-gray-500"} />
                    </div>
                    <div>
                      <div className={cn("text-sm font-semibold", active ? "text-accent" : "text-gray-800")}>{opt.label}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{opt.desc}</div>
                    </div>
                    {active && (
                      <div className="absolute top-3 right-3 w-5 h-5 bg-accent rounded-full flex items-center justify-center">
                        <Check size={11} className="text-white" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="theme-isolated-palette">
            <InnerCollapse
              title={`${THEME_LABELS[mode]}专属配色`}
              open={colorOpen}
              onToggle={() => setColorOpen((value) => !value)}
            >
              <div className="mb-3 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
                <p className="text-xs text-gray-500">切换界面风格时，各自的配色选择会独立保留。</p>
                <span className="theme-isolation-badge">风格隔离</span>
              </div>
              <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
                {mode === "journal"
                  ? JOURNAL_PALETTES.map((palette) => {
                      const active = journalPalette === palette.value;
                      return (
                        <button
                          key={palette.value}
                          data-testid={`theme-palette-${palette.value}`}
                          onClick={() => setJournalPalette(palette.value)}
                          className={cn(
                            "theme-palette-option flex items-center gap-3 rounded-xl border-2 p-3 text-left transition",
                            active ? "border-accent bg-accent-light" : "border-gray-100 bg-white hover:border-gray-200 hover:bg-gray-50"
                          )}
                        >
                          <span className="flex flex-shrink-0 overflow-hidden rounded-md border border-black/5">
                            {palette.swatches.map((color) => <i key={color} className="h-8 w-6" style={{ backgroundColor: color }} />)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <strong className={cn("block text-sm font-medium", active ? "text-accent" : "text-gray-800")}>{palette.label}</strong>
                            <small className="mt-0.5 block text-[10px] text-gray-400">{palette.description}</small>
                          </span>
                          {active && <Check size={13} className="flex-shrink-0 text-accent" />}
                        </button>
                      );
                    })
                  : STYLE_COLOR_OPTIONS[mode].map((palette) => {
                      const active = colorScheme === palette.value;
                      return (
                        <button
                          key={palette.value}
                          data-testid={`theme-palette-${palette.value}`}
                          onClick={() => setColorScheme(palette.value)}
                          className={cn(
                            "theme-palette-option flex items-center gap-3 rounded-xl border-2 p-3 text-left transition",
                            active ? "border-accent bg-accent-light" : "border-gray-100 bg-white hover:border-gray-200 hover:bg-gray-50"
                          )}
                        >
                          <span className="flex flex-shrink-0 overflow-hidden rounded-md border border-black/5">
                            {palette.swatches.map((color) => <i key={color} className="h-8 w-5" style={{ backgroundColor: color }} />)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <strong className={cn("block text-sm font-medium", active ? "text-accent" : "text-gray-800")}>{palette.label}</strong>
                            <small className="mt-0.5 block text-[10px] text-gray-400">{palette.description}</small>
                          </span>
                          {active && <Check size={13} className="flex-shrink-0 text-accent" />}
                        </button>
                      );
                    })}
              </div>
            </InnerCollapse>
          </div>
        </CollapseSection>

        {/* ── 账号 ── */}
        <div className="settings-account-card bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="settings-account-heading px-5 py-4 border-b border-gray-50 flex items-center justify-between">
            <div className="settings-account-heading-cluster">
              <div className="settings-account-heading-icon" aria-hidden="true"><UserRound size={17} /></div>
              <div>
                <span className="settings-account-heading-title">账号与安全</span>
                <small>管理个人资料与登录方式</small>
              </div>
            </div>
            <button
              onClick={() => setDeleteOpen(true)}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-500 transition"
            >
              <Trash2 size={12} />
              注销账号
            </button>
          </div>
          <div className="divide-y divide-gray-50">
            {/* 用户名行（可编辑） */}
            <div className="flex items-center justify-between px-5 py-3.5 min-h-[52px]">
              <span className="text-sm text-gray-500 flex-shrink-0">用户名</span>
              {editingUsername ? (
                <div className="flex items-center gap-2 flex-1 ml-4">
                  <div className="flex-1">
                    <input
                      ref={inputRef}
                      value={usernameInput}
                      onChange={(e) => setUsernameInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveUsername(); if (e.key === "Escape") cancelEditUsername(); }}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-accent text-gray-800"
                      maxLength={32}
                    />
                    {usernameError && <p className="text-xs text-red-500 mt-1">{usernameError}</p>}
                  </div>
                  <button
                    onClick={saveUsername}
                    disabled={savingUsername}
                    className="w-7 h-7 flex items-center justify-center rounded-full bg-accent text-white hover:bg-accent-dark transition flex-shrink-0 disabled:opacity-60"
                  >
                    <Check size={13} />
                  </button>
                  <button
                    onClick={cancelEditUsername}
                    className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 transition flex-shrink-0"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-800">{user?.username ?? "—"}</span>
                  <button
                    onClick={startEditUsername}
                    className="text-gray-400 hover:text-gray-600 transition"
                    title="修改用户名"
                  >
                    <Pencil size={13} />
                  </button>
                </div>
              )}
            </div>
            {/* 邮箱 */}
            <div className="flex items-center justify-between px-5 py-3.5 min-h-[52px]">
              <span className="text-sm text-gray-500 flex-shrink-0">邮箱</span>
              {editingEmail ? (
                <div className="flex items-center gap-2 flex-1 ml-4">
                  <div className="flex-1">
                    <input
                      ref={emailRef}
                      type="email"
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveEmail(); if (e.key === "Escape") cancelEditEmail(); }}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-accent text-gray-800"
                    />
                    {emailError && <p className="text-xs text-red-500 mt-1">{emailError}</p>}
                  </div>
                  <button
                    onClick={saveEmail}
                    disabled={savingEmail}
                    className="w-7 h-7 flex items-center justify-center rounded-full bg-accent text-white hover:bg-accent-dark transition flex-shrink-0 disabled:opacity-60"
                  >
                    <Check size={13} />
                  </button>
                  <button
                    onClick={cancelEditEmail}
                    className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 transition flex-shrink-0"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-800">{user?.email ?? "—"}</span>
                  <button onClick={startEditEmail} className="text-gray-400 hover:text-gray-600 transition" title="修改邮箱">
                    <Pencil size={13} />
                  </button>
                </div>
              )}
            </div>
            {/* 密码行 */}
            <div className="px-5 py-3.5 border-t border-gray-50">
              {editingPassword ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">修改密码</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={savePassword}
                        disabled={savingPassword}
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-accent text-white hover:bg-accent-dark transition disabled:opacity-60"
                      >
                        <Check size={13} />
                      </button>
                      <button
                        onClick={cancelEditPassword}
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 transition"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                  <input
                    ref={currentPwRef}
                    type="password"
                    placeholder="当前密码"
                    value={currentPwInput}
                    onChange={(e) => setCurrentPwInput(e.target.value)}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-accent text-gray-800"
                  />
                  <input
                    type="password"
                    placeholder="新密码（至少 6 位）"
                    value={newPwInput}
                    onChange={(e) => setNewPwInput(e.target.value)}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-accent text-gray-800"
                  />
                  <input
                    type="password"
                    placeholder="确认新密码"
                    value={confirmPwInput}
                    onChange={(e) => setConfirmPwInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") savePassword(); if (e.key === "Escape") cancelEditPassword(); }}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-accent text-gray-800"
                  />
                  {passwordError && <p className="text-xs text-red-500">{passwordError}</p>}
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500">密码</span>
                  <div className="flex items-center gap-2">
                    {passwordSuccess
                      ? <span className="text-xs text-green-600 font-medium">修改成功</span>
                      : <span className="text-sm font-medium text-gray-400 tracking-widest">••••••••</span>
                    }
                    <button onClick={startEditPassword} className="text-gray-400 hover:text-gray-600 transition" title="修改密码">
                      <Pencil size={13} />
                    </button>
                  </div>
                </div>
              )}
            </div>
            {/* 加入时间 */}
            <div className="flex items-center justify-between px-5 py-3.5 border-t border-gray-50">
              <span className="text-sm text-gray-500">加入时间</span>
              <span className="text-sm font-medium text-gray-800">{joinDate}</span>
            </div>
            {/* 学习时区 */}
            <div className="flex items-center justify-between px-5 py-4 border-t border-gray-50">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
                  <Globe size={13} style={{ color: "var(--accent)" }} />
                </div>
                <div>
                  <span className="text-sm text-gray-600 font-medium">学习时区</span>
                  <p className="text-[10px] text-gray-400 leading-tight">Agent 使用本地时间理解你的学习习惯</p>
                </div>
              </div>
              <label className="inline-flex items-center gap-1 rounded-full border pl-3 pr-2 py-1.5 cursor-pointer transition"
                style={{ borderColor: "var(--accent-muted)", backgroundColor: "var(--accent-light)" }}>
                <select
                  aria-label="学习时区"
                  value={user?.timezone ?? "Asia/Shanghai"}
                  onChange={(event) => void updateUser({ timezone: event.target.value })}
                  className="bg-transparent focus:outline-none text-xs font-semibold appearance-none cursor-pointer"
                  style={{ color: "var(--accent)" }}
                >
                  <option value="Asia/Shanghai">中国标准时间</option>
                  <option value="Asia/Tokyo">东京时间</option>
                  <option value="America/New_York">纽约时间</option>
                  <option value="Europe/London">伦敦时间</option>
                  <option value="UTC">UTC</option>
                </select>
                <ChevronDown size={11} className="flex-shrink-0 pointer-events-none" style={{ color: "var(--accent)" }} />
              </label>
            </div>          </div>
          <div className="px-5 py-4 border-t border-gray-50 flex justify-center">
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-sm text-red-500 hover:text-red-600 transition font-medium"
            >
              <LogOut size={15} />
              退出登录
            </button>
          </div>
        </div>
      </div>

      {/* ── 注销账号确认弹窗 ── */}
      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-label="注销账号确认" className="journal-dialog bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
                <Trash2 size={18} className="text-red-500" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900">注销账号</h3>
                <p className="text-xs text-gray-400 mt-0.5">此操作不可撤销</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-5 leading-relaxed">
              注销后，你的所有学习记录、目标、知识库数据将被<span className="font-semibold text-red-500">永久删除</span>，且无法恢复。
            </p>
            {deleteError && <p className="text-xs text-red-500 mb-3">{deleteError}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteOpen(false)}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleteCountdown > 0 || deleting}
                className="flex-1 py-2.5 rounded-xl bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {deleting ? "注销中…" : deleteCountdown > 0 ? `确认注销 (${deleteCountdown})` : "确认注销"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
