import {
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'

export type TerminalCommandPlatform = 'darwin' | 'linux' | 'win32'

export interface TerminalCommandStatus {
  supported: boolean
  installed: boolean
  command: 'memry'
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
  localAppData?: string
  pathEnv?: string
  preferredBinDirs?: string[]
}

const COMMAND_NAME = 'memry'
const SHIM_MARKER = 'Memry terminal command shim'

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
  const binDirs = options.preferredBinDirs ?? defaultBinDirs(platform, homeDir, localAppData)

  return { platform, homeDir, executablePath, localAppData, pathEnv, binDirs }
}

function commandFilename(platform: TerminalCommandPlatform): string {
  return platform === 'win32' ? `${COMMAND_NAME}.cmd` : COMMAND_NAME
}

function escapeDoubleQuoted(value: string): string {
  return value.replace(/(["\\$`])/g, '\\$1')
}

function renderShim(platform: TerminalCommandPlatform, executablePath: string): string {
  if (platform === 'win32') {
    return ['@echo off', `@rem ${SHIM_MARKER}`, `"${executablePath}" --cli %*`, ''].join('\r\n')
  }

  return [
    '#!/bin/sh',
    `# ${SHIM_MARKER}`,
    `exec "${escapeDoubleQuoted(executablePath)}" --cli "$@"`,
    ''
  ].join('\n')
}

function isMemryShim(path: string): boolean {
  if (!existsSync(path)) return false
  return readFileSync(path, 'utf8').includes(SHIM_MARKER)
}

async function resolveStatus(
  options: RequiredTerminalCommandOptions
): Promise<TerminalCommandStatus> {
  const binDir = await chooseBinDir(options)
  const shimPath = join(binDir, commandFilename(options.platform))
  const inPath = pathContainsDir(options.pathEnv, binDir, options.platform)

  return {
    supported: true,
    installed: isMemryShim(shimPath),
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

  if (existsSync(status.shimPath) && !isMemryShim(status.shimPath)) {
    throw new Error(`${status.shimPath} already exists and was not created by Memry`)
  }

  mkdirSync(status.binDir, { recursive: true })
  writeFileSync(status.shimPath, renderShim(status.platform, status.targetPath), 'utf8')
  if (status.platform !== 'win32') {
    await access(status.shimPath, constants.R_OK)
    chmodExecutable(status.shimPath)
  }

  return getTerminalCommandStatus(options)
}

export async function uninstallTerminalCommand(
  options: TerminalCommandOptions = {}
): Promise<TerminalCommandStatus> {
  const status = await getTerminalCommandStatus(options)
  if (existsSync(status.shimPath)) {
    if (!isMemryShim(status.shimPath)) {
      throw new Error(`${status.shimPath} already exists and was not created by Memry`)
    }
    rmSync(status.shimPath)
  }

  return getTerminalCommandStatus(options)
}

function chmodExecutable(path: string): void {
  chmodSync(path, 0o755)
}
