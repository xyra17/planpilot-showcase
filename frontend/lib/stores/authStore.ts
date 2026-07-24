import { create } from "zustand";
import { api, storeToken, clearToken } from "@/lib/api";

export interface UserInfo {
  id: string;
  email: string;
  username: string;
  created_at?: string;
}

interface AuthResponse {
  access_token: string;
  user: UserInfo;
}

interface AuthStore {
  user: UserInfo | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string) => Promise<void>;
  logout: () => void;
  initFromStorage: () => void;
  updateUser: (data: Partial<UserInfo>) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isLoading: false,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post<AuthResponse>("/api/v1/auth/login", { email, password });
      storeToken(res.access_token, res.user.username);
      localStorage.setItem("user_info", JSON.stringify(res.user));
      set({ user: res.user });
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
      storeToken(res.access_token, res.user.username);
      localStorage.setItem("user_info", JSON.stringify(res.user));
      set({ user: res.user });
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
    localStorage.removeItem("user_info");
    set({ user: null, error: null });
  },

  initFromStorage: () => {
    try {
      const raw = localStorage.getItem("user_info");
      if (raw) set({ user: JSON.parse(raw) as UserInfo });
    } catch {
      // ignore corrupt storage
    }
  },

  updateUser: async (data) => {
    const updated = await api.patch<UserInfo>("/api/v1/auth/me", data);
    localStorage.setItem("user_info", JSON.stringify(updated));
    if (updated.username) localStorage.setItem("user_name", updated.username);
    set({ user: updated });
  },

  changePassword: async (currentPassword, newPassword) => {
    await api.post("/api/v1/auth/change-password", {
      current_password: currentPassword,
      new_password: newPassword,
    });
  },
}));
