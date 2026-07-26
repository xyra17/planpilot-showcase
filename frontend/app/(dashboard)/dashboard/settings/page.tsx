"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  useTheme, type ThemeMode, type ColorScheme, type JournalPalette,
} from "@/lib/theme-context";
import { useAuthStore } from "@/lib/stores/authStore";
import { api } from "@/lib/api";
import { Monitor, Moon, Eye, Pencil, NotebookPen, Check, ChevronDown, ChevronRight, LogOut, X, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: ThemeMode; label: string; desc: string; icon: React.ElementType; preview: string }[] = [
  { value: "default",  label: "默认", desc: "干净的白底蓝色系",         icon: Monitor, preview: "bg-white border-gray-200"      },
  { value: "dark",     label: "暗黑", desc: "深色背景，护眼减蓝光",     icon: Moon,    preview: "bg-slate-800 border-slate-600"  },
  { value: "eye-care", label: "护眼", desc: "暖黄纸质感，长时阅读友好", icon: Eye,     preview: "bg-amber-50 border-amber-200"   },
  { value: "journal",  label: "手账纸稿", desc: "纸张、铅笔与便签质感", icon: NotebookPen, preview: "bg-[#f2eadb] border-[#9a8b75]" },
];

const JOURNAL_PALETTES: {
  value: JournalPalette; label: string; desc: string; swatches: string[];
}[] = [
  { value: "wood", label: "原木纸稿", desc: "米白纸 · 石墨 · 赭石", swatches: ["#F7F0E2", "#37342F", "#B57935"] },
  { value: "slate", label: "青灰纸稿", desc: "灰白纸 · 深青墨 · 灰绿", swatches: ["#EEF1ED", "#29413F", "#66877A"] },
  { value: "newspaper", label: "旧报纸稿", desc: "淡黄纸 · 炭黑墨 · 暗红", swatches: ["#F1E4C4", "#302E2A", "#8E453D"] },
  { value: "night", label: "深夜纸稿", desc: "深色纸 · 浅石墨 · 暖金", swatches: ["#25231F", "#EEE4D2", "#D39A58"] },
];

type ColorGroup = { label: string; items: { value: ColorScheme; label: string; swatches: string[] }[] };

const COLOR_GROUPS: ColorGroup[] = [
  {
    label: "标准色系",
    items: [
      { value: "blue",    label: "天空蓝", swatches: ["#bfdbfe", "#60a5fa", "#2563eb", "#1d4ed8"] },
      { value: "indigo",  label: "靛青",   swatches: ["#c7d2fe", "#818cf8", "#4f46e5", "#3730a3"] },
      { value: "violet",  label: "紫罗兰", swatches: ["#ddd6fe", "#a78bfa", "#7c3aed", "#5b21b6"] },
      { value: "rose",    label: "玫瑰红", swatches: ["#fecdd3", "#fb7185", "#e11d48", "#9f1239"] },
      { value: "amber",   label: "琥珀橙", swatches: ["#fde68a", "#fbbf24", "#d97706", "#92400e"] },
      { value: "emerald", label: "翡翠绿", swatches: ["#a7f3d0", "#34d399", "#059669", "#065f46"] },
      { value: "teal",    label: "青碧",   swatches: ["#99f6e4", "#2dd4bf", "#0d9488", "#115e59"] },
      { value: "mint",    label: "薄荷绿", swatches: ["#F1F8F6", "#EAF4F1", "#D6ECE8", "#0A7067"] },
    ],
  },
  {
    label: "特色色系",
    items: [
      { value: "rainbow", label: "彩虹", swatches: ["#f97316", "#ec4899", "#8b5cf6", "#3b82f6"] },
    ],
  },
  {
    label: "莫兰迪系",
    items: [
      { value: "morandi-rose",       label: "玫瑰灰", swatches: ["#e8cece", "#c9a0a0", "#b08d8d", "#8c6e6e"] },
      { value: "morandi-sage",       label: "鼠尾草", swatches: ["#c4d4ca", "#9ab5a5", "#7a9485", "#5e7567"] },
      { value: "morandi-stone",      label: "石灰岩", swatches: ["#d4d0ce", "#aaa5a0", "#8a8480", "#6b6460"] },
      { value: "morandi-terracotta", label: "赤陶土", swatches: ["#e8c4b4", "#c89a82", "#b07d65", "#8c6248"] },
      { value: "morandi-lavender",   label: "薰衣草", swatches: ["#d4c8e8", "#b0a0d0", "#9080b0", "#6b5b8c"] },
      { value: "morandi-blue",       label: "莫兰迪蓝", swatches: ["#F2F6FB", "#EAF1F9", "#DCE8F6", "#1E5EA8"] },
      { value: "morandi-purple",     label: "莫兰迪紫", swatches: ["#F4F3FB", "#EDEBF7", "#E4E1F5", "#4B3F9E"] },
      { value: "silver",             label: "中性灰", swatches: ["#6E6E73", "#AEAEB2", "#E5E5EA", "#F5F5F7"] },
    ],
  },
];

function CollapseSection({
  title, open, onToggle, children,
}: {
  title: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition"
      >
        <span className="text-sm font-semibold text-gray-800">{title}</span>
        {open
          ? <ChevronDown size={16} className="text-gray-400" />
          : <ChevronRight size={16} className="text-gray-400" />}
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}

function InnerCollapse({
  title, open, onToggle, children,
}: {
  title: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition"
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{title}</span>
        {open
          ? <ChevronDown size={14} className="text-gray-400" />
          : <ChevronRight size={14} className="text-gray-400" />}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
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
    <div className="p-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">设置</h1>
        <p className="text-sm text-gray-500 mt-1">个性化你的 PlanPilot 使用体验</p>
      </div>

      <div className="space-y-4">
        {/* ── 个性化（可折叠） ── */}
        <CollapseSection
          title="个性化你的 PlanPilot 使用体验"
          open={personalOpen}
          onToggle={() => setPersonalOpen((v) => !v)}
        >
          {/* 界面风格 */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">界面风格</p>
            <div className="grid grid-cols-2 gap-3">
              {THEME_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setMode(opt.value)}
                    className={cn(
                      "relative flex items-start gap-3 p-4 rounded-xl border-2 text-left transition",
                      active ? "border-blue-600 bg-blue-50" : "border-gray-100 bg-gray-50 hover:border-gray-200"
                    )}
                  >
                    <div className={cn("w-10 h-10 rounded-xl border-2 flex items-center justify-center flex-shrink-0", opt.preview)}>
                      <Icon size={16} className={active ? "text-blue-600" : "text-gray-500"} />
                    </div>
                    <div>
                      <div className={cn("text-sm font-semibold", active ? "text-blue-600" : "text-gray-800")}>{opt.label}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{opt.desc}</div>
                    </div>
                    {active && (
                      <div className="absolute top-3 right-3 w-5 h-5 bg-blue-600 rounded-full flex items-center justify-center">
                        <Check size={11} className="text-white" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="journal-palette-section">
            <InnerCollapse
              title="手账配色"
              open={colorOpen}
              onToggle={() => setColorOpen((v) => !v)}
            >
              <div className="grid grid-cols-1 gap-2 pt-1">
                {JOURNAL_PALETTES.map((palette) => {
                  const active = journalPalette === palette.value;
                  return (
                    <button
                      key={palette.value}
                      onClick={() => setJournalPalette(palette.value)}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border-2 p-3 text-left transition",
                        active
                          ? "border-blue-600 bg-blue-50"
                          : "border-gray-100 bg-white hover:border-gray-200 hover:bg-gray-50"
                      )}
                    >
                      <div className="flex flex-shrink-0 gap-1">
                        {palette.swatches.map((color) => (
                          <span
                            key={color}
                            className="h-8 w-7 rounded-md border border-black/5"
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={cn("text-sm font-medium", active ? "text-blue-600" : "text-gray-800")}>
                          {palette.label}
                        </p>
                        <p className="mt-0.5 text-xs text-gray-400">{palette.desc}</p>
                      </div>
                      {active && (
                        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-600">
                          <Check size={11} className="text-white" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </InnerCollapse>
          </div>

          {/* 色彩方案（二级折叠） */}
          <div className="standard-color-section">
            <InnerCollapse
              title="色彩方案"
              open={colorOpen}
              onToggle={() => setColorOpen((v) => !v)}
            >
              <div className="space-y-5 mt-1">
                {COLOR_GROUPS.map((group) => (
                  <div key={group.label}>
                    <p className="text-xs text-gray-400 mb-2 font-medium">{group.label}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {group.items.map((opt) => {
                        const active = colorScheme === opt.value;
                        const isRainbow = opt.value === "rainbow";
                        return (
                          <button
                            key={opt.value}
                            onClick={() => setColorScheme(opt.value)}
                            className={cn(
                              "flex items-center gap-3 p-3 rounded-xl border-2 text-left transition",
                              active ? "border-blue-600 bg-blue-50" : "border-gray-100 bg-white hover:border-gray-200 hover:bg-gray-50"
                            )}
                          >
                            {isRainbow ? (
                              <div
                                className="w-20 h-6 rounded-md flex-shrink-0"
                                style={{ background: "linear-gradient(90deg,#f97316,#ec4899,#8b5cf6,#3b82f6)" }}
                              />
                            ) : (
                              <div className="flex gap-0.5 flex-shrink-0">
                                {opt.swatches.map((color) => (
                                  <div key={color} className="w-5 h-6 rounded-[4px]" style={{ backgroundColor: color }} />
                                ))}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className={cn("text-sm font-medium truncate", active ? "text-blue-600" : "text-gray-800")}>
                                {opt.label}
                              </div>
                            </div>
                            {active && (
                              <div className="w-4 h-4 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0">
                                <Check size={9} className="text-white" />
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </InnerCollapse>
          </div>
        </CollapseSection>

        {/* ── 账号 ── */}
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">账号</span>
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
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400 text-gray-800"
                      maxLength={32}
                    />
                    {usernameError && <p className="text-xs text-red-500 mt-1">{usernameError}</p>}
                  </div>
                  <button
                    onClick={saveUsername}
                    disabled={savingUsername}
                    className="w-7 h-7 flex items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 transition flex-shrink-0 disabled:opacity-60"
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
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400 text-gray-800"
                    />
                    {emailError && <p className="text-xs text-red-500 mt-1">{emailError}</p>}
                  </div>
                  <button
                    onClick={saveEmail}
                    disabled={savingEmail}
                    className="w-7 h-7 flex items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 transition flex-shrink-0 disabled:opacity-60"
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
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-60"
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
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400 text-gray-800"
                  />
                  <input
                    type="password"
                    placeholder="新密码（至少 6 位）"
                    value={newPwInput}
                    onChange={(e) => setNewPwInput(e.target.value)}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400 text-gray-800"
                  />
                  <input
                    type="password"
                    placeholder="确认新密码"
                    value={confirmPwInput}
                    onChange={(e) => setConfirmPwInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") savePassword(); if (e.key === "Escape") cancelEditPassword(); }}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400 text-gray-800"
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
            <div className="flex items-center justify-between px-5 py-3.5">
              <span className="text-sm text-gray-500">加入时间</span>
              <span className="text-sm font-medium text-gray-800">{joinDate}</span>
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
