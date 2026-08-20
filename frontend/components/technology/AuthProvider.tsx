"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, clearAccessToken, getStoredUserInfo, storeUserInfo } from "@/lib/api";
import type { WeeklyAvailability } from "@/lib/technology/dayScheduler";

export type AuthUser = {
  id: string;
  email: string;
  username: string;
  avatar_url?: string | null;
  email_verified?: boolean;
  is_admin?: boolean;
  timezone?: string;
  language?: "zh-CN" | "en-US";
  week_start?: "monday" | "sunday";
  study_days?: string[];
  availability_windows?: string[];
  weekly_availability?: WeeklyAvailability | null;
  created_at?: string;
  ui_experience?: "technology" | "minimal";
  ui_theme?: "base" | "notebook" | "dark";
  ui_accent?: string;
  font_density?: "compact" | "comfortable" | "relaxed";
  preferred_start_method?: "create_goal" | "import_plan" | "connect_calendar" | "sample_space";
  account_preferences?: {
    knowledge_favorites?: Array<string | number>;
    pilo_learned_preferences?: Record<string, unknown>;
    study_preferences?: {
      reminder_enabled?: boolean;
      reminder_time?: string;
      reminder_channel?: "email";
      reminder_email?: string | null;
      focus_target?: string;
      weekend_intensity?: string;
    };
  };
  onboarding_completed?: boolean;
};

type LoginResponse = {
  user: AuthUser;
};

type AuthContextValue = {
  user: AuthUser | null;
  status: "loading" | "authenticated" | "unauthenticated";
  login: (identifier: string, password: string, remember?: boolean) => Promise<AuthUser>;
  register: (email: string, username: string, password: string) => Promise<AuthUser>;
  logout: () => void;
  refreshUser: () => Promise<AuthUser>;
  updateProfile: (data: Partial<Omit<AuthUser, "id" | "created_at" | "email_verified" | "is_admin">>) => Promise<AuthUser>;
  uploadAvatar: (file: File) => Promise<AuthUser>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readCachedUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = getStoredUserInfo();
    return raw ? JSON.parse(raw) as AuthUser : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthContextValue["status"]>("loading");

  const persistUser = useCallback((nextUser: AuthUser) => {
    storeUserInfo(nextUser);
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  const refreshUser = useCallback(async () => {
    const currentUser = await api.get<AuthUser>("/api/v1/auth/me");
    persistUser(currentUser);
    return currentUser;
  }, [persistUser]);

  useEffect(() => {
    const cached = readCachedUser();
    if (cached) setUser(cached);
    void refreshUser().catch(() => {
      clearAccessToken();
      setUser(null);
      setStatus("unauthenticated");
    });
  }, [refreshUser]);

  const login = useCallback(async (identifier: string, password: string, remember = true) => {
    const result = await api.post<LoginResponse>("/api/v1/auth/login", { identifier, password, remember_me: remember });
    persistUser(result.user);
    return result.user;
  }, [persistUser]);

  const register = useCallback(async (email: string, username: string, password: string) => {
    const result = await api.post<LoginResponse>("/api/v1/auth/register", { email, username, password });
    persistUser(result.user);
    return result.user;
  }, [persistUser]);

  const updateProfile = useCallback(async (
    data: Partial<Omit<AuthUser, "id" | "created_at" | "email_verified" | "is_admin">>,
  ) => {
    const updated = await api.patch<AuthUser>("/api/v1/auth/me", data);
    persistUser(updated);
    return updated;
  }, [persistUser]);

  const uploadAvatar = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const updated = await api.upload<AuthUser>("/api/v1/auth/me/avatar", formData);
    persistUser(updated);
    return updated;
  }, [persistUser]);

  const logout = useCallback(() => {
    void api.post("/api/v1/auth/logout", {}).catch(() => undefined);
    clearAccessToken();
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const value = useMemo(
    () => ({ user, status, login, register, logout, refreshUser, updateProfile, uploadAvatar }),
    [user, status, login, register, logout, refreshUser, updateProfile, uploadAvatar],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
