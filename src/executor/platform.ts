/**
 * G-16: the plan executor is Windows-only in this release. Its slots live under a drive-letter path
 * (`routing.executor.slotsDir`, default `<drive>:\.omr-slots\<planId>`), so on any other platform the executor is not
 * assembled on OpenCode v2: `router_plan` and `/plan` are not registered, `/router` does not list `/plan`, role
 * registration does no executor-home lookup and grants no slots root, and start-up executor discovery does nothing.
 *
 * This module is the one platform seam: every caller asks {@link executorPlatformSupported}, whose `platform` defaults to
 * `process.platform`, so a test drives both platforms by spying on it.
 */

/** The one notice per process on a platform without the executor, logged only when the config asks for it. */
export const EXECUTOR_PLATFORM_NOTICE = "plan executor requires Windows; router_plan and /plan are not registered";

/** The executor access's unavailable reason on such a platform (start-up discovery is skipped with it). */
export const EXECUTOR_PLATFORM_REASON = "the plan executor requires Windows";

/** Whether the plan executor can be assembled on `platform` (default: this process's). */
export function executorPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * QA-62C-3: the "notice logged" flag lives on `globalThis` under a registry symbol, so every loaded copy of this module
 * (a hot reload, a second bundle) shares it and the process still logs one notice.
 */
const platformNoticeKey = Symbol.for("omr.executor.platformNotice.v1");
const platformNotice = globalThis as typeof globalThis & { [platformNoticeKey]?: boolean };

/** Logs {@link EXECUTOR_PLATFORM_NOTICE} once per process (AGENTS.md: at most one notice per process for an inert feature). */
export function warnExecutorPlatformOnce(logger: { warn(message: string): void }): void {
  if (platformNotice[platformNoticeKey] === true) return;
  platformNotice[platformNoticeKey] = true;
  logger.warn(`[router] ${EXECUTOR_PLATFORM_NOTICE}`);
}

/** Tests only: forget that the notice was logged. */
export function resetExecutorPlatformNotice(): void {
  delete platformNotice[platformNoticeKey];
}
