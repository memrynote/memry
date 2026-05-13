import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getTerminalCommandStatus,
  installTerminalCommand,
  uninstallTerminalCommand
} from './terminal-command'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'memry-terminal-command-'))
}

describe('terminal command setup', () => {
  it('installs a Unix shim that launches the packaged app in CLI mode', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const executablePath = join(root, 'Memry.app', 'Contents', 'MacOS', 'Memry')

    const status = await installTerminalCommand({
      platform: 'darwin',
      homeDir: join(root, 'home'),
      executablePath,
      pathEnv: binDir,
      preferredBinDirs: [binDir]
    })

    expect(status).toMatchObject({
      installed: true,
      platform: 'darwin',
      command: 'memry',
      shimPath: join(binDir, 'memry'),
      inPath: true
    })
    expect(readFileSync(status.shimPath, 'utf8')).toContain(`exec "${executablePath}" --cli "$@"`)
  })

  it('refuses to overwrite an unrelated command', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const shimPath = join(binDir, 'memry')
    chmodSync(root, 0o755)

    await installTerminalCommand({
      platform: 'linux',
      homeDir: join(root, 'home'),
      executablePath: join(root, 'Memry'),
      pathEnv: binDir,
      preferredBinDirs: [binDir]
    })
    writeFileSync(shimPath, '#!/bin/sh\necho not memry\n')

    await expect(
      installTerminalCommand({
        platform: 'linux',
        homeDir: join(root, 'home'),
        executablePath: join(root, 'OtherMemry'),
        pathEnv: binDir,
        preferredBinDirs: [binDir]
      })
    ).rejects.toThrow(/already exists/)
  })

  it('installs a Windows cmd shim in the user path directory', async () => {
    const root = tempRoot()
    const windowsApps = join(root, 'WindowsApps')
    const executablePath = join(root, 'Memry.exe')

    const status = await installTerminalCommand({
      platform: 'win32',
      homeDir: join(root, 'home'),
      executablePath,
      localAppData: root,
      pathEnv: windowsApps,
      preferredBinDirs: [windowsApps]
    })

    expect(status).toMatchObject({
      installed: true,
      platform: 'win32',
      command: 'memry',
      shimPath: join(windowsApps, 'memry.cmd'),
      inPath: true
    })
    expect(readFileSync(status.shimPath, 'utf8')).toContain(`"${executablePath}" --cli %*`)
  })

  it('uninstalls only Memry-owned shims', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const options = {
      platform: 'linux' as const,
      homeDir: join(root, 'home'),
      executablePath: join(root, 'Memry'),
      pathEnv: binDir,
      preferredBinDirs: [binDir]
    }

    await installTerminalCommand(options)
    expect((await getTerminalCommandStatus(options)).installed).toBe(true)

    const status = await uninstallTerminalCommand(options)

    expect(status.installed).toBe(false)
    expect((await getTerminalCommandStatus(options)).installed).toBe(false)
  })
})
