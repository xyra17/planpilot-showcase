import { create } from "zustand";
import { api, clearToken, getStoredUserInfo, storeUserInfo } from "@/lib/api";
import type { WeeklyAvailability } from "@/lib/technology/dayScheduler";

export interface UserInfo {
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
      reminder_email?: string | null;
      focus_target?: string;
      weekend_intensity?: string;
    };
  };
  onboarding_completed?: boolean;
}

interface AuthResponse {
  user: UserInfo;
  verification_email_sent?: boolean;
}

export interface RegistrationResult {
  user: UserInfo;
  verificationEmailSent: boolean;
}

interface AuthStore {
  user: UserInfo | null;
  isLoading: boolean;
  error: string | null;
  login: (identifier: string, password: string, remember?: boolean) => Promise<UserInfo>;
  register: (email: string, username: string, password: string) => Promise<RegistrationResult>;
  logout: () => void;
  initFromStorage: () => void;
  refreshUser: () => Promise<UserInfo>;
  updateUser: (data: Partial<UserInfo>) => Promise<void>;
  uploadAvatar: (file: File) => Promise<UserInfo>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isLoading: false,
  error: null,

  login: async (identifier, password, remember = true) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post<AuthResponse>("/api/v1/auth/login", { identifier, password, remember_me: remember });
      storeUserInfo(res.user);
      set({ user: res.user });
      return res.user;
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    } finally {
      set({ isLoading: false });
    }
  },

  register: async (email, username, password) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post<AuthResponse>("/api/v1/auth/register", { email, username, password });
      storeUserInfo(res.user);
      set({ user: res.user });
      return {
        user: res.user,
        verificationEmailSent: Boolean(res.verification_email_sent),
      };
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    } finally {
      set({ isLoading: false });
    }
  },

  logout: () => {
    void api.post("/api/v1/auth/logout", {}).catch(() => {});
    clearToken();
    set({ user: null, error: null });
  },

  initFromStorage: () => {
    try {
      const raw = getStoredUserInfo();
      if (raw) set({ user: JSON.parse(raw) as UserInfo });
    } catch {
      // ignore corrupt storage
    }
  },

  refreshUser: async () => {
    try {
      const current = await api.get<UserInfo>("/api/v1/auth/me");
      storeUserInfo(current);
      set({ user: current, error: null });
      return current;
    } catch (error) {
      clearToken();
      set({ user: null, error: (error as Error).message });
      throw error;
    }
  },

  updateUser: async (data) => {
    const updated = await api.patch<UserInfo>("/api/v1/auth/me", data);
    storeUserInfo(updated);
    set({ user: updated });
  },

  uploadAvatar: async (file) => {
    const formData = new FormData();
    formData.append("file", file);
    const updated = await api.upload<UserInfo>("/api/v1/auth/me/avatar", formData);
    storeUserInfo(updated);
    set({ user: updated });
    return updated;
  },

  changePassword: async (currentPassword, newPassword) => {
    await api.post("/api/v1/auth/change-password", {
      current_password: currentPassword,
      new_password: newPassword,
    });
  },
}));
