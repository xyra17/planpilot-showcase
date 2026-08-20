"use client";

import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  FileUp,
  Flag,
  LoaderCircle,
  Monitor,
  Palette,
  Play,
  Plus,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "@/components/app/AppBrand";
import { useAuthStore } from "@/lib/stores/authStore";
import styles from "./page.module.css";

type Surface = "base" | "notebook" | "dark";
type Density = "compact" | "comfortable" | "relaxed";
type StartMethod = "create_goal" | "import_plan" | "connect_calendar" | "sample_space";

const steps = [
  { title: "基础偏好", detail: "语言与日历", icon: Monitor },
  { title: "学习节奏", detail: "常用日期与时段", icon: Clock3 },
  { title: "外观细节", detail: "材质、颜色与密度", icon: Palette },
  { title: "开始方式", detail: "迈出第一步", icon: Flag },
];

const weekdays = [
  ["mon", "一"], ["tue", "二"], ["wed", "三"], ["thu", "四"],
  ["fri", "五"], ["sat", "六"], ["sun", "日"],
] as const;

const timeWindows = [
  { value: "early_morning", label: "清晨", time: "06:00–09:00" },
  { value: "morning", label: "上午", time: "09:00–12:00" },
  { value: "afternoon", label: "下午", time: "13:00–18:00" },
  { value: "evening", label: "晚上", time: "18:00–22:00" },
  { value: "late_night", label: "深夜", time: "22:00 后" },
] as const;

const accents = [
  { value: "violet", label: "灵感紫", color: "#6d5dfc" },
  { value: "ocean", label: "海湾蓝", color: "#2477e8" },
  { value: "forest", label: "生长绿", color: "#2f8f63" },
  { value: "coral", label: "珊瑚橙", color: "#e97055" },
  { value: "amber", label: "目标金", color: "#c58a22" },
] as const;

const surfaces: Array<{ value: Surface; label: string; detail: string }> = [
  { value: "base", label: "清透", detail: "明亮、轻盈的界面层次" },
  { value: "notebook", label: "纸感", detail: "温和材质与阅读氛围" },
  { value: "dark", label: "深色", detail: "适合夜间专注学习" },
];

const startMethods = [
  { value: "create_goal", title: "创建第一个目标", detail: "从目标拆解出今天能开始的行动", icon: Plus },
  { value: "import_plan", title: "导入课程或学习计划", detail: "把已有资料整理成可执行计划", icon: FileUp },
  { value: "connect_calendar", title: "连接日历", detail: "结合真实日程安排学习时间", icon: CalendarDays },
  { value: "sample_space", title: "先体验示例空间", detail: "用示例快速了解 PlanPilot", icon: Play },
] as const;

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export default function OnboardingPage() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const initFromStorage = useAuthStore((state) => state.initFromStorage);
  const updateUser = useAuthStore((state) => state.updateUser);
  const [step, setStep] = useState(0);
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [language, setLanguage] = useState<"zh-CN" | "en-US">("zh-CN");
  const [weekStart, setWeekStart] = useState<"monday" | "sunday">("monday");
  const [studyDays, setStudyDays] = useState<string[]>(["mon", "tue", "wed", "thu", "fri"]);
  const [availability, setAvailability] = useState<string[]>(["evening"]);
  const [surface, setSurface] = useState<Surface>("base");
  const [accent, setAccent] = useState("violet");
  const [density, setDensity] = useState<Density>("comfortable");
  const [startMethod, setStartMethod] = useState<StartMethod>("create_goal");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    initFromStorage();
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) setTimezone(detected);
  }, [initFromStorage]);

  useEffect(() => {
    if (!user) return;
    setTimezone(user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Asia/Shanghai");
    setLanguage(user.language ?? "zh-CN");
    setWeekStart(user.week_start ?? "monday");
    setStudyDays(user.study_days?.length ? user.study_days : ["mon", "tue", "wed", "thu", "fri"]);
    setAvailability(user.availability_windows?.length ? user.availability_windows : ["evening"]);
    setSurface(user.ui_theme ?? "base");
    setAccent(user.ui_accent ?? "violet");
    setDensity(user.font_density ?? "comfortable");
    setStartMethod(user.preferred_start_method ?? "create_goal");
  }, [user]);

  const accentColor = accents.find((item) => item.value === accent)?.color ?? accents[0].color;
  const previewDays = useMemo(
    () => weekdays.filter(([value]) => studyDays.includes(value)).map(([, label]) => `周${label}`),
    [studyDays],
  );

  const canContinue = step !== 1 || (studyDays.length > 0 && availability.length > 0);

  function targetFor(method: StartMethod) {
    return {
      create_goal: "/studio/work/goals?create=1",
      import_plan: "/studio/work/knowledge?source=onboarding",
      connect_calendar: "/studio/settings?tab=integrations",
      sample_space: "/studio/work?demo=1",
    }[method];
  }

  async function finish(target: string) {
    setSaving(true);
    setError("");
    try {
      await updateUser({
        timezone,
        language,
        week_start: weekStart,
        study_days: studyDays,
        availability_windows: availability,
        ui_experience: "technology",
        ui_theme: surface,
        ui_accent: accent,
        font_density: density,
        preferred_start_method: startMethod,
        onboarding_completed: true,
      });
      window.localStorage.setItem("pp-onboarding-complete", "true");
      router.push(target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "设置保存失败，请检查网络后重试");
    } finally {
      setSaving(false);
    }
  }

  function renderStep() {
    if (step === 0) {
      return (
        <>
          <div className={styles.stepHeading}>
            <span className={styles.eyebrow}>01 · 基础偏好</span>
            <h1>先对齐你的时间</h1>
            <p>这些设置会影响每日计划、提醒和每周复盘，你可以随时在设置中修改。</p>
          </div>
          <div className={styles.fieldGrid}>
            <label className={styles.fieldFull}>
              <span>所在时区</span>
              <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
                <option value="Asia/Shanghai">中国标准时间 · 上海 (UTC+8)</option>
                <option value="Asia/Tokyo">日本标准时间 · 东京 (UTC+9)</option>
                <option value="Europe/London">英国时间 · 伦敦</option>
                <option value="America/Los_Angeles">太平洋时间 · 洛杉矶</option>
                {!['Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/Los_Angeles'].includes(timezone) && (
                  <option value={timezone}>{timezone}</option>
                )}
              </select>
              <small>已根据设备自动识别</small>
            </label>
            <fieldset className={styles.fieldset}>
              <legend>界面语言</legend>
              <div className={styles.segmented}>
                <button type="button" aria-pressed={language === "zh-CN"} onClick={() => setLanguage("zh-CN")}>简体中文</button>
                <button type="button" aria-pressed={language === "en-US"} onClick={() => setLanguage("en-US")}>English</button>
              </div>
            </fieldset>
            <fieldset className={styles.fieldset}>
              <legend>一周起始日</legend>
              <div className={styles.segmented}>
                <button type="button" aria-pressed={weekStart === "monday"} onClick={() => setWeekStart("monday")}>周一</button>
                <button type="button" aria-pressed={weekStart === "sunday"} onClick={() => setWeekStart("sunday")}>周日</button>
              </div>
            </fieldset>
          </div>
        </>
      );
    }

    if (step === 1) {
      return (
        <>
          <div className={styles.stepHeading}>
            <span className={styles.eyebrow}>02 · 学习节奏</span>
            <h1>什么时候比较适合学习？</h1>
            <p>不需要精确到分钟。PlanPilot 只会把它当作温和的安排依据。</p>
          </div>
          <fieldset className={styles.choiceGroup}>
            <legend>常用学习日</legend>
            <div className={styles.dayPicker}>
              {weekdays.map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-label={`周${label}`}
                  aria-pressed={studyDays.includes(value)}
                  onClick={() => setStudyDays((current) => toggleValue(current, value))}
                >{label}</button>
              ))}
            </div>
            {studyDays.length === 0 && <span className={styles.validation}>请至少选择一个常用学习日</span>}
          </fieldset>
          <fieldset className={styles.choiceGroup}>
            <legend>大致可用时段</legend>
            <div className={styles.timeGrid}>
              {timeWindows.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  aria-pressed={availability.includes(item.value)}
                  onClick={() => setAvailability((current) => toggleValue(current, item.value))}
                >
                  <span>{item.label}</span><small>{item.time}</small>
                  {availability.includes(item.value) && <Check size={16} />}
                </button>
              ))}
            </div>
            {availability.length === 0 && <span className={styles.validation}>请至少选择一个可用时段</span>}
          </fieldset>
        </>
      );
    }

    if (step === 2) {
      return (
        <>
          <div className={styles.stepHeading}>
            <span className={styles.eyebrow}>03 · 外观细节</span>
            <h1>让工作台更像你的空间</h1>
            <p>右侧预览会实时变化。不想花时间选择，也可以直接跳过。</p>
          </div>
          <fieldset className={styles.choiceGroup}>
            <legend>界面材质</legend>
            <div className={styles.surfaceGrid}>
              {surfaces.map((item) => (
                <button type="button" key={item.value} aria-pressed={surface === item.value} onClick={() => setSurface(item.value)}>
                  <span className={`${styles.surfaceSample} ${styles[`surface_${item.value}`]}`} />
                  <strong>{item.label}</strong><small>{item.detail}</small>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.choiceGroup}>
            <legend>强调色</legend>
            <div className={styles.accentPicker}>
              {accents.map((item) => (
                <button type="button" key={item.value} aria-label={item.label} title={item.label} aria-pressed={accent === item.value} onClick={() => setAccent(item.value)} style={{ "--swatch": item.color } as React.CSSProperties}>
                  {accent === item.value && <Check size={16} />}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.choiceGroup}>
            <legend>字体密度</legend>
            <div className={styles.segmented}>
              {([['compact', '紧凑'], ['comfortable', '舒适'], ['relaxed', '宽松']] as const).map(([value, label]) => (
                <button type="button" key={value} aria-pressed={density === value} onClick={() => setDensity(value)}>{label}</button>
              ))}
            </div>
          </fieldset>
        </>
      );
    }

    return (
      <>
        <div className={styles.stepHeading}>
          <span className={styles.eyebrow}>04 · 开始方式</span>
          <h1>你想从哪里开始？</h1>
          <p>选择一个最顺手的入口。无论选哪项，“创建第一个目标”都会保留为主行动。</p>
        </div>
        <div className={styles.startGrid}>
          {startMethods.map((item) => {
            const Icon = item.icon;
            return (
              <button type="button" key={item.value} aria-pressed={startMethod === item.value} onClick={() => setStartMethod(item.value)}>
                <span className={styles.startIcon}><Icon size={20} /></span>
                <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                <span className={styles.radio}>{startMethod === item.value && <Check size={14} />}</span>
              </button>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <main className={styles.page} style={{ "--onboarding-accent": accentColor } as React.CSSProperties}>
      <aside className={styles.progressPanel} aria-label="设置步骤">
        <AppBrand href="/" />
        <div className={styles.progressIntro}>
          <span>首次使用设置</span>
          <strong>大约 2 分钟</strong>
        </div>
        <nav>
          {steps.map((item, index) => {
            const Icon = item.icon;
            return (
              <button type="button" key={item.title} className={index === step ? styles.activeStep : index < step ? styles.doneStep : ""} onClick={() => setStep(index)}>
                <span className={styles.stepDot}>{index < step ? <Check size={15} /> : <Icon size={16} />}</span>
                <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                {index === step && <ChevronRight size={16} />}
              </button>
            );
          })}
        </nav>
        <p className={styles.progressFoot}>所有设置稍后都能在工作台中调整。</p>
      </aside>

      <section className={styles.setupPanel}>
        <div className={styles.mobileProgress}><span style={{ width: `${((step + 1) / steps.length) * 100}%` }} /></div>
        <div className={styles.formBody}>{renderStep()}</div>
        <footer className={styles.actions}>
          <div>
            {step > 0 && <button type="button" className={styles.backButton} onClick={() => setStep((value) => value - 1)}><ArrowLeft size={17} />上一步</button>}
            {step === 2 && <button type="button" className={styles.skipButton} onClick={() => setStep(3)}>跳过外观选择</button>}
          </div>
          <div className={styles.actionRight}>
            {error && <span role="alert" className={styles.saveError}>{error}</span>}
            {step < steps.length - 1 ? (
              <button type="button" className={styles.nextButton} disabled={!canContinue} onClick={() => setStep((value) => value + 1)}>继续<ArrowRight size={17} /></button>
            ) : (
              <>
                {startMethod !== "create_goal" && (
                  <button type="button" className={styles.secondaryAction} disabled={saving} onClick={() => void finish(targetFor(startMethod))}>
                    {startMethods.find((item) => item.value === startMethod)?.title}
                  </button>
                )}
                <button type="button" className={styles.primaryAction} disabled={saving} onClick={() => void finish(targetFor("create_goal"))}>
                  {saving ? <LoaderCircle className={styles.spin} size={18} /> : <Plus size={18} />}
                  创建第一个目标
                </button>
              </>
            )}
          </div>
        </footer>
      </section>

      <aside className={`${styles.previewPanel} ${styles[`preview_${surface}`]} ${styles[`density_${density}`]}`} aria-label="实时工作台预览">
        <header><span><Sparkles size={14} />实时预览</span><small>科技工作台</small></header>
        <div className={styles.previewCanvas}>
          <div className={styles.previewTop}><span className={styles.previewMark}>P</span><i /><i /></div>
          <div className={styles.previewGreeting}>
            <small>{language === "zh-CN" ? "下午好" : "GOOD AFTERNOON"}</small>
            <strong>{user?.username ? `${user.username}，` : ""}今天想推进什么？</strong>
          </div>
          <div className={styles.previewGoal}>
            <div><span>本周重点</span><strong>建立稳定的学习节奏</strong></div><span className={styles.previewPercent}>68%</span>
            <div className={styles.previewBar}><i /></div>
          </div>
          <div className={styles.previewSectionTitle}><strong>今天</strong><small>{previewDays.slice(0, 3).join(" · ") || "等待选择"}</small></div>
          {["完成核心概念复习", "整理本周学习笔记", "15 分钟轻量回顾"].map((task, index) => (
            <div className={styles.previewTask} key={task}><span className={index === 0 ? styles.previewChecked : ""}>{index === 0 && <Check size={11} />}</span><p>{task}<small>{index === 0 ? "已完成" : index === 1 ? "40 分钟" : "今天晚上"}</small></p></div>
          ))}
          <div className={styles.previewCoach}><Sparkles size={16} /><p><strong>PlanPilot 建议</strong><span>根据你的可用时段，今晚适合安排一次短复习。</span></p></div>
        </div>
        <p className={styles.previewHint}>预览会随你的选择实时变化</p>
      </aside>
    </main>
  );
}
