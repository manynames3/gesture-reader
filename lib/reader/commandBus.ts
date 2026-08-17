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

  return {
    async dispatch(command) {
      if (listeners.size === 0) {
        return { status: "rejected", reason: "notReady" };
      }
      // Freeze the recipients before awaiting. A command created for one PDF
      // must never spill into a reader that subscribes while it is in flight.
      const recipients = [...listeners];
      for (const listener of recipients) {
        const result = await listener(command);
        if (
          result.status === "confirmed" ||
          result.reason !== "notReady"
        ) {
          return result;
        }
      }
      return { status: "rejected", reason: "notReady" };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
