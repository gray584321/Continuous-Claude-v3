// src/shared/hook-logger.ts
function hookLog(level, ...args) {
  if (level === "debug" && !process.env.HOOK_DEBUG) {
    return;
  }
  const message = args.map(String).join(" ");
  console.error(`[HOOK ${level.toUpperCase()}] ${message}`);
}
var logger = {
  /** Log a debug message (only if HOOK_DEBUG is set) */
  debug: (...args) => hookLog("debug", ...args),
  /** Log an info message */
  info: (...args) => hookLog("info", ...args),
  /** Log a warning message */
  warn: (...args) => hookLog("warn", ...args),
  /** Log an error message */
  error: (...args) => hookLog("error", ...args)
};
export {
  hookLog,
  logger
};
