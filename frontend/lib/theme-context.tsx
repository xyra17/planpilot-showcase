"use client";

import { createContext, useContext, useState, useEffect } from "react";
import { useAuthStore } from "@/lib/stores/authStore";

export type ThemeMode = "default" | "dark" | "eye-care" | "sketch";

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
    const savedMode = (localStorage.getItem(modeKey) as ThemeMode) || "default";
    const savedColor = (localStorage.getItem(colorKey) as ColorScheme) || "indigo";
    setModeState(savedMode);
    setColorSchemeState(savedColor);
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
