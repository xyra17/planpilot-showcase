export type ThemeMode = "default" | "dark" | "eye-care" | "journal";
export type ColorThemeMode = Exclude<ThemeMode, "journal">;
export type JournalPalette = "wood" | "slate" | "newspaper" | "wheat" | "night";

export type ColorScheme =
  | "blue" | "indigo" | "violet" | "rose" | "amber" | "emerald" | "teal"
  | "rainbow"
  | "morandi-rose" | "morandi-sage" | "morandi-stone" | "morandi-terracotta" | "morandi-lavender"
  | "silver" | "mint" | "morandi-blue" | "morandi-purple";

export interface ThemeColorOption {
  value: ColorScheme;
  label: string;
  description: string;
  swatches: string[];
}

export const THEME_LABELS: Record<ThemeMode, string> = {
  default: "默认风格",
  dark: "暗黑风格",
  "eye-care": "护眼风格",
  journal: "手账纸稿",
};

export const STYLE_COLOR_OPTIONS: Record<ColorThemeMode, ThemeColorOption[]> = {
  default: [
    { value: "indigo", label: "专注靛青", description: "稳定清晰的默认方案", swatches: ["#eef2ff", "#c7d2fe", "#4f46e5", "#3730a3"] },
    { value: "blue", label: "天空蓝", description: "明快、清晰的执行氛围", swatches: ["#eff6ff", "#bfdbfe", "#2563eb", "#1d4ed8"] },
    { value: "emerald", label: "成长绿", description: "平静积极的进度反馈", swatches: ["#ecfdf5", "#a7f3d0", "#059669", "#065f46"] },
    { value: "violet", label: "灵感紫", description: "适合探索与知识创作", swatches: ["#f5f3ff", "#ddd6fe", "#7c3aed", "#5b21b6"] },
    { value: "rose", label: "行动玫红", description: "更强的行动提示", swatches: ["#fff1f2", "#fecdd3", "#e11d48", "#9f1239"] },
    { value: "amber", label: "目标琥珀", description: "温暖醒目的目标强调", swatches: ["#fffbeb", "#fde68a", "#d97706", "#92400e"] },
  ],
  dark: [
    { value: "indigo", label: "深海靛青", description: "克制稳定的夜间方案", swatches: ["#0f172a", "#1e293b", "#818cf8", "#c7d2fe"] },
    { value: "violet", label: "夜幕紫", description: "突出 AI 与思考状态", swatches: ["#171225", "#2e2146", "#a78bfa", "#ede9fe"] },
    { value: "teal", label: "夜航青", description: "冷静、低干扰的深色方案", swatches: ["#10201f", "#173b38", "#2dd4bf", "#ccfbf1"] },
    { value: "emerald", label: "森林绿", description: "柔和的完成与恢复反馈", swatches: ["#0d1f19", "#14382b", "#34d399", "#d1fae5"] },
    { value: "silver", label: "中性黑灰", description: "尽量减少色彩干扰", swatches: ["#111113", "#27272a", "#a1a1aa", "#f4f4f5"] },
  ],
  "eye-care": [
    { value: "morandi-terracotta", label: "暖陶", description: "温暖且舒缓的默认护眼色", swatches: ["#fdf3ef", "#e8c4b4", "#b07d65", "#8c6248"] },
    { value: "morandi-sage", label: "鼠尾草", description: "低饱和自然绿", swatches: ["#f0f4f1", "#c4d4ca", "#7a9485", "#5e7567"] },
    { value: "morandi-stone", label: "石灰岩", description: "安静温和的中性色", swatches: ["#f3f0ef", "#d4d0ce", "#8a8480", "#6b6460"] },
    { value: "morandi-rose", label: "玫瑰灰", description: "柔和、不刺眼的暖调", swatches: ["#fdf2f2", "#e8cece", "#b08d8d", "#8c6e6e"] },
    { value: "morandi-lavender", label: "薰衣草", description: "适合阅读与复盘的紫灰", swatches: ["#f3f0fa", "#d4c8e8", "#9080b0", "#6b5b8c"] },
  ],
};

export const STYLE_DEFAULT_COLOR: Record<ColorThemeMode, ColorScheme> = {
  default: "indigo",
  dark: "indigo",
  "eye-care": "morandi-terracotta",
};

export const JOURNAL_PALETTES: Array<{
  value: JournalPalette;
  label: string;
  description: string;
  swatches: string[];
}> = [
  { value: "wood", label: "原木纸稿", description: "米白纸 · 石墨 · 赭石", swatches: ["#F7F0E2", "#37342F", "#B57935"] },
  { value: "slate", label: "青灰纸稿", description: "灰白纸 · 深青墨 · 灰绿", swatches: ["#EEF1ED", "#29413F", "#66877A"] },
  { value: "newspaper", label: "旧报纸稿", description: "淡黄纸 · 炭黑墨 · 暗红", swatches: ["#F1E4C4", "#302E2A", "#8E453D"] },
  { value: "wheat", label: "麦香素描", description: "暖麦纸 · 深石墨 · 麦金", swatches: ["#F3E8CF", "#4A4840", "#A98A52"] },
  { value: "night", label: "深夜纸稿", description: "深色纸 · 浅石墨 · 暖金", swatches: ["#25231F", "#EEE4D2", "#D39A58"] },
];

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === "default" || value === "dark" || value === "eye-care" || value === "journal";
}

export function isJournalPalette(value: string | null): value is JournalPalette {
  return value === "wood" || value === "slate" || value === "newspaper" || value === "wheat" || value === "night";
}

export function isCompatibleColor(mode: ColorThemeMode, color: string | null): color is ColorScheme {
  return STYLE_COLOR_OPTIONS[mode].some((option) => option.value === color);
}
