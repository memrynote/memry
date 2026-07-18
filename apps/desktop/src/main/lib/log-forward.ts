// Forwards worker-process warn/error logs to the main process's log-ship
// pipeline (Path A worker coverage). Workers can't ship logs directly —
// log-ship.ts needs electron's `net` — so this installs a lightweight
// electron-log transport that posts sanitized >=warn records to the parent
// over process.parentPort. The parent-side bridges forward `type: 'log'`
// messages into `getLogShip()?.ingestForwarded(...)` (see embeddings.ts,
// voice-model.ts, image-processing/bridge.ts).
//
// Electron-free by design: only `electron-log` + the `process.parentPort`
// runtime global, both allowed in worker bundles (see
// scripts/check-worker-bundles.mjs). Do not import anything that pulls in
// 'electron' — that would crash every worker at boot in packaged builds.
import log from 'electron-log'

const LEVEL_ORDER: Record<string, number> = {
  error: 50,
  warn: 40,
  info: 30,
  verbose: 20,
  debug: 10,
  silly: 0
}

interface ParentPortLike {
  postMessage: (message: unknown) => void
}

interface WorkerLogTransportMessage {
  level: string
  scope?: string
  data: unknown[]
}

type ForwardTransport = ((message: WorkerLogTransportMessage) => void) & { level: string }

// Shallow-clones a log call's args into structured-cloneable values: functions
// are dropped (can't cross postMessage), Errors lose their prototype over the
// message port so they're flattened to a plain { name, message } object.
// Anything else (primitives, plain objects/arrays) passes through untouched —
// the postMessage try/catch below is the safety net for the rare arg that
// still isn't cloneable.
const sanitizeArgs = (data: unknown[]): unknown[] => {
  const sanitized: unknown[] = []
  for (const arg of data) {
    if (typeof arg === 'function') continue
    if (arg instanceof Error) {
      sanitized.push({ name: arg.name, message: arg.message })
      continue
    }
    sanitized.push(arg)
  }
  return sanitized
}

export const installWorkerLogForwarding = (workerName: string): void => {
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  if (!port) return

  const forward = ((message: WorkerLogTransportMessage) => {
    if ((LEVEL_ORDER[message.level] ?? -1) < LEVEL_ORDER.warn) return
    try {
      port.postMessage({
        type: 'log',
        record: {
          level: message.level,
          scope: message.scope ?? workerName,
          data: sanitizeArgs(message.data)
        }
      })
    } catch {
      // Forwarding is best-effort; a bad arg must never crash the worker.
    }
  }) as ForwardTransport
  forward.level = 'warn'
  ;(log.transports as unknown as Record<string, ForwardTransport | null>).forwardToMain = forward
}
