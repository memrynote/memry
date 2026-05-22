import { ipcMain } from 'electron'
import { z } from 'zod'
import { DebugMemoryChannels } from '@memry/contracts/ipc-channels'
import { createValidatedHandler } from '../ipc/validate'
import { captureDebugMemorySnapshot, isMemoryDebugEnabled } from './memory-snapshot'

type OptionalIpcMain = {
  handle?: typeof ipcMain.handle
  removeHandler?: typeof ipcMain.removeHandler
}

const DebugMemorySnapshotSchema = z.preprocess(
  (input) => input ?? {},
  z.object({
    scenario: z.enum(['boot', 'idle-60s']).default('boot'),
    label: z.string().min(1).default('ipc'),
    branch: z.string().min(1).default('unknown')
  })
)

export function registerDebugMemoryHandlers(): void {
  if (!isMemoryDebugEnabled()) return

  const memoryIpcMain = ipcMain as OptionalIpcMain | undefined
  memoryIpcMain?.handle?.(
    DebugMemoryChannels.invoke.MEMORY_SNAPSHOT,
    createValidatedHandler(DebugMemorySnapshotSchema, captureDebugMemorySnapshot)
  )
}

export function unregisterDebugMemoryHandlers(): void {
  const memoryIpcMain = ipcMain as OptionalIpcMain | undefined
  memoryIpcMain?.removeHandler?.(DebugMemoryChannels.invoke.MEMORY_SNAPSHOT)
}
