import { BrowserWindow } from 'electron'
import { createLogger } from './logger'

const logger = createLogger('WindowBroadcast')

/**
 * Send an IPC payload to every live window.
 *
 * getAllWindows() can contain destroyed short-lived windows (splash,
 * quick-capture, print/export); touching their webContents throws
 * "Object has been destroyed". Callers run inside db transactions (sync item
 * handlers), where an unguarded throw rolls back an applied item — so skip
 * destroyed windows, mirroring window-rpc.ts and crdt-provider.ts.
 *
 * A window can also die *between* the guard and the send. That race is
 * contained per window rather than allowed to abort the fan-out: a window that
 * cannot be reached must not stop the remaining windows from receiving the
 * event, and must not surface as a throw in a caller that is mid-transaction.
 * The failure is logged, never silently dropped.
 *
 * `args` is a rest parameter so each call site keeps its exact `send()` arity —
 * a zero-payload broadcast stays zero-payload rather than gaining an explicit
 * `undefined` argument.
 */
export function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (typeof win.webContents.isDestroyed === 'function' && win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(channel, ...args)
    } catch (err) {
      logger.warn(`Failed to deliver ${channel} to a window:`, err)
    }
  }
}
