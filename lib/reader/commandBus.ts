import type { ReaderCommand } from "@/lib/types";

export interface ReaderCommandBus {
  dispatch(command: ReaderCommand): void;
  subscribe(listener: (command: ReaderCommand) => void): () => void;
}

export function createReaderCommandBus(): ReaderCommandBus {
  const listeners = new Set<(command: ReaderCommand) => void>();

  return {
    dispatch(command) {
      for (const listener of listeners) {
        listener(command);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
