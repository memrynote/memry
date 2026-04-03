interface Logger {
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
  debug(message: string, context?: Record<string, unknown>): void
}

export function createLogger(scope: string): Logger {
  const log = (
    level: string,
    consoleFn: (...args: unknown[]) => void,
    message: string,
    context?: Record<string, unknown>
  ): void => {
    consoleFn(JSON.stringify({ level, scope, message, ...context }))
  }

  return {
    info: (msg, ctx) => log('info', console.info, msg, ctx),
    warn: (msg, ctx) => log('warn', console.warn, msg, ctx),
    error: (msg, ctx) => log('error', console.error, msg, ctx),
    debug: (msg, ctx) => log('debug', console.debug, msg, ctx)
  }
}
