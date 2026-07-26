"use client";

import { createContext, useContext, useState, useEffect } from "react";
import { useAuthStore } from "@/lib/stores/authStore";

export type ThemeMode = "default" | "dark" | "eye-care" | "sketch" | "journal";

export type ColorScheme =
  | "blue" | "indigo" | "violet" | "rose" | "amber" | "emerald" | "teal"
  | "rainbow"
  | "morandi-rose" | "morandi-sage" | "morandi-stone" | "morandi-terracotta" | "morandi-lavender"
  | "silver" | "mint" | "morandi-blue" | "morandi-purple";

interface ThemeContextType {
  mode: ThemeMode;
  colorScheme: ColorScheme;
  setMode: (m: ThemeMode) => void;
  setColorScheme: (c: ColorScheme) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  mode: "default",
  colorScheme: "indigo",
  setMode: () => {},
  setColorScheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const userId = useAuthStore((s) => s.user?.id ?? "guest");
  const modeKey = `theme-mode-${userId}`;
  const colorKey = `theme-color-${userId}`;

  const [mode, setModeState] = useState<ThemeMode>("default");
  const [colorScheme, setColorSchemeState] = useState<ColorScheme>("indigo");

  function setMode(m: ThemeMode) {
    setModeState(m);
    document.documentElement.setAttribute("data-theme", m);
    localStorage.setItem(modeKey, m);
    if (m === "eye-care") {
      setColorSchemeState("morandi-terracotta");
      document.documentElement.setAttribute("data-color", "morandi-terracotta");
      localStorage.setItem(colorKey, "morandi-terracotta");
    }
  }

  function setColorScheme(c: ColorScheme) {
    setColorSchemeState(c);
    document.documentElement.setAttribute("data-color", c);
    localStorage.setItem(colorKey, c);
  }

  // userId 变化时（登录/登出/切换账号）重新加载该用户的主题设置
  useEffect(() => {
    let savedMode = (localStorage.getItem(modeKey) as ThemeMode) || "default";
    let savedColor = (localStorage.getItem(colorKey) as ColorScheme | string) || "indigo";
    // 将已删除的全局配色平滑迁移到新的独立手账纸稿风格。
    if (savedColor.startsWith("calm-")) {
      savedMode = "journal";
      savedColor = "indigo";
      localStorage.setItem(modeKey, savedMode);
      localStorage.setItem(colorKey, savedColor);
    }
    setModeState(savedMode);
    setColorSchemeState(savedColor as ColorScheme);
    document.documentElement.setAttribute("data-theme", savedMode);
    document.documentElement.setAttribute("data-color", savedColor);
  }, [modeKey, colorKey]);

  return (
    <ThemeContext.Provider value={{ mode, colorScheme, setMode, setColorScheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
