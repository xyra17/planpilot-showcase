"use client";

import { useLayoutEffect } from "react";

/**
 * Auth pages always use the native appearance. Workspace themes are persisted
 * for the product shell, but client navigation can otherwise leave the dark
 * document attributes active while the login route is mounted.
 */
export function AuthNativeThemeBoundary({ children }: { children: React.ReactNode }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    const previousSurfaceTheme = root.dataset.surfaceTheme;
    const previousColorScheme = root.style.colorScheme;

    root.dataset.theme = "default";
    root.dataset.surfaceTheme = "base";
    root.style.colorScheme = "light";

    return () => {
      if (previousTheme) root.dataset.theme = previousTheme;
      else delete root.dataset.theme;
      if (previousSurfaceTheme) root.dataset.surfaceTheme = previousSurfaceTheme;
      else delete root.dataset.surfaceTheme;
      root.style.colorScheme = previousColorScheme;
    };
  }, []);

  return <>{children}</>;
}
