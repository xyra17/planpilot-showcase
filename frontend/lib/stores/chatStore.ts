import { create } from "zustand";

export interface ReplanOption {
  label: string;
  description: string;
  trade_off: string;
  new_daily_hours?: number;
  new_deadline?: string;
  tasks: { title: string; estimated_mins: number; type: string }[];
}

export interface ReplanOptions {
  goal_id: string;
  option_a: ReplanOption;
  option_b: ReplanOption;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  structuredOutput?: Record<string, unknown>;
  confirmationRequired?: Record<string, unknown>;
  replanOptions?: ReplanOptions;
}

interface ChatStore {
  messages: ChatMessage[];
  isStreaming: boolean;
  toolStatus: string;
  sessionId: string;
  addUserMessage: (text: string) => void;
  appendToken: (token: string) => void;
  setToolStatus: (status: string) => void;
  setStructuredOutput: (data: Record<string, unknown>) => void;
  setConfirmationRequired: (data: Record<string, unknown> | null) => void;
  setReplanOptions: (data: ReplanOptions | null) => void;
  setStreaming: (v: boolean) => void;
  clearMessages: () => void;
  resetSession: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  isStreaming: false,
  toolStatus: "",
  sessionId: typeof crypto !== "undefined" ? crypto.randomUUID() : Math.random().toString(36),

  addUserMessage: (text) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { id: crypto.randomUUID(), role: "user", content: text },
        { id: crypto.randomUUID(), role: "assistant", content: "" },
      ],
    })),

  appendToken: (token) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      msgs[msgs.length - 1] = { ...last, content: last.content + token };
      return { messages: msgs };
    }),

  setToolStatus: (toolStatus) => set({ toolStatus }),

  setStructuredOutput: (data) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      msgs[msgs.length - 1] = { ...last, structuredOutput: data };
      return { messages: msgs };
    }),

  setConfirmationRequired: (data) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      msgs[msgs.length - 1] = { ...last, confirmationRequired: data ?? undefined };
      return { messages: msgs };
    }),

  setReplanOptions: (data) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      msgs[msgs.length - 1] = { ...last, replanOptions: data ?? undefined };
      return { messages: msgs };
    }),

  setStreaming: (isStreaming) => set({ isStreaming }),
  clearMessages: () => set({ messages: [] }),
  resetSession: () => set({
    sessionId: crypto.randomUUID(),
    messages: [],
    isStreaming: false,
    toolStatus: "",
  }),
}));
