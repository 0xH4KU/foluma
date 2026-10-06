import type { HostAPI } from "./types.ts";

export function createActionRunner(
  host: Pick<HostAPI, "setBusy" | "notify" | "report">,
  changed?: (busy: boolean) => void,
) {
  let running = false;
  return async (action: () => Promise<unknown>, reportError = true): Promise<boolean> => {
    if (running) return false;
    running = true;
    changed?.(true);
    host.setBusy?.(true);
    try {
      host.notify("");
      await action();
      return true;
    } catch (error) {
      if (!reportError) throw error;
      host.report(error);
      return false;
    } finally {
      running = false;
      host.setBusy?.(false);
      changed?.(false);
    }
  };
}
