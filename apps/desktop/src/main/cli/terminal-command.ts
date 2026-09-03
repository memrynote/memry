import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync
} from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'

export type TerminalCommandPlatform = 'darwin' | 'linux' | 'win32'

export interface TerminalCommandStatus {
  supported: boolean
  installed: boolean
  command: 'memrynote'
  platform: TerminalCommandPlatform
  shimPath: string
  binDir: string
  targetPath: string
  inPath: boolean
  pathHint: string | null
}

export interface TerminalCommandOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  executablePath?: string
  appPath?: string | null
  localAppData?: string
  pathEnv?: string
  preferredBinDirs?: string[]
}

const COMMAND_NAME = 'memrynote'
const SHIM_MARKER = 'Memry terminal command shim'
const SHIM_MODE = 0o755

// Ozone initializes before the `--cli` route gets to run, so on a Linux host
// with neither X11 nor Wayland the launcher dies on display init
// ("Missing X server or $DISPLAY") even though the CLI never opens a window.
// Selecting Ozone's headless backend skips that initialization, which is what
// makes the generated launcher usable on a displayless server without
// installing Xvfb. Chromium's `--headless` is a chrome/-layer switch that
// Electron does not implement, so it would be silently ignored here. The
// switches must precede `--cli`, since everything after it is forwarded to the
// CLI parser. macOS and Windows have no equivalent failure and stay untouched.
const LINUX_HEADLESS_SWITCHES = '--ozone-platform=headless --disable-gpu'

function resolvePlatform(platform: NodeJS.Platform = process.platform): TerminalCommandPlatform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform
  return 'linux'
}

function normalizePathForCompare(value: string, platform: TerminalCommandPlatform): string {
  return platform === 'win32' ? value.toLowerCase() : value
}

function pathContainsDir(pathEnv: string, dir: string, platform: TerminalCommandPlatform): boolean {
  const expected = normalizePathForCompare(dir, platform)
  return pathEnv
    .split(platform === 'win32' ? ';' : delimiter)
    .filter(Boolean)
    .map((entry) => normalizePathForCompare(entry, platform))
    .includes(expected)
}

function defaultLocalAppData(homeDir: string): string {
  return process.env.LOCALAPPDATA ?? join(homeDir, 'AppData', 'Local')
}

function defaultBinDirs(
  platform: TerminalCommandPlatform,
  homeDir: string,
  localAppData: string
): string[] {
  if (platform === 'win32') {
    return [join(localAppData, 'Microsoft', 'WindowsApps')]
  }

  if (platform === 'darwin') {
    return ['/usr/local/bin', '/opt/homebrew/bin', join(homeDir, '.local', 'bin')]
  }

  return [join(homeDir, '.local', 'bin'), join(homeDir, 'bin'), '/usr/local/bin']
}

async function canWriteDir(dir: string): Promise<boolean> {
  try {
    if (!existsSync(dir)) {
      await access(dirname(dir), constants.W_OK)
      return true
    }

    await access(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function chooseBinDir(options: RequiredTerminalCommandOptions): Promise<string> {
  const inPathWritable: string[] = []
  const writable: string[] = []

  for (const dir of options.binDirs) {
    const canWrite = await canWriteDir(dir)
    if (!canWrite) continue
    writable.push(dir)
    if (pathContainsDir(options.pathEnv, dir, options.platform)) {
      inPathWritable.push(dir)
    }
  }

  return inPathWritable[0] ?? writable[0] ?? options.binDirs[0]
}

interface RequiredTerminalCommandOptions {
  platform: TerminalCommandPlatform
  homeDir: string
  executablePath: string
  appPath: string | null
  localAppData: string
  pathEnv: string
  binDirs: string[]
}

function normalizeOptions(options: TerminalCommandOptions): RequiredTerminalCommandOptions {
  const platform = resolvePlatform(options.platform)
  const homeDir = options.homeDir ?? homedir()
  const localAppData = options.localAppData ?? defaultLocalAppData(homeDir)
  const pathEnv = options.pathEnv ?? process.env.PATH ?? ''
  const executablePath = options.executablePath ?? process.execPath
  const appPath = options.appPath ?? null
  const binDirs = options.preferredBinDirs ?? defaultBinDirs(platform, homeDir, localAppData)

  return { platform, homeDir, executablePath, appPath, localAppData, pathEnv, binDirs }
}

function commandFilename(platform: TerminalCommandPlatform): string {
  return platform === 'win32' ? `${COMMAND_NAME}.cmd` : COMMAND_NAME
}

function escapeDoubleQuoted(value: string): string {
  return value.replace(/(["\\$`])/g, '\\$1')
}

function renderShim(
  platform: TerminalCommandPlatform,
  executablePath: string,
  appPath: string | null
): string {
  if (platform === 'win32') {
    const appPathArg = appPath ? ` "${appPath}"` : ''
    return [
      '@echo off',
      `@rem ${SHIM_MARKER}`,
      `"${executablePath}"${appPathArg} --cli %*`,
      ''
    ].join('\r\n')
  }

  const appPathArg = appPath ? ` "${escapeDoubleQuoted(appPath)}"` : ''
  const headlessArgs = platform === 'linux' ? ` ${LINUX_HEADLESS_SWITCHES}` : ''
  return [
    '#!/bin/sh',
    `# ${SHIM_MARKER}`,
    `exec "${escapeDoubleQuoted(executablePath)}"${appPathArg}${headlessArgs} --cli "$@"`,
    ''
  ].join('\n')
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

function ownedShimError(path: string): Error {
  return new Error(`${path} already exists and was not created by memrynote`)
}

function readShimFile(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, constants.O_RDONLY | noFollowFlag())
    if (!fstatSync(fd).isFile()) return null
    return readFileSync(fd, 'utf8')
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ELOOP')) return null
    throw error
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return false
    throw error
  }
}

function isCurrentMemryShim(path: string, expectedShim: string): boolean {
  return readShimFile(path) === expectedShim
}

function writeOwnedShim(path: string, content: string, platform: TerminalCommandPlatform): void {
  let fd: number | null = null
  try {
    try {
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        SHIM_MODE
      )
    } catch (error) {
      if (isNodeErrorCode(error, 'ELOOP')) throw ownedShimError(path)
      if (!isNodeErrorCode(error, 'EEXIST')) throw error
      fd = openSync(path, constants.O_RDWR | noFollowFlag())
      if (!fstatSync(fd).isFile()) throw ownedShimError(path)
      if (!readFileSync(fd, 'utf8').includes(SHIM_MARKER)) throw ownedShimError(path)
      ftruncateSync(fd, 0)
    }

    writeSync(fd, content, 0, 'utf8')
    if (platform !== 'win32') fchmodSync(fd, SHIM_MODE)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function removeOwnedShim(path: string): void {
  const content = readShimFile(path)
  if (content === null) {
    if (pathExists(path)) throw ownedShimError(path)
    return
  }
  if (!content.includes(SHIM_MARKER)) throw ownedShimError(path)
  rmSync(path)
}

async function resolveStatus(
  options: RequiredTerminalCommandOptions
): Promise<TerminalCommandStatus> {
  const binDir = await chooseBinDir(options)
  const shimPath = join(binDir, commandFilename(options.platform))
  const inPath = pathContainsDir(options.pathEnv, binDir, options.platform)
  const expectedShim = renderShim(options.platform, options.executablePath, options.appPath)

  return {
    supported: true,
    installed: isCurrentMemryShim(shimPath, expectedShim),
    command: COMMAND_NAME,
    platform: options.platform,
    shimPath,
    binDir,
    targetPath: options.executablePath,
    inPath,
    pathHint: inPath ? null : `Add ${binDir} to PATH, then reopen your terminal.`
  }
}

export async function getTerminalCommandStatus(
  options: TerminalCommandOptions = {}
): Promise<TerminalCommandStatus> {
  return resolveStatus(normalizeOptions(options))
}

export async function installTerminalCommand(
  options: TerminalCommandOptions = {}
): Promise<TerminalCommandStatus> {
  const resolved = normalizeOptions(options)
  const status = await resolveStatus(resolved)

  mkdirSync(status.binDir, { recursive: true })
  writeOwnedShim(
    status.shimPath,
    renderShim(status.platform, status.targetPath, resolved.appPath),
    status.platform
  )

  return getTerminalCommandStatus(options)
}

export async function uninstallTerminalCommand(
  options: TerminalCommandOptions = {}
): Promise<TerminalCommandStatus> {
  const status = await getTerminalCommandStatus(options)
  removeOwnedShim(status.shimPath)

  return getTerminalCommandStatus(options)
}
