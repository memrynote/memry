import { BrowserWindow } from 'electron'

/**
 * Send an IPC payload to every live window.
 *
 * getAllWindows() can contain destroyed short-lived windows (splash,
 * quick-capture, print/export); touching their webContents throws
 * "Object has been destroyed". Callers run inside db transactions (sync item
 * handlers), where an unguarded throw rolls back an applied item — so skip
 * destroyed windows, mirroring window-rpc.ts and crdt-provider.ts.
 */
export function broadcastToAllWindows(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (typeof win.webContents.isDestroyed === 'function' && win.webContents.isDestroyed()) continue
    win.webContents.send(channel, data)
  }
}
