import { create } from "zustand";

import type { ChatMessage } from "../types";

export interface ChatState {
  messages: ChatMessage[];
  /** True while a turn is in flight. */
  pending: boolean;
  error: string | null;

  append(message: ChatMessage): void;
  setPending(pending: boolean): void;
  setError(error: string | null): void;
  clear(): void;
}

/**
 * Session-scoped transcript for the chat route. Kept out of `useStudioStore`
 * (and out of localStorage) for the same reason `running` is: it is runtime
 * state, not part of the workbench's persisted design.
 */
export const useChatStore = create<ChatState>()((set) => ({
  messages: [],
  pending: false,
  error: null,

  append: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  setPending: (pending) => set({ pending }),
  setError: (error) => set({ error }),
  clear: () => set({ messages: [], error: null, pending: false }),
}));

/** Id shape mirrors the pipeline's run ids so both read the same in logs. */
export function nextMessageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
