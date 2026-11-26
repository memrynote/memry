/**
 * The watcher's `ignored` matcher on Windows (#5607). chokidar 5 hands a
 * function matcher `normalizePath(path)`, which turns `\` into `/`, so on
 * Windows the matcher sees `C:/v/attachments/n1/a.png` for a vault opened as
 * `C:\v`. Node's `path` is `path.win32` here, as it is on Windows, so the
 * matcher runs with the separators and path rules it gets there.
 *
 * @module vault/watcher-windows-paths.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as PathModule from 'path'

vi.mock('path', async (importOriginal) => {
  const { win32 } = await importOriginal<typeof PathModule>()
  return { ...win32, default: win32 }
})

const mockWatch = vi.hoisted(() => vi.fn())
vi.mock('chokidar', () => ({ default: { watch: mockWatch }, watch: mockWatch }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { trashItem: vi.fn() }
}))
// Writes a temp file with the real fs, which win32 path joins would misplace.
vi.mock('./birthtime-probe', () => ({ probeBirthtime: vi.fn(async () => null) }))

import { VaultWatcher } from './watcher'

type Ignored = (filePath: string, stats?: { isFile: () => boolean }) => boolean

const file = { isFile: () => true }
const dir = { isFile: () => false }

async function startOnWindowsVault(watcher: VaultWatcher): Promise<Ignored> {
  const chokidar = {
    on: vi.fn(() => chokidar),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'ready') handler()
      return chokidar
    }),
    close: vi.fn(async () => {})
  }
  mockWatch.mockReturnValue(chokidar)
  await watcher.start({ vaultPath: 'C:\\v' })
  const options = mockWatch.mock.calls[0][1] as { ignored: Ignored }
  return options.ignored
}

describe('vault watcher on a Windows vault', () => {
  const watcher = new VaultWatcher()

  afterEach(async () => {
    await watcher.stop()
    mockWatch.mockReset()
  })

  it('ignores the root attachments folder as chokidar names it, and nothing else', async () => {
    const ignored = await startOnWindowsVault(watcher)

    expect(ignored('C:/v/attachments', dir)).toBe(true)
    expect(ignored('C:/v/attachments/n1/a.png', file)).toBe(true)
    expect(ignored('C:\\v\\attachments\\n1\\a.png', file)).toBe(true)
    // Notes, and an attachments folder below the root, are the user's (#3161).
    expect(ignored('C:/v/notes/a.png', file)).toBe(false)
    expect(ignored('C:/v/Projects/attachments', dir)).toBe(false)
    expect(ignored('C:/v/Projects/attachments/a.png', file)).toBe(false)
    expect(ignored('C:/v/attachments-old/a.png', file)).toBe(false)
  })
})
