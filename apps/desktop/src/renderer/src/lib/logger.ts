import log from 'electron-log/renderer'

function createLogger(scope: string) {
  return log.scope(scope)
}

export { log, createLogger }
