/**
 * Hook logging utility for Claude Code hooks.
 * Provides filtered console.error output with consistent formatting.
 */

/**
 * Log levels in order of severity.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logs a message to console.error with consistent formatting.
 *
 * @param level - The log level ('debug'|'info'|'warn'|'error')
 * @param args - Message arguments to log (joined with spaces)
 *
 * @example
 * hookLog('info', 'Hook started');
 * hookLog('debug', 'Processing file:', filePath);
 * hookLog('warn', 'Deprecated option used');
 * hookLog('error', 'Failed with:', error.message);
 */
export function hookLog(level: LogLevel, ...args: unknown[]): void {
  // Skip debug level unless HOOK_DEBUG environment variable is set
  if (level === 'debug' && !process.env.HOOK_DEBUG) {
    return;
  }

  const message = args.map(String).join(' ');
  console.error(`[HOOK ${level.toUpperCase()}] ${message}`);
}

/**
 * Convenience logger instance with pre-bound hookLog function.
 * Provides shorthand logging methods for each level.
 *
 * @example
 * logger.info('Hook completed');
 * logger.debug('Processing details');
 * logger.warn('Attention needed');
 * logger.error('Something failed');
 */
export const logger = {
  /** Log a debug message (only if HOOK_DEBUG is set) */
  debug: (...args: unknown[]) => hookLog('debug', ...args),

  /** Log an info message */
  info: (...args: unknown[]) => hookLog('info', ...args),

  /** Log a warning message */
  warn: (...args: unknown[]) => hookLog('warn', ...args),

  /** Log an error message */
  error: (...args: unknown[]) => hookLog('error', ...args),
};
