import { ipcMain } from 'electron'
import { setIpcHandlerChannel } from '../validate'

type IpcHandleListener = Parameters<typeof ipcMain.handle>[1]

let installed = false

/**
 * Make every IPC failure name the channel it came from.
 *
 * `createValidatedHandler` / `createHandler` wrap an anonymous arrow, so the
 * only label they could report was the generic `validated_handler` — which
 * collapsed every inline handler in the app into one telemetry action. A
 * `ZodError` from a contract schema was therefore unattributable: the captured
 * stack names the bundled wrapper and Zod strips its own frames, so nothing on
 * the wire identified the handler.
 *
 * `ipcMain.handle(channel, listener)` is the one place that knows both halves.
 * Wrapping it records the pairing once, centrally, instead of threading a
 * channel argument through 175 registration sites. Behaviour is untouched: the
 * real `handle` is always called with the same arguments.
 *
 * Call this before any handler registers (`registerAllHandlers` does).
 * Registrations that happen earlier simply keep the old generic label.
 */
export function installIpcChannelLabels(): void {
  if (installed) return
  installed = true

  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel: string, listener: IpcHandleListener): void => {
    setIpcHandlerChannel(listener, channel)
    originalHandle(channel, listener)
  }
}
