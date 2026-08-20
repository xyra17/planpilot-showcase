"use client";

import { createContext, useContext, useEffect, useState } from "react";

import { useAuthStore } from "@/lib/stores/authStore";
import {
  STYLE_DEFAULT_COLOR,
  isCompatibleColor,
  isJournalPalette,
  isThemeMode,
  type ColorScheme,
  type ColorThemeMode,
  type JournalPalette,
  type ThemeMode,
} from "@/lib/theme-presets";

export type { ColorScheme, JournalPalette, ThemeMode } from "@/lib/theme-presets";

type StyleColors = Record<ColorThemeMode, ColorScheme>;

interface ThemeContextType {
  mode: ThemeMode;
  colorScheme: ColorScheme;
  journalPalette: JournalPalette;
  styleColors: StyleColors;
  setMode: (mode: ThemeMode) => void;
  setColorScheme: (color: ColorScheme) => void;
  setJournalPalette: (palette: JournalPalette) => void;
}

const DEFAULT_STYLE_COLORS: StyleColors = {
  default: STYLE_DEFAULT_COLOR.default,
  dark: STYLE_DEFAULT_COLOR.dark,
  "eye-care": STYLE_DEFAULT_COLOR["eye-care"],
};

const ThemeContext = createContext<ThemeContextType>({
  mode: "default",
  colorScheme: DEFAULT_STYLE_COLORS.default,
  journalPalette: "wood",
  styleColors: DEFAULT_STYLE_COLORS,
  setMode: () => {},
  setColorScheme: () => {},
  setJournalPalette: () => {},
});

function colorStorageKey(userId: string, mode: ColorThemeMode) {
  return `theme-color-${mode}-${userId}`;
}

function applyTheme(mode: ThemeMode, colors: StyleColors, journalPalette: JournalPalette) {
  // The technology workspace owns its own complete visual system.  Keeping
  // the original theme provider mounted is useful for the classic UI, but it
  // must not overwrite the technology branch's document-level tokens.
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/studio")) return;
  const activeColor = mode === "journal" ? colors.default : colors[mode];
  document.documentElement.setAttribute("data-theme", mode);
  document.documentElement.setAttribute("data-color", activeColor);
  document.documentElement.setAttribute("data-journal", journalPalette);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const userId = useAuthStore((state) => state.user?.id ?? "guest");
  const modeKey = `theme-mode-${userId}`;
  const legacyColorKey = `theme-color-${userId}`;
  const journalKey = `journal-palette-${userId}`;

  const [mode, setModeState] = useState<ThemeMode>("default");
  const [styleColors, setStyleColors] = useState<StyleColors>(DEFAULT_STYLE_COLORS);
  const [journalPalette, setJournalPaletteState] = useState<JournalPalette>("wood");

  const colorScheme = mode === "journal" ? styleColors.default : styleColors[mode];

  function setMode(nextMode: ThemeMode) {
    setModeState(nextMode);
    localStorage.setItem(modeKey, nextMode);
    applyTheme(nextMode, styleColors, journalPalette);
  }

  function setColorScheme(nextColor: ColorScheme) {
    if (mode === "journal" || !isCompatibleColor(mode, nextColor)) return;
    const nextColors = { ...styleColors, [mode]: nextColor };
    setStyleColors(nextColors);
    localStorage.setItem(colorStorageKey(userId, mode), nextColor);
    // Keep the legacy key current for backwards compatibility with old clients.
    localStorage.setItem(legacyColorKey, nextColor);
    applyTheme(mode, nextColors, journalPalette);
  }

  function setJournalPalette(nextPalette: JournalPalette) {
    setJournalPaletteState(nextPalette);
    localStorage.setItem(journalKey, nextPalette);
    applyTheme(mode, styleColors, nextPalette);
  }

  useEffect(() => {
    const rawMode = localStorage.getItem(modeKey);
    let savedMode: ThemeMode = isThemeMode(rawMode) ? rawMode : "default";
    const legacyColor = localStorage.getItem(legacyColorKey);

    // Migrate removed full-theme color schemes to the dedicated journal style.
    if (legacyColor?.startsWith("calm-")) {
      savedMode = "journal";
      localStorage.setItem(modeKey, savedMode);
    }

    const nextColors = { ...DEFAULT_STYLE_COLORS };
    (["default", "dark", "eye-care"] as ColorThemeMode[]).forEach((styleMode) => {
      const stored = localStorage.getItem(colorStorageKey(userId, styleMode));
      const migrationCandidate = savedMode === styleMode ? legacyColor : null;
      const selected = isCompatibleColor(styleMode, stored)
        ? stored
        : isCompatibleColor(styleMode, migrationCandidate)
          ? migrationCandidate
          : STYLE_DEFAULT_COLOR[styleMode];
      nextColors[styleMode] = selected;
      localStorage.setItem(colorStorageKey(userId, styleMode), selected);
    });

    const storedJournal = localStorage.getItem(journalKey);
    const nextJournal = isJournalPalette(storedJournal) ? storedJournal : "wood";

    setModeState(savedMode);
    setStyleColors(nextColors);
    setJournalPaletteState(nextJournal);
    applyTheme(savedMode, nextColors, nextJournal);
  }, [journalKey, legacyColorKey, modeKey, userId]);

  const value = {
    mode,
    colorScheme,
    journalPalette,
    styleColors,
    setMode,
    setColorScheme,
    setJournalPalette,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
