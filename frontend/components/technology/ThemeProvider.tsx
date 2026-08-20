"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/components/technology/AuthProvider";

export type SurfaceTheme = "base" | "notebook" | "dark";
export type ThemeMode = "default" | "dark" | "notebook";
export type AccentColor =
  | "violet" | "ocean" | "forest"
  | "wood" | "slate" | "newspaper" | "wheat" | "night";

export const THEME_ACCENTS: Record<ThemeMode, AccentColor[]> = {
  default: ["violet", "ocean", "forest"],
  dark: ["violet", "ocean", "forest"],
  notebook: ["wood", "slate", "newspaper", "wheat", "night"],
};

const DEFAULT_ACCENT: Record<ThemeMode, AccentColor> = {
  default: "violet",
  dark: "violet",
  notebook: "wood",
};

export function resolveTheme(surfaceTheme: SurfaceTheme): ThemeMode {
  if (surfaceTheme === "notebook") return "notebook";
  if (surfaceTheme === "dark") return "dark";
  return "default";
}

type AppearanceInput = {
  surfaceTheme?: SurfaceTheme;
  accent?: AccentColor;
};

type ThemeContextValue = {
  surfaceTheme: SurfaceTheme;
  theme: ThemeMode;
  accent: AccentColor;
  availableAccents: AccentColor[];
  setSurfaceTheme: (theme: SurfaceTheme) => void;
  setAccent: (accent: AccentColor) => void;
  saveAppearance: (input?: AppearanceInput) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isSurfaceTheme(value: string | null): value is SurfaceTheme {
  return value === "base" || value === "notebook" || value === "dark";
}

function isAccent(value: string | null | undefined): value is AccentColor {
  return ["violet", "ocean", "forest", "wood", "slate", "newspaper", "wheat", "night"].includes(value ?? "");
}

function normalizeAccent(value: string | null | undefined): AccentColor | null {
  // Coral was removed from the public palette. Preserve existing users by
  // migrating the old saved value to the new non-red forest accent.
  if (value === "coral") return "forest";
  return isAccent(value) ? value : null;
}

function applyAppearance(surfaceTheme: SurfaceTheme, accent: AccentColor) {
  const theme = resolveTheme(surfaceTheme);
  document.documentElement.dataset.experience = "technology";
  document.documentElement.dataset.surfaceTheme = surfaceTheme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.accent = accent;
  document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
}

export function ThemeProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const { user, status, updateProfile } = useAuth();
  const [surfaceTheme, updateSurfaceTheme] = useState<SurfaceTheme>("base");
  const [accent, updateAccent] = useState<AccentColor>("violet");
  const [storageReady, setStorageReady] = useState(false);
  const hydratedUserId = useRef<string | null>(null);
  const theme = resolveTheme(surfaceTheme);

  const chooseCompatibleAccent = useCallback((nextTheme: ThemeMode, candidate?: string | null) => {
    const normalizedCandidate = normalizeAccent(candidate);
    if (normalizedCandidate && THEME_ACCENTS[nextTheme].includes(normalizedCandidate)) return normalizedCandidate;
    const remembered = normalizeAccent(localStorage.getItem(`planpilot-accent-${nextTheme}`));
    return remembered && THEME_ACCENTS[nextTheme].includes(remembered)
      ? remembered
      : DEFAULT_ACCENT[nextTheme];
  }, []);

  useEffect(() => {
    const legacyTheme = localStorage.getItem("planpilot-theme") as ThemeMode | null;
    const storedSurfaceTheme = localStorage.getItem("planpilot-surface-theme");
    const nextSurfaceTheme = isSurfaceTheme(storedSurfaceTheme)
      ? storedSurfaceTheme
      : legacyTheme === "notebook" || legacyTheme === "dark" ? legacyTheme : "base";
    const nextTheme = resolveTheme(nextSurfaceTheme);
    const nextAccent = chooseCompatibleAccent(
      nextTheme,
      localStorage.getItem(`planpilot-accent-${nextTheme}`) ?? localStorage.getItem("planpilot-accent"),
    );
    updateSurfaceTheme(nextSurfaceTheme);
    updateAccent(nextAccent);
    applyAppearance(nextSurfaceTheme, nextAccent);
    setStorageReady(true);
  }, [chooseCompatibleAccent]);

  useEffect(() => {
    if (status !== "authenticated" || !user || hydratedUserId.current === user.id) return;
    hydratedUserId.current = user.id;
    const nextSurfaceTheme = user.ui_theme ?? surfaceTheme;
    const nextTheme = resolveTheme(nextSurfaceTheme);
    const nextAccent = chooseCompatibleAccent(nextTheme, user.ui_accent);
    updateSurfaceTheme(nextSurfaceTheme);
    updateAccent(nextAccent);
    applyAppearance(nextSurfaceTheme, nextAccent);
  }, [chooseCompatibleAccent, status, surfaceTheme, user]);

  useEffect(() => {
    if (!storageReady) return;
    applyAppearance(surfaceTheme, accent);
    localStorage.setItem("planpilot-experience", "technology");
    localStorage.setItem("planpilot-surface-theme", surfaceTheme);
    localStorage.setItem("planpilot-theme", theme);
    localStorage.setItem("planpilot-accent", accent);
    localStorage.setItem(`planpilot-accent-${theme}`, accent);
  }, [accent, storageReady, surfaceTheme, theme]);

  const setSurfaceTheme = useCallback((nextSurfaceTheme: SurfaceTheme) => {
    updateSurfaceTheme(nextSurfaceTheme);
    const nextTheme = resolveTheme(nextSurfaceTheme);
    updateAccent((current) => THEME_ACCENTS[nextTheme].includes(current) ? current : chooseCompatibleAccent(nextTheme));
  }, [chooseCompatibleAccent]);

  const setAccent = useCallback((nextAccent: AccentColor) => {
    if (THEME_ACCENTS[theme].includes(nextAccent)) updateAccent(nextAccent);
  }, [theme]);

  const saveAppearance = useCallback(async (input: AppearanceInput = {}) => {
    const nextSurfaceTheme = input.surfaceTheme ?? surfaceTheme;
    const nextTheme = resolveTheme(nextSurfaceTheme);
    const nextAccent = input.accent && THEME_ACCENTS[nextTheme].includes(input.accent)
      ? input.accent
      : THEME_ACCENTS[nextTheme].includes(accent) ? accent : DEFAULT_ACCENT[nextTheme];
    updateSurfaceTheme(nextSurfaceTheme);
    updateAccent(nextAccent);
    applyAppearance(nextSurfaceTheme, nextAccent);
    if (status === "authenticated") {
      await updateProfile({ ui_experience: "technology", ui_theme: nextSurfaceTheme, ui_accent: nextAccent });
    }
  }, [accent, status, surfaceTheme, updateProfile]);

  const value = useMemo<ThemeContextValue>(() => ({
    surfaceTheme,
    theme,
    accent,
    availableAccents: THEME_ACCENTS[theme],
    setSurfaceTheme,
    setAccent,
    saveAppearance,
  }), [accent, saveAppearance, setAccent, setSurfaceTheme, surfaceTheme, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
