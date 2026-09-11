import fs from 'node:fs'
import path from 'node:path'

export type WindowsInstallLayout = 'nsis' | 'velopack' | 'unknown'

export const NSIS_UNINSTALLER_FILENAME = 'Uninstall MemryNote.exe'

/**
 * velopack: `<dir>\..\Update.exe` exists; nsis: `<dir>\Uninstall MemryNote.exe`
 * exists; else unknown. Windows paths by definition, so `path.win32` keeps the
 * probe paths identical on the macOS test host.
 */
export function detectWindowsInstallLayout(
  execPath: string,
  exists: (p: string) => boolean = fs.existsSync
): WindowsInstallLayout {
  const dir = path.win32.dirname(execPath)
  if (exists(path.win32.join(dir, '..', 'Update.exe'))) return 'velopack'
  if (exists(path.win32.join(dir, NSIS_UNINSTALLER_FILENAME))) return 'nsis'
  return 'unknown'
}
