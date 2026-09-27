import type { NavigationResult } from "@/lib/types";

export interface ConfirmedPageViewer {
  getCurrentPage(): number;
  setCurrentPage(page: number): void;
  forcePageIntoView?(page: number): void;
}

interface PendingNavigation {
  from: number;
  target: number;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve(result: NavigationResult): void;
}

export class ConfirmedPageNavigator {
  private pending?: PendingNavigation;

  constructor(
    private readonly viewer: ConfirmedPageViewer,
    private readonly confirmationTimeoutMs = 450,
  ) {}

  navigate(target: number): Promise<NavigationResult> {
    const from = this.viewer.getCurrentPage();
    if (this.pending) {
      return Promise.resolve({
        status: "rejected",
        reason: "busy",
        page: from,
      });
    }
    if (target === from) {
      return Promise.resolve({ status: "confirmed", from, to: target });
    }

    return new Promise((resolve) => {
      this.pending = { from, target, attempt: 0, resolve };
      this.applyPending();
    });
  }

  confirm(page: number) {
    const pending = this.pending;
    if (!pending || page !== pending.target) return;
    this.finish({
      status: "confirmed",
      from: pending.from,
      to: pending.target,
    });
  }

  dispose() {
    const page = this.viewer.getCurrentPage();
    this.finish({ status: "rejected", reason: "notReady", page });
  }

  private applyPending() {
    const pending = this.pending;
    if (!pending) return;
    pending.attempt += 1;
    try {
      this.viewer.setCurrentPage(pending.target);
      if (pending.attempt > 1) {
        this.viewer.forcePageIntoView?.(pending.target);
      }
    } catch {
      if (pending.attempt > 1) {
        this.finish({
          status: "rejected",
          reason: "notReady",
          page: this.viewer.getCurrentPage(),
        });
        return;
      }
    }

    if (this.pending !== pending) return;
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      if (pending.attempt === 1) {
        this.applyPending();
        return;
      }
      this.finish({
        status: "rejected",
        reason: "timeout",
        page: this.viewer.getCurrentPage(),
      });
    }, this.confirmationTimeoutMs);
  }

  private finish(result: NavigationResult) {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.resolve(result);
  }
}
