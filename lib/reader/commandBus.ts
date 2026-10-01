import type {
  NavigationResult,
  ReaderCommand,
} from "@/lib/types";

export type ReaderCommandListener = (
  command: ReaderCommand,
) => NavigationResult | Promise<NavigationResult>;

export interface ReaderCommandBus {
  dispatch(command: ReaderCommand): Promise<NavigationResult>;
  subscribe(listener: ReaderCommandListener): () => void;
}

export function createReaderCommandBus(): ReaderCommandBus {
  const listeners = new Set<ReaderCommandListener>();
  const queue: Array<{
    command: ReaderCommand;
    recipients: ReaderCommandListener[];
    resolve(result: NavigationResult): void;
    reject(reason: unknown): void;
  }> = [];
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const request = queue.shift()!;
        try {
          let result: NavigationResult = { status: "rejected", reason: "notReady" };
          for (const listener of request.recipients) {
            // Queued work belongs to the PDF that was open when requested.
            if (!listeners.has(listener)) continue;
            result = await listener(request.command);
            if (result.status === "confirmed" || result.reason !== "notReady") break;
          }
          request.resolve(result);
        } catch (error) {
          request.reject(error);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    dispatch(command) {
      return new Promise((resolve, reject) => {
        queue.push({ command, recipients: [...listeners], resolve, reject });
        void drain();
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
