import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getTerminalCommandStatus,
  installTerminalCommand,
  uninstallTerminalCommand
} from './terminal-command'

function tempRoot(): string {
  const root = join(process.cwd(), 'test-results', 'memry-terminal-command')
  mkdirSync(root, { recursive: true })
  const caseDir = join(root, `case-${process.pid}-${randomUUID()}`)
  mkdirSync(caseDir)
  return caseDir
}

describe('terminal command setup', () => {
  it('installs a Unix shim that launches the packaged app in CLI mode', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const executablePath = join(root, 'Memrynote.app', 'Contents', 'MacOS', 'Memrynote')

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
      command: 'memrynote',
      shimPath: join(binDir, 'memrynote'),
      inPath: true
    })
    expect(readFileSync(status.shimPath, 'utf8')).toContain(`exec "${executablePath}" --cli "$@"`)
    expect(readFileSync(status.shimPath, 'utf8')).not.toContain('--ozone-platform')
  })

  it('installs a Linux shim that runs headless so a displayless host still works', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const executablePath = join(root, 'opt', 'MemryNote', 'memrynote')

    const status = await installTerminalCommand({
      platform: 'linux',
      homeDir: join(root, 'home'),
      executablePath,
      pathEnv: binDir,
      preferredBinDirs: [binDir]
    })

    expect(status.installed).toBe(true)
    expect(readFileSync(status.shimPath, 'utf8')).toContain(
      `exec "${executablePath}" --ozone-platform=headless --disable-gpu --cli "$@"`
    )
  })

  it('keeps the app path before the headless switches on Linux', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const executablePath = join(root, 'node_modules', 'electron', 'dist', 'electron')
    const appPath = join(root, 'memry', 'apps', 'desktop')

    const status = await installTerminalCommand({
      platform: 'linux',
      homeDir: join(root, 'home'),
      executablePath,
      appPath,
      pathEnv: binDir,
      preferredBinDirs: [binDir]
    })

    expect(readFileSync(status.shimPath, 'utf8')).toContain(
      `exec "${executablePath}" "${appPath}" --ozone-platform=headless --disable-gpu --cli "$@"`
    )
  })

  it('treats a pre-headless Linux shim as stale and replaces it', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const executablePath = join(root, 'opt', 'MemryNote', 'memrynote')
    const options = {
      platform: 'linux' as const,
      homeDir: join(root, 'home'),
      executablePath,
      pathEnv: binDir,
      preferredBinDirs: [binDir]
    }

    const initial = await installTerminalCommand(options)
    writeFileSync(
      initial.shimPath,
      `#!/bin/sh\n# Memry terminal command shim\nexec "${executablePath}" --cli "$@"\n`
    )

    expect((await getTerminalCommandStatus(options)).installed).toBe(false)

    const reinstalled = await installTerminalCommand(options)

    expect(reinstalled.installed).toBe(true)
    expect(readFileSync(reinstalled.shimPath, 'utf8')).toContain(
      `exec "${executablePath}" --ozone-platform=headless --disable-gpu --cli "$@"`
    )
  })

  it('installs a Unix shim with the app path when running from unpackaged Electron', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const executablePath = join(root, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    const appPath = join(root, 'memry', 'apps', 'desktop')

    const status = await installTerminalCommand({
      platform: 'darwin',
      homeDir: join(root, 'home'),
      executablePath,
      appPath,
      pathEnv: binDir,
      preferredBinDirs: [binDir]
    })

    expect(readFileSync(status.shimPath, 'utf8')).toContain(
      `exec "${executablePath}" "${appPath}" --cli "$@"`
    )
  })

  it('refuses to overwrite an unrelated command', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const shimPath = join(binDir, 'memrynote')
    chmodSync(root, 0o755)

    await installTerminalCommand({
      platform: 'linux',
      homeDir: join(root, 'home'),
      executablePath: join(root, 'Memrynote'),
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
    const executablePath = join(root, 'Memrynote.exe')

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
      command: 'memrynote',
      shimPath: join(windowsApps, 'memrynote.cmd'),
      inPath: true
    })
    expect(readFileSync(status.shimPath, 'utf8')).toContain(`"${executablePath}" --cli %*`)
    expect(readFileSync(status.shimPath, 'utf8')).not.toContain('--ozone-platform')
  })

  it('installs a Windows cmd shim with the app path when running from unpackaged Electron', async () => {
    const root = tempRoot()
    const windowsApps = join(root, 'WindowsApps')
    const executablePath = join(root, 'Electron.exe')
    const appPath = join(root, 'memry', 'apps', 'desktop')

    const status = await installTerminalCommand({
      platform: 'win32',
      homeDir: join(root, 'home'),
      executablePath,
      appPath,
      localAppData: root,
      pathEnv: windowsApps,
      preferredBinDirs: [windowsApps]
    })

    expect(readFileSync(status.shimPath, 'utf8')).toContain(
      `"${executablePath}" "${appPath}" --cli %*`
    )
  })

  it('does not report an outdated Memry shim as installed', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const executablePath = join(root, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    const appPath = join(root, 'memry', 'apps', 'desktop')

    const initial = await installTerminalCommand({
      platform: 'darwin',
      homeDir: join(root, 'home'),
      executablePath,
      pathEnv: binDir,
      preferredBinDirs: [binDir]
    })

    expect(
      await getTerminalCommandStatus({
        platform: 'darwin',
        homeDir: join(root, 'home'),
        executablePath,
        appPath,
        pathEnv: binDir,
        preferredBinDirs: [binDir]
      })
    ).toMatchObject({
      installed: false,
      shimPath: initial.shimPath
    })
  })

  it('replaces an outdated Memry-owned shim during install', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const executablePath = join(root, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    const appPath = join(root, 'memry', 'apps', 'desktop')

    const initial = await installTerminalCommand({
      platform: 'darwin',
      homeDir: join(root, 'home'),
      executablePath,
      pathEnv: binDir,
      preferredBinDirs: [binDir]
    })

    const status = await installTerminalCommand({
      platform: 'darwin',
      homeDir: join(root, 'home'),
      executablePath,
      appPath,
      pathEnv: binDir,
      preferredBinDirs: [binDir]
    })

    expect(status.installed).toBe(true)
    expect(status.shimPath).toBe(initial.shimPath)
    expect(readFileSync(status.shimPath, 'utf8')).toContain(
      `exec "${executablePath}" "${appPath}" --cli "$@"`
    )
  })

  it('uninstalls only Memry-owned shims', async () => {
    const root = tempRoot()
    const binDir = join(root, 'bin')
    const options = {
      platform: 'linux' as const,
      homeDir: join(root, 'home'),
      executablePath: join(root, 'Memrynote'),
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
