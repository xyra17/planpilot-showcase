"use client";

import {
  AlertCircle,
  ArrowRight,
  BrainCircuit,
  CalendarClock,
  Camera,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  Database,
  Download,
  LayoutDashboard,
  Laptop,
  LoaderCircle,
  LogOut,
  Mail,
  Moon,
  NotebookPen,
  Palette,
  PencilLine,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/components/technology/AuthProvider";
import { AvatarCropDialog } from "@/components/technology/AvatarCropDialog";
import { ClockTimePicker } from "@/components/technology/ClockTimePicker";
import { UserAvatar } from "@/components/technology/UserAvatar";
import { DesktopStorageSettings } from "@/components/technology/DesktopStorageSettings";
import { WorkspaceDeviceSettings } from "@/components/technology/WorkspaceDeviceSettings";
import { DataSyncNotice } from "@/components/ui/DataSyncNotice";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  type AccentColor,
  type SurfaceTheme,
  resolveTheme,
  useTheme,
} from "@/components/technology/ThemeProvider";
import {
  WEEKDAY_KEYS,
  weeklyAvailabilityFromPreferences,
  type AvailabilityClockRange,
  type WeekdayKey,
  type WeeklyAvailability,
} from "@/lib/technology/dayScheduler";
import { readScopedJson, scopedStorageKey, writeScopedJson } from "@/lib/technology/scopedStorage";
import { privacyApi, type ConsentPatch, type PrivacyConsent, type PrivacyPurpose } from "@/lib/privacy-api";

const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  mon: "周一", tue: "周二", wed: "周三", thu: "周四",
  fri: "周五", sat: "周六", sun: "周日",
};

function normalizeWeeklyAvailability(value: WeeklyAvailability): WeeklyAvailability {
  return Object.fromEntries(WEEKDAY_KEYS.map((day) => [
    day,
    (value[day] ?? []).map((range) => ({ ...range })).sort((a, b) => a.start.localeCompare(b.start)),
  ])) as WeeklyAvailability;
}

function availabilityError(value: WeeklyAvailability): string {
  if (!WEEKDAY_KEYS.some((day) => (value[day]?.length ?? 0) > 0)) return "请至少保留一个可用时间段";
  for (const day of WEEKDAY_KEYS) {
    const ranges = [...(value[day] ?? [])].sort((a, b) => a.start.localeCompare(b.start));
    for (const range of ranges) {
      if (!range.start || !range.end || range.end <= range.start) return `${WEEKDAY_LABELS[day]}的结束时间必须晚于开始时间`;
    }
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index].start < ranges[index - 1].end) return `${WEEKDAY_LABELS[day]}的时间段不能重叠`;
    }
  }
  return "";
}

function reminderEmailValid(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const SURFACE_THEMES: Array<{ id: SurfaceTheme; name: string; description: string; icon: typeof LayoutDashboard }> = [
  { id: "base", name: "原生外观", description: "保持当前布局自身的设计语言", icon: LayoutDashboard },
  { id: "notebook", name: "手帐纸张", description: "复古纸张、铅笔线与暖色墨迹", icon: NotebookPen },
  { id: "dark", name: "暗黑模式", description: "适合夜间使用的低亮度界面", icon: Moon },
];

const ACCENTS: Record<AccentColor, { name: string; colors: [string, string, string] }> = {
  violet: { name: "星云紫", colors: ["#745bff", "#9b8cff", "#6ee7c5"] },
  ocean: { name: "远海蓝", colors: ["#397fd8", "#6aa7ff", "#6edbc7"] },
  forest: { name: "松林绿", colors: ["#39735a", "#6da789", "#b8cf8a"] },
  wood: { name: "原木纸稿", colors: ["#F7F0E2", "#37342F", "#B57935"] },
  slate: { name: "青灰纸稿", colors: ["#EEF1ED", "#29413F", "#66877A"] },
  newspaper: { name: "旧报纸稿", colors: ["#F1E4C4", "#302E2A", "#8E453D"] },
  wheat: { name: "麦香素描", colors: ["#F3E8CF", "#4A4840", "#A98A52"] },
  night: { name: "深夜纸稿", colors: ["#25231F", "#EEE4D2", "#D39A58"] },
};

export default function SettingsPage() {
  const { user, status, updateProfile, uploadAvatar, logout } = useAuth();
  const {
    surfaceTheme,
    accent,
    availableAccents,
    setSurfaceTheme,
    setAccent,
    saveAppearance,
  } = useTheme();
  const { confirmAction } = useConfirmDialog();
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderTime, setReminderTime] = useState("21:30");
  const [reminderEmail, setReminderEmail] = useState("");
  const [reminderEmailDraft, setReminderEmailDraft] = useState("");
  const [editingReminderEmail, setEditingReminderEmail] = useState(false);
  const [emailReminderStatus, setEmailReminderStatus] = useState<{
    configured: boolean; recipient: string; email_verified: boolean; timezone: string;
  } | null>(null);
  const [focusTarget, setFocusTarget] = useState("90");
  const [studyPreferencesReady, setStudyPreferencesReady] = useState(false);
  const [selectedAvailabilityDay, setSelectedAvailabilityDay] = useState<WeekdayKey>("mon");
  const [weeklyAvailability, setWeeklyAvailability] = useState<WeeklyAvailability>(() =>
    weeklyAvailabilityFromPreferences(["evening"], ["mon", "tue", "wed", "thu", "fri"]),
  );
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [profile, setProfile] = useState({ username: "", email: "" });
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [localExportBusy, setLocalExportBusy] = useState(false);
  const [privacyConsent, setPrivacyConsent] = useState<PrivacyConsent | null>(null);
  const [privacyState, setPrivacyState] = useState<"loading" | "idle" | "saving" | "saved" | "error">("idle");
  const [privacyError, setPrivacyError] = useState("");
  const [failedConsentPatch, setFailedConsentPatch] = useState<ConsentPatch | null>(null);
  const [privacyLoadAttempt, setPrivacyLoadAttempt] = useState(0);
  const [showPersonalizationChoice, setShowPersonalizationChoice] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarCropFile, setAvatarCropFile] = useState<File | null>(null);
  const [activeSection, setActiveSection] = useState("settings-appearance");
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status !== "authenticated") {
      setPrivacyConsent(null);
      setPrivacyState("idle");
      return;
    }
    let active = true;
    setPrivacyState("loading");
    setPrivacyError("");
    setFailedConsentPatch(null);
    void privacyApi.getConsent().then((consent) => {
      if (!active) return;
      setPrivacyConsent(consent);
      setPrivacyState("idle");
    }).catch((reason) => {
      if (!active) return;
      setPrivacyError(reason instanceof Error ? reason.message : "隐私选择加载失败");
      setPrivacyState("error");
    });
    return () => { active = false; };
  }, [privacyLoadAttempt, status]);

  useEffect(() => {
    if (user) {
      setProfile({ username: user.username, email: user.email });
      setTimezone(user.timezone ?? "Asia/Shanghai");
      setWeeklyAvailability(normalizeWeeklyAvailability(
        user.weekly_availability
          ?? weeklyAvailabilityFromPreferences(user.availability_windows, user.study_days),
      ));
    }
  }, [user]);

  useEffect(() => {
    try {
      const saved = readScopedJson("planpilot-v2-preferences", user?.id, {} as {
        timezone?: string; reminderEnabled?: boolean; reminderTime?: string; focusTarget?: string;
      }, "planpilot-v2-preferences");
      const accountPreferences = user?.account_preferences?.study_preferences;
      if (!user?.timezone && saved.timezone) setTimezone(saved.timezone);
      setReminderEnabled(typeof accountPreferences?.reminder_enabled === "boolean" ? accountPreferences.reminder_enabled : saved.reminderEnabled ?? false);
      setReminderTime(accountPreferences?.reminder_time ?? saved.reminderTime ?? "21:30");
      setReminderEmail(accountPreferences?.reminder_email ?? user?.email ?? "");
      setFocusTarget(accountPreferences?.focus_target ?? saved.focusTarget ?? "90");
      if (!user?.weekly_availability) {
        const localWeekly = readScopedJson<WeeklyAvailability | null>("planpilot-v2-weekly-availability", user?.id, null, "planpilot-v2-weekly-availability");
        if (localWeekly) setWeeklyAvailability(normalizeWeeklyAvailability(localWeekly));
      }
    } catch { /* Invalid legacy settings fall back to safe defaults. */ }
    setStudyPreferencesReady(true);
  }, [user?.account_preferences?.study_preferences, user?.email, user?.id, user?.timezone, user?.weekly_availability]);

  useEffect(() => {
    writeScopedJson("planpilot-v2-preferences", user?.id, { timezone, reminderEnabled, reminderTime, focusTarget }, "planpilot-v2-preferences");
    if (!studyPreferencesReady || status !== "authenticated") return;
    const registeredEmail = user?.email?.trim().toLowerCase() ?? "";
    const normalizedReminderEmail = reminderEmail.trim().toLowerCase();
    if (normalizedReminderEmail && !reminderEmailValid(normalizedReminderEmail)) return;
    const next = {
      reminder_enabled: reminderEnabled,
      reminder_time: reminderTime,
      reminder_channel: "email" as const,
      reminder_email: normalizedReminderEmail && normalizedReminderEmail !== registeredEmail ? normalizedReminderEmail : null,
      focus_target: focusTarget,
    };
    const current = user?.account_preferences?.study_preferences;
    const currentEditable = {
      reminder_enabled: current?.reminder_enabled,
      reminder_time: current?.reminder_time ?? "21:30",
      reminder_channel: current?.reminder_channel ?? "email",
      reminder_email: current?.reminder_email ?? null,
      focus_target: current?.focus_target,
    };
    if (JSON.stringify(currentEditable) === JSON.stringify(next)) return;
    const timer = window.setTimeout(() => {
      void updateProfile({ account_preferences: { study_preferences: next } });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [focusTarget, reminderEmail, reminderEnabled, reminderTime, status, studyPreferencesReady, timezone, updateProfile, user?.account_preferences?.study_preferences, user?.email, user?.id]);

  useEffect(() => {
    if (status !== "authenticated") {
      setEmailReminderStatus(null);
      return;
    }
    let active = true;
    void api.get<{ configured: boolean; recipient: string; email_verified: boolean; timezone: string }>("/api/v1/notifications/email-reminder-status")
      .then((value) => { if (active) setEmailReminderStatus(value); })
      .catch(() => { if (active) setEmailReminderStatus(null); });
    return () => { active = false; };
  }, [status, user?.email, user?.email_verified, user?.timezone]);

  function startEditingReminderEmail() {
    setReminderEmailDraft(reminderEmail || emailReminderStatus?.recipient || user?.email || "");
    setEditingReminderEmail(true);
  }

  function saveReminderEmail() {
    const next = reminderEmailDraft.trim().toLowerCase();
    if (!next || !reminderEmailValid(next)) {
      feedback("请输入有效的提醒邮箱", true);
      return;
    }
    setReminderEmail(next);
    setEditingReminderEmail(false);
    feedback("提醒邮箱已更新");
  }

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const sectionIds = ["settings-appearance", "settings-preferences", "settings-reminders", "settings-desktop", "settings-spaces", "settings-privacy", "settings-account"];
    let frame = 0;
    const updateActiveSection = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const marker = Math.min(360, window.innerHeight * 0.42);
        let current = sectionIds[0];
        for (const id of sectionIds) {
          const section = document.getElementById(id);
          if (section && section.getBoundingClientRect().top <= marker) current = id;
        }
        const requestedId = window.location.hash.slice(1);
        const requestedSection = sectionIds.includes(requestedId) ? document.getElementById(requestedId) : null;
        if (requestedSection) {
          const requestedRect = requestedSection.getBoundingClientRect();
          if (requestedRect.top < window.innerHeight && requestedRect.bottom > 0) current = requestedId;
        }
        setActiveSection(current);
      });
    };
    updateActiveSection();
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    };
  }, []);

  function feedback(message: string, isError = false) {
    setError(isError);
    setNotice(message);
  }

  async function chooseSurfaceTheme(nextTheme: SurfaceTheme) {
    setSurfaceTheme(nextTheme);
    setSyncBusy(true);
    try {
      await saveAppearance({ surfaceTheme: nextTheme });
      feedback(`已应用${SURFACE_THEMES.find((item) => item.id === nextTheme)?.name}`);
    } catch { feedback("主题已在本机切换，但账号同步失败", true); }
    finally { setSyncBusy(false); }
  }

  async function chooseAccent(nextAccent: AccentColor) {
    setAccent(nextAccent);
    setSyncBusy(true);
    try {
      await saveAppearance({ accent: nextAccent });
      feedback(`配色已更新为${ACCENTS[nextAccent].name}`);
    } catch { feedback("配色已在本机切换，但账号同步失败", true); }
    finally { setSyncBusy(false); }
  }

  async function changeTimezone(nextTimezone: string) {
    setTimezone(nextTimezone);
    if (status !== "authenticated") { feedback("学习时区已保存在当前设备"); return; }
    setSyncBusy(true);
    try { await updateProfile({ timezone: nextTimezone }); feedback("学习时区已同步到账号"); }
    catch { feedback("时区同步失败，请稍后重试", true); }
    finally { setSyncBusy(false); }
  }

  function updateAvailabilityRange(index: number, patch: Partial<AvailabilityClockRange>) {
    setWeeklyAvailability((current) => ({
      ...current,
      [selectedAvailabilityDay]: (current[selectedAvailabilityDay] ?? []).map((range, rangeIndex) =>
        rangeIndex === index ? { ...range, ...patch } : range,
      ),
    }));
  }

  function addAvailabilityRange() {
    setWeeklyAvailability((current) => ({
      ...current,
      [selectedAvailabilityDay]: [...(current[selectedAvailabilityDay] ?? []), { start: "19:00", end: "21:00" }],
    }));
  }

  function removeAvailabilityRange(index: number) {
    setWeeklyAvailability((current) => ({
      ...current,
      [selectedAvailabilityDay]: (current[selectedAvailabilityDay] ?? []).filter((_, rangeIndex) => rangeIndex !== index),
    }));
  }

  function copyAvailabilityToWorkdays() {
    const source = (weeklyAvailability[selectedAvailabilityDay] ?? []).map((range) => ({ ...range }));
    setWeeklyAvailability((current) => ({
      ...current,
      mon: source.map((range) => ({ ...range })),
      tue: source.map((range) => ({ ...range })),
      wed: source.map((range) => ({ ...range })),
      thu: source.map((range) => ({ ...range })),
      fri: source.map((range) => ({ ...range })),
    }));
    feedback("已沿用至其他工作日，保存后生效");
  }

  async function saveWeeklyAvailability() {
    const normalized = normalizeWeeklyAvailability(weeklyAvailability);
    const validation = availabilityError(normalized);
    if (validation) { feedback(validation, true); return; }
    setAvailabilityBusy(true);
    try {
      writeScopedJson("planpilot-v2-weekly-availability", user?.id, normalized, "planpilot-v2-weekly-availability");
      setWeeklyAvailability(normalized);
      if (status === "authenticated") await updateProfile({ weekly_availability: normalized });
      feedback(status === "authenticated" ? "每周可用时间已同步到账号" : "每周可用时间已保存在当前设备");
    } catch (reason) {
      feedback(reason instanceof Error ? reason.message : "可用时间保存失败", true);
    } finally {
      setAvailabilityBusy(false);
    }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (status !== "authenticated") return;
    setBusy(true);
    try {
      await updateProfile({ username: profile.username.trim(), email: profile.email.trim() });
      setEditingProfile(false);
      feedback("账号资料已更新");
    } catch (reason) { feedback(reason instanceof Error ? reason.message : "账号资料更新失败", true); }
    finally { setBusy(false); }
  }

  async function changeAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(file.type)) {
      feedback("头像仅支持 JPG、PNG 或 WebP", true);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      feedback("头像不能超过 5 MB", true);
      return;
    }
    setAvatarCropFile(file);
  }

  async function saveCroppedAvatar(file: File) {
    setAvatarBusy(true);
    try {
      await uploadAvatar(file);
      setAvatarCropFile(null);
      feedback("头像已更新，并同步到账号");
    } catch (reason) {
      feedback(reason instanceof Error ? reason.message : "头像更新失败，请稍后重试", true);
      throw reason;
    } finally {
      setAvatarBusy(false);
    }
  }

  async function updatePrivacyConsent(patch: ConsentPatch, successMessage = "隐私选择已保存") {
    if (status !== "authenticated") { feedback("登录后才能同步隐私选择", true); return; }
    setPrivacyState("saving");
    setPrivacyError("");
    setFailedConsentPatch(null);
    try {
      const next = await privacyApi.updateConsent({
        ...patch,
        request_id: `${Date.now()}-${crypto.randomUUID()}`,
      });
      setPrivacyConsent(next);
      setPrivacyState("saved");
      setShowPersonalizationChoice(false);
      feedback(successMessage);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "隐私选择保存失败";
      setPrivacyError(message);
      setFailedConsentPatch(patch);
      setPrivacyState("error");
      feedback(message, true);
    }
  }

  async function togglePrivacyPurpose(purpose: PrivacyPurpose) {
    if (!privacyConsent || privacyState === "saving") return;
    if (purpose === "personalization_enabled" && privacyConsent.personalization_enabled) {
      setShowPersonalizationChoice(true);
      return;
    }
    await updatePrivacyConsent({ [purpose]: !privacyConsent[purpose] });
  }

  async function eraseDerivedData() {
    const alreadyDisabled = privacyConsent?.personalization_enabled === false;
    if (!await confirmAction({
      title: alreadyDisabled ? "清除已保留的学习画像与派生数据？" : "关闭个性化并清除派生数据？",
      description: `系统生成的学习观察、画像、认知推断和学习记忆会被清除。你创建的目标、任务、笔记和知识内容不会删除。此操作不可撤销${alreadyDisabled ? "；个性化会保持关闭" : "，并会关闭个性化建议"}。`,
      confirmLabel: alreadyDisabled ? "清除已保留数据" : "关闭并清除",
      tone: "danger",
    })) return;
    await updatePrivacyConsent(
      { personalization_enabled: false, erase_derived_data: true },
      alreadyDisabled ? "已保留的派生数据已清除，个性化保持关闭" : "个性化已关闭，系统生成的派生数据已清除",
    );
  }

  async function exportData() {
    setExportBusy(true);
    try {
      const size = await privacyApi.exportServerData();
      feedback(`服务器端可携带数据已导出 · ${Math.max(1, Math.ceil(size / 1024))} KB`);
    } catch (reason) {
      feedback(reason instanceof Error ? reason.message : "服务器数据导出失败，请稍后重试", true);
    } finally {
      setExportBusy(false);
    }
  }

  async function exportLocalCache() {
    setLocalExportBusy(true);
    try {
      const data: Record<string, unknown> = { exported_at: new Date().toISOString(), scope: "this_device_cache", user_id: user?.id ?? null };
      const scopedPrefix = scopedStorageKey("", user?.id);
      const accountId = user?.id ?? "guest";
      const coachPrefixes = [
        `planpilot:pilo-conversations:${accountId}`,
        `planpilot:pilo-preferences:${accountId}`,
      ];
      const guestLegacyPrefixes = [
        "planpilot-v2-",
        "planpilot.",
        "planpilot-knowledge-",
        "pp-pilo-",
        "planpilot:pilo-",
      ];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key) continue;
        const isCurrentScopedData = key.startsWith(scopedPrefix);
        const isCurrentCoachCache = coachPrefixes.some((prefix) => key.startsWith(prefix));
        const isGuestLegacyData = !user && guestLegacyPrefixes.some((prefix) => key.startsWith(prefix));
        if (!isCurrentScopedData && !isCurrentCoachCache && !isGuestLegacyData) continue;
        const value = localStorage.getItem(key);
        try { data[key] = value ? JSON.parse(value) : value; } catch { data[key] = value; }
      }
      const size = privacyApi.downloadLocalCache(data);
      feedback(`本机缓存副本已导出 · ${Math.max(1, Math.ceil(size / 1024))} KB`);
    } catch {
      feedback("本机缓存导出失败，请稍后重试", true);
    } finally {
      setLocalExportBusy(false);
    }
  }

  const previewTheme = resolveTheme(surfaceTheme);
  const selectedAvailabilityRanges = weeklyAvailability[selectedAvailabilityDay] ?? [];
  const reminderToggleOn = status === "authenticated" && reminderEnabled;
  const reminderToggleDisabled = status !== "authenticated"
    || (!reminderEnabled && (!emailReminderStatus?.configured || !emailReminderStatus.email_verified));
  const saveIndicator = syncBusy || availabilityBusy || busy || avatarBusy || privacyState === "saving"
    ? { label: "正在保存…", icon: <LoaderCircle size={13} className="is-spinning" />, tone: "is-saving" }
    : notice && error
      ? { label: "保存失败", icon: <AlertCircle size={13} />, tone: "is-error" }
      : notice
        ? { label: "已保存", icon: <Check size={13} />, tone: "is-saved" }
        : { label: "自动保存已开启", icon: <Check size={13} />, tone: "is-saved" };

  return (
    <div className="settings-page settings-page-redesign settings-task-redesign">
      <header className="workspace-pagebar goals-redesign-heading settings-task-heading">
        <div className="workspace-page-title"><small>SETTINGS</small><h1>设置中心</h1><span>集中管理工作台外观、学习时间和账号偏好；账号项与可用时间支持登录同步。</span></div>
        <div className={`settings-save-state ${saveIndicator.tone}`} aria-live="polite">{saveIndicator.icon}{saveIndicator.label}</div>
      </header>

      <div className="settings-workspace">
        <nav className="settings-section-nav" aria-label="设置分类">
          <div className="settings-nav-heading"><strong>设置分类</strong><span>随页面滚动定位</span></div>
          <a href="#settings-appearance" className={activeSection === "settings-appearance" ? "is-active" : ""} aria-current={activeSection === "settings-appearance" ? "location" : undefined} onClick={() => setActiveSection("settings-appearance")}><Palette size={15} /><span>外观</span></a>
          <a href="#settings-preferences" className={activeSection === "settings-preferences" ? "is-active" : ""} aria-current={activeSection === "settings-preferences" ? "location" : undefined} onClick={() => setActiveSection("settings-preferences")}><CalendarClock size={15} /><span>可用时间</span></a>
          <a href="#settings-reminders" className={activeSection === "settings-reminders" ? "is-active" : ""} aria-current={activeSection === "settings-reminders" ? "location" : undefined} onClick={() => setActiveSection("settings-reminders")}><CalendarClock size={15} /><span>时间与提醒</span></a>
          <a href="#settings-desktop" className={activeSection === "settings-desktop" ? "is-active" : ""} aria-current={activeSection === "settings-desktop" ? "location" : undefined} onClick={() => setActiveSection("settings-desktop")}><Laptop size={15} /><span>桌面与本机</span></a>
          <a href="#settings-spaces" className={activeSection === "settings-spaces" ? "is-active" : ""} aria-current={activeSection === "settings-spaces" ? "location" : undefined} onClick={() => setActiveSection("settings-spaces")}><Database size={15} /><span>空间与设备</span></a>
          <a href="#settings-privacy" className={activeSection === "settings-privacy" ? "is-active" : ""} aria-current={activeSection === "settings-privacy" ? "location" : undefined} onClick={() => setActiveSection("settings-privacy")}><ShieldCheck size={15} /><span>AI 与隐私</span></a>
          <a href="#settings-account" className={activeSection === "settings-account" ? "is-active" : ""} aria-current={activeSection === "settings-account" ? "location" : undefined} onClick={() => setActiveSection("settings-account")}><UserRound size={15} /><span>账户</span></a>
        </nav>

        <div className="settings-content-stack">
      <section id="settings-appearance" className="settings-card appearance-card">
        <header className="settings-section-head compact"><span><NotebookPen size={17} /></span><div><h2>材质主题</h2><p>选择适合当前环境的表面质感，不改变页面结构。</p></div></header>
        <div className="style-options surface-theme-options">
          {SURFACE_THEMES.map((item) => {
            const Icon = item.icon; const selected = surfaceTheme === item.id;
            const resolved = resolveTheme(item.id);
            return <button type="button" key={item.id} className={`style-option ${selected ? "is-selected" : ""}`} onClick={() => void chooseSurfaceTheme(item.id)} aria-pressed={selected}>
              <span className={`theme-preview preview-${resolved}`}><i /><b /><em /></span>
              <span className="style-option-copy"><span><Icon size={15} /><strong>{item.name}</strong></span><small>{item.description}</small></span>
              {selected && <Check className="style-check" size={14} />}
            </button>;
          })}
        </div>

        <div className="color-scheme"><div><strong>强调配色</strong><span>{previewTheme === "notebook" ? "纸张主题拥有独立的复古配色。" : "强调色不会改变当前布局结构。"}</span></div><div className="color-options">
          {availableAccents.map((colorId) => { const color = ACCENTS[colorId]; const selected = accent === colorId; return <button type="button" key={colorId} className={selected ? "is-selected" : ""} onClick={() => void chooseAccent(colorId)} aria-pressed={selected}><span className="palette-swatches">{color.colors.map((value) => <i key={value} style={{ background: value }} />)}</span><span>{color.name}</span>{selected && <Check size={13} />}</button>; })}
        </div></div>
      </section>

      <section id="settings-preferences" className="settings-card preferences-card">
        <div id="settings-availability" className="weekly-settings-block">
          <header className="settings-section-head settings-unified-heading weekly-settings-heading"><span><CalendarClock size={17} /></span><div><h2>每周可用时间</h2><p>设置每周可以学习的时间，自动规划只会在这些时间内安排任务。</p></div><button type="button" className="availability-heading-save" disabled={availabilityBusy} onClick={() => void saveWeeklyAvailability()}><Save size={14} />{availabilityBusy ? "保存中…" : "保存安排"}</button></header>
        <div className="weekly-availability-editor">
          <div className="availability-time-card">
            <div className="availability-day-tabs" role="tablist" aria-label="选择星期">
              {WEEKDAY_KEYS.map((day) => {
                const selected = selectedAvailabilityDay === day;
                const count = weeklyAvailability[day]?.length ?? 0;
                return <button
                  type="button"
                  role="tab"
                  key={day}
                  aria-selected={selected}
                  aria-label={`${WEEKDAY_LABELS[day]}，${count ? `${count} 可用时段` : "休息"}`}
                  data-segment-count={count ? `${count} 可用时段` : "休息"}
                  className={`${selected ? "is-active" : ""} ${count ? "has-ranges" : "is-rest"}`}
                  onClick={() => setSelectedAvailabilityDay(day)}
                ><strong>{WEEKDAY_LABELS[day]}</strong></button>;
              })}
            </div>
            <div className="availability-day-editor">
              <div className="availability-editor-main">
                {selectedAvailabilityRanges.length ? <div className="availability-range-list">
                  {selectedAvailabilityRanges.map((range, index) => (
                    <div className="availability-range-row" key={`${selectedAvailabilityDay}-${index}`}>
                      <div className="availability-range">
                        <ClockTimePicker
                          label="开始"
                          ariaLabel={`${WEEKDAY_LABELS[selectedAvailabilityDay]}开始时间`}
                          value={range.start}
                          align="start"
                          onChange={(value) => updateAvailabilityRange(index, { start: value })}
                        />
                        <i aria-hidden="true" />
                        <ClockTimePicker
                          label="结束"
                          ariaLabel={`${WEEKDAY_LABELS[selectedAvailabilityDay]}结束时间`}
                          value={range.end}
                          align="end"
                          onChange={(value) => updateAvailabilityRange(index, { end: value })}
                        />
                      </div>
                      <button type="button" className="availability-range-action is-revoke" aria-label={`撤销${WEEKDAY_LABELS[selectedAvailabilityDay]}第 ${index + 1} 个设定时段`} onClick={() => removeAvailabilityRange(index)}><Undo2 size={13} /><span>撤销</span></button>
                    </div>
                  ))}
                </div> : <div className="availability-empty-state" role="status">
                  <span className="availability-empty-icon" aria-hidden="true"><Moon size={18} /></span>
                  <div><strong>暂无可用时段</strong><p>当前按休息日处理；添加时段后，自动规划才会在这里安排任务。</p></div>
                </div>}
              </div>
              <div className="availability-editor-actions">
                <button type="button" className="availability-editor-action is-copy" disabled={(weeklyAvailability[selectedAvailabilityDay]?.length ?? 0) === 0} onClick={copyAvailabilityToWorkdays} title={(weeklyAvailability[selectedAvailabilityDay]?.length ?? 0) ? "将当前时间设置复制到周一至周五" : "请先设置一个可用时段"}><Copy size={14} /><span>沿用至其他工作日</span></button>
                <button type="button" className="availability-editor-action is-add" data-hint="同一天可以添加多个互不重叠的时间段" onClick={addAvailabilityRange}><Plus size={14} /><span>{(weeklyAvailability[selectedAvailabilityDay]?.length ?? 0) ? "添加时段" : "设置可用时段"}</span></button>
              </div>
            </div>
          </div>
        </div>
        </div>
      </section>

      <section className="settings-detail-stack">
        <article id="settings-reminders" className="settings-card settings-task-card">
          <header className="settings-section-head"><span><Clock3 size={17} /></span><div><h2>时间与提醒</h2><p>时区和提醒偏好都会在登录后同步到账号。</p></div></header>
          <div className="setting-row setting-row-grid">
            <label className="setting-copy" htmlFor="settings-timezone"><span>学习时区</span><small>用于跨日统计、计划时间和提醒换算</small></label>
            <div className="setting-current"><select id="settings-timezone" value={timezone} onChange={(event) => void changeTimezone(event.target.value)}><option value="Asia/Shanghai">中国 · 上海</option><option value="Asia/Tokyo">日本 · 东京</option><option value="America/New_York">美国 · 纽约</option><option value="Europe/London">英国 · 伦敦</option><option value="UTC">UTC</option></select></div>
          </div>
          <div className="setting-row setting-row-grid email-reminder-row">
            <div className="setting-copy email-reminder-copy"><div className="email-reminder-title"><span>晚间学习邮件提醒</span><button type="button" className={`setting-toggle ${reminderToggleOn ? "is-on" : ""}`} disabled={reminderToggleDisabled} onClick={() => { setReminderEnabled((current) => !current); feedback(reminderEnabled ? "邮件提醒已关闭" : "邮件提醒已开启"); }} aria-pressed={reminderToggleOn} aria-label={`晚间学习邮件提醒：${reminderToggleOn ? "已开启" : "已关闭"}`}><i /></button></div><small>{status !== "authenticated" ? "登录并验证邮箱后可开启" : emailReminderStatus && !emailReminderStatus.configured ? "邮件服务暂未配置，当前不会发送" : emailReminderStatus && !emailReminderStatus.email_verified ? "验证邮箱后开始发送提醒" : "当天仍有待办时，每晚发送一次"}</small></div>
            <div className="setting-current reminder-delivery-settings">{reminderEnabled && status === "authenticated" ? <>
              <div className="reminder-delivery-item reminder-time-setting">
                <span className="reminder-delivery-label"><Clock3 size={16} />提醒时间</span>
                <ClockTimePicker ariaLabel="晚间学习邮件提醒时间" value={reminderTime} onChange={setReminderTime} align="start" />
              </div>
              <div className={`reminder-delivery-item reminder-channel ${editingReminderEmail ? "is-editing" : ""}`}>
                <span className="reminder-delivery-label"><Mail size={16} />收件邮箱{reminderEmail && reminderEmail.toLowerCase() !== user?.email?.toLowerCase() ? <small>自定义</small> : null}</span>
                {editingReminderEmail ? <div className="reminder-email-editor">
                  <input id="settings-reminder-email" aria-label="提醒邮箱" type="email" value={reminderEmailDraft} onChange={(event) => setReminderEmailDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveReminderEmail(); if (event.key === "Escape") setEditingReminderEmail(false); }} autoFocus />
                  <button type="button" onClick={saveReminderEmail} aria-label="保存提醒邮箱"><Check size={14} /></button>
                  <button type="button" onClick={() => setEditingReminderEmail(false)} aria-label="取消更换提醒邮箱"><X size={14} /></button>
                </div> : <div className="reminder-email-value">
                  <strong>{reminderEmail || emailReminderStatus?.recipient || user?.email || "尚未设置"}</strong>
                  <button type="button" onClick={startEditingReminderEmail}><PencilLine size={13} />更换</button>
                </div>}
              </div>
            </> : <span className="reminder-disabled-copy"><CircleHelp size={14} aria-hidden="true" />开启后设置提醒时间与邮件收件地址</span>}</div>
          </div>
        </article>

        <DesktopStorageSettings />

        <WorkspaceDeviceSettings />

        <article id="settings-privacy" className="settings-card settings-task-card settings-privacy-card">
          <header className="settings-compact-section-header privacy-section-header">
            <span className="settings-compact-section-icon privacy-section-icon" aria-hidden="true"><ShieldCheck size={18} /></span>
            <div className="settings-compact-section-copy privacy-section-copy"><h2>AI、个性化与数据隐私</h2><p>按用途决定系统如何使用你的数据，所有选择都会同步到账号。</p></div>
            <span className={`privacy-save-state is-${privacyState}`} role="status" aria-live="polite">{privacyState === "loading" ? "加载中…" : privacyState === "saving" ? "保存中…" : privacyState === "saved" ? "已保存" : privacyState === "error" ? (privacyConsent ? "保存失败" : "加载失败") : "已同步"}</span>
          </header>
          {status !== "authenticated" ? <div className="privacy-login-note"><p>登录后可以管理账号级 AI 与数据选择。</p><Link href="/login?next=%2Fstudio%2Fsettings%23settings-privacy">登录管理</Link></div> : <>
            <div className="privacy-purpose-list" aria-label="AI 与数据用途">
              {([
                ["personalization_enabled", "个性化建议", "根据学习记录形成可纠正的观察，并用来调整建议。"],
                ["experiments_enabled", "产品实验参与", "加入用于比较产品方案效果的实验；关闭后会退出实验分组。"],
                ["product_analytics_enabled", "产品分析", "使用产品使用情况改进稳定性与功能体验。"],
                ["sensitive_inference_enabled", "敏感推断", "生成和使用拖延、坚持、挑战与反馈倾向等行为推断。关闭后会停止使用，并清除已有推断。"],
              ] as Array<[PrivacyPurpose, string, string]>).map(([purpose, label, description]) => {
                const enabled = privacyConsent?.[purpose] ?? false;
                return <div className={`privacy-purpose-row ${purpose === "sensitive_inference_enabled" ? "is-sensitive" : ""}`} key={purpose}>
                  <div className="privacy-purpose-copy"><div className="privacy-purpose-title"><strong>{label}</strong>{purpose === "sensitive_inference_enabled" && <em>需主动开启</em>}</div><p>{description}</p></div>
                  <div className="privacy-purpose-control"><span aria-hidden="true">{enabled ? "开启" : "关闭"}</span><button type="button" className={`privacy-toggle ${enabled ? "is-on" : ""}`} aria-pressed={enabled} aria-label={`${label}：${enabled ? "已开启" : "已关闭"}`} disabled={!privacyConsent || privacyState === "loading" || privacyState === "saving"} onClick={() => void togglePrivacyPurpose(purpose)}><i /></button></div>
                </div>;
              })}
            </div>
            <Link className="privacy-memory-management-link" href="/studio/coach/memory">
              <span className="privacy-data-icon" aria-hidden="true"><BrainCircuit size={16} /></span>
              <span><strong>查看个性化与学习偏好</strong><small>逐条核对观察依据，修正适用范围，或暂停、遗忘单条观察</small></span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            {showPersonalizationChoice && <div className="personalization-off-choice" role="group" aria-label="关闭个性化的方式"><div><strong>如何关闭个性化？</strong><p>两种方式都会停止新的个性化建议；你可以决定是否同时清除系统生成的派生数据。</p></div><div><button type="button" onClick={() => void updatePrivacyConsent({ personalization_enabled: false }, "个性化建议已关闭，现有派生数据已保留")}>仅关闭</button><button type="button" className="is-danger" onClick={() => void eraseDerivedData()}><Trash2 size={14} />关闭并清除派生数据</button><button type="button" className="is-quiet" onClick={() => setShowPersonalizationChoice(false)}>取消</button></div></div>}
            {privacyState === "error" && <div className="privacy-inline-error" role="alert"><span>{privacyError}</span><button type="button" onClick={() => failedConsentPatch ? void updatePrivacyConsent(failedConsentPatch) : setPrivacyLoadAttempt((value) => value + 1)}>重试</button></div>}
            <details className="privacy-data-actions"><summary><span className="privacy-data-icon" aria-hidden="true"><Database size={16} /></span><span><strong>数据导出与清除</strong><small>获取数据副本，或清除系统生成的派生数据</small></span><ChevronDown size={16} aria-hidden="true" /></summary><div className="privacy-data-list">
              <div className="privacy-data-row"><div><strong>服务器数据副本</strong><p>包含账号资料、授权历史、目标与任务、笔记和知识正文及关联行、学习记录和账号相关的 Agent 交互数据；不包含密码或令牌、服务器文件路径、向量索引和内部运维 trace。</p></div><button type="button" disabled={exportBusy} onClick={() => void exportData()}>{exportBusy ? <LoaderCircle size={14} className="is-spinning" /> : <Download size={14} />}{exportBusy ? "生成中…" : "导出服务器数据"}</button></div>
              <div className="privacy-data-row"><div><strong>本机缓存副本</strong><p>只导出当前浏览器中的离线缓存和界面偏好，不代表服务器端完整学习数据。</p></div><button type="button" disabled={localExportBusy} onClick={() => void exportLocalCache()}>{localExportBusy ? <LoaderCircle size={14} className="is-spinning" /> : <Download size={14} />}{localExportBusy ? "生成中…" : "导出本机缓存"}</button></div>
              <div className="privacy-data-row privacy-danger-action"><div><strong>清除学习画像与派生数据</strong><p>{privacyConsent?.personalization_enabled === false ? "个性化已关闭；你仍可清除此前选择保留的" : "会关闭个性化并清除"}学习观察、画像、认知推断和学习记忆。不会删除你创建的目标、任务、笔记或知识内容。</p></div><button type="button" disabled={!privacyConsent || privacyState === "saving"} onClick={() => void eraseDerivedData()}><Trash2 size={14} />{privacyConsent?.personalization_enabled === false ? "清除已保留的派生数据" : "关闭并清除派生数据"}</button></div>
            </div></details>
          </>}
        </article>

        <article id="settings-account" className="settings-card settings-task-card">
          <header className="settings-compact-section-header account-section-header"><span className="settings-compact-section-icon" aria-hidden="true"><UserRound size={18} /></span><div className="settings-compact-section-copy"><h2>账户</h2><p>{status === "authenticated" ? "资料修改会自动同步到账号。" : "登录后可修改资料并跨设备同步。"}</p></div></header>
          {status !== "authenticated" || !user ? <div className="guest-account-panel">
            <div className="guest-account-copy"><span><UserRound size={18} /></span><div><strong>登录或创建账号</strong><p>登录后可同步资料、修改用户名，并在不同设备继续学习。</p></div></div>
            <div className="guest-account-actions"><Link href="/login">登录<ArrowRight size={14} /></Link><Link href="/register" className="is-secondary">创建账号</Link></div>
          </div> : editingProfile ? <form className="profile-edit-form" onSubmit={saveProfile}><label>用户名<input value={profile.username} onChange={(event) => setProfile((current) => ({ ...current, username: event.target.value }))} minLength={2} required /></label><label>邮箱<input type="email" value={profile.email} onChange={(event) => setProfile((current) => ({ ...current, email: event.target.value }))} required /></label><div><button type="button" onClick={() => setEditingProfile(false)}>取消</button><button type="submit" disabled={busy}><Save size={14} />{busy ? "保存中…" : "保存资料"}</button></div></form> : <>
            <div className="settings-avatar-row">
              <div className="settings-avatar-preview">
                <UserAvatar avatarUrl={user.avatar_url} username={user.username} size={68} />
                <span className="settings-avatar-status" aria-hidden="true" />
              </div>
              <div className="settings-avatar-copy"><strong>个人头像</strong><p>会显示在你与 Pilo 的对话和工作区中，登录后跨设备同步。</p><small>支持 JPG、PNG、WebP，最大 5 MB；上传前可调整取景</small></div>
              <div className="setting-action">
                <input ref={avatarInputRef} className="settings-avatar-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void changeAvatar(event)} />
                <button type="button" className="account-action-button" disabled={avatarBusy} onClick={() => avatarInputRef.current?.click()}><span className="account-action-visual">{avatarBusy ? <LoaderCircle size={14} className="is-spinning" /> : <Camera size={14} />}<span>{avatarBusy ? "上传中…" : user.avatar_url ? "更换头像" : "上传头像"}</span></span></button>
              </div>
            </div>
            <div className="setting-row setting-row-grid"><div className="setting-copy"><span>用户名</span><small>用于工作区中的身份展示</small></div><div className="setting-current"><span className="setting-value-text">{user.username}</span></div><div className="setting-action"><button type="button" className="account-action-button" onClick={() => setEditingProfile(true)}><span className="account-action-visual"><PencilLine size={14} /><span>编辑</span></span></button></div></div>
            <div className="setting-row setting-row-grid"><div className="setting-copy"><span>邮箱</span><small>用于登录、验证和重要账号通知</small></div><div className="setting-current"><span className="setting-value-text">{user.email}</span></div><div className="setting-action"><button type="button" className="account-action-button" onClick={() => setEditingProfile(true)}><span className="account-action-visual"><PencilLine size={14} /><span>修改</span></span></button></div></div>
            <div className="setting-row setting-row-grid account-signout-row"><div className="setting-copy"><span>退出当前账号</span><small>只结束当前会话，本地学习数据不会被删除</small></div><div className="setting-current"><span className="setting-value-text">{user.username}</span></div><div className="setting-action"><button type="button" className="account-action-button is-danger danger-quiet" onClick={() => { logout(); window.location.assign("/login"); }}><span className="account-action-visual"><LogOut size={14} /><span>退出</span></span></button></div></div>
          </>}
        </article>
      </section>
        </div>
      </div>

      {notice && error ? (
        <DataSyncNotice
          title={/登录/.test(notice) ? "当前操作需要登录" : /同步|保存|更新|生成/.test(notice) ? "设置同步失败" : "当前操作未完成"}
          message={notice}
        />
      ) : notice ? (
        <div className="settings-toast" role="status"><Check size={14} />{notice}</div>
      ) : null}
      {avatarCropFile && (
        <AvatarCropDialog
          key={`${avatarCropFile.name}-${avatarCropFile.lastModified}`}
          file={avatarCropFile}
          busy={avatarBusy}
          onCancel={() => setAvatarCropFile(null)}
          onChooseAnother={() => {
            setAvatarCropFile(null);
            window.requestAnimationFrame(() => avatarInputRef.current?.click());
          }}
          onConfirm={saveCroppedAvatar}
        />
      )}
    </div>
  );
}
