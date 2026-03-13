import log from 'electron-log'

const isDev = process.env.NODE_ENV !== 'production'

log.transports.file.level = isDev ? 'debug' : 'info'
log.transports.file.maxSize = 5 * 1024 * 1024
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] [{scope}] {text}'

log.transports.console.level = isDev ? 'debug' : 'warn'
log.transports.console.format = '{h}:{i}:{s}.{ms} [{level}] [{scope}] {text}'

log.errorHandler.startCatching({
  showDialog: false,
  onError({ error }) {
    if (error?.message?.includes('EIO')) {
      log.transports.console.level = false
    }
  }
})

function disableConsoleTransport(): void {
  log.transports.console.level = false
}

function createLogger(scope: string) {
  return log.scope(scope)
}

export { log, createLogger, disableConsoleTransport }
