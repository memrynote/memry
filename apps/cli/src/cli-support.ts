import type { MemryApp, createMemryApp as defaultCreateMemryApp } from './app-core/memry-app.ts'

export interface CliIo {
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

export interface CliKnownVault {
  path: string
  name: string
  isDefault?: boolean
  lastOpened?: string
}

export interface CliVaultRegistry {
  listVaults(): Promise<CliKnownVault[]> | CliKnownVault[]
  getDefaultVaultPath(): Promise<string | null> | string | null
  setDefaultVaultPath(reference: string): Promise<CliKnownVault> | CliKnownVault
  /** Unregisters a vault from the known list. Never touches its files. */
  removeVault?(reference: string): Promise<CliKnownVault> | CliKnownVault
}

export interface CliRuntimeDeps {
  createApp?: typeof defaultCreateMemryApp
  vaultRegistry?: CliVaultRegistry
}

export interface ParsedCli {
  vaultPath: string | null
  json: boolean
  command: string | null
  subcommand: string | null
  positionals: string[]
  flags: Map<string, string[]>
}

export type TaskListOptions = NonNullable<Parameters<MemryApp['tasks']['list']>[0]>
export type PdfExportOptions = NonNullable<Parameters<MemryApp['exportPdf']>[2]>
export type CalendarSourceListOptions = NonNullable<
  Parameters<MemryApp['calendar']['sources']['list']>[0]
>
export type CalendarBindingListOptions = NonNullable<
  Parameters<MemryApp['calendar']['bindings']['list']>[0]
>
export type AgentBackend = Parameters<MemryApp['agent']['backendModels']>[0]
export type AgentLocalProviderSettingsInput = Parameters<
  MemryApp['agent']['setLocalProviderSettings']
>[0]

export function getFlag(flags: Map<string, string[]>, key: string): string | undefined {
  return flags.get(key)?.at(-1)
}

export function getFlagList(flags: Map<string, string[]>, key: string): string[] {
  return flags.get(key) ?? []
}

export function hasFlag(flags: Map<string, string[]>, key: string): boolean {
  return flags.has(key)
}

export function parseCli(args: string[]): ParsedCli {
  const globals: string[] = []
  let vaultPath: string | null = null
  let json = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--vault') {
      vaultPath = args[index + 1] ?? null
      index += 1
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    globals.push(arg)
  }

  const command = globals.shift() ?? null
  const subcommand = globals.shift() ?? null
  const positionals: string[] = []
  const flags = new Map<string, string[]>()

  for (let index = 0; index < globals.length; index += 1) {
    const arg = globals[index]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }

    const key = arg.slice(2)
    const next = globals[index + 1]
    const value = next && !next.startsWith('--') ? next : 'true'
    if (value !== 'true') index += 1
    flags.set(key, [...(flags.get(key) ?? []), value])
  }

  return { vaultPath, json, command, subcommand, positionals, flags }
}

export function print(io: CliIo, json: boolean, value: unknown): void {
  const line = json ? JSON.stringify(value) : formatHuman(value)
  io.stdout?.(line)
}

export async function requireVaultRegistry(
  registry: CliVaultRegistry | undefined
): Promise<CliVaultRegistry> {
  if (!registry) {
    throw new Error(
      'No CLI vault registry is available. Pass --vault <path> or run Memry from the desktop app command.'
    )
  }
  return registry
}

export async function listKnownVaults(
  registry: CliVaultRegistry | undefined
): Promise<CliKnownVault[]> {
  return await (await requireVaultRegistry(registry)).listVaults()
}

export async function resolveDefaultVaultPath(
  registry: CliVaultRegistry | undefined
): Promise<string> {
  const resolvedRegistry = await requireVaultRegistry(registry)
  const defaultPath = await resolvedRegistry.getDefaultVaultPath()
  if (defaultPath) return defaultPath

  const vaults = await resolvedRegistry.listVaults()
  if (vaults.length === 1) return vaults[0].path

  if (vaults.length > 1) {
    throw new Error(
      'Multiple vaults found. Choose one with `memrynote vault use <vault-name-or-path>` or run with --vault <path>.'
    )
  }

  throw new Error(
    'No default vault configured. Open Memry and choose Settings > Command Line > Default vault, or run with --vault <path>.'
  )
}

export function formatHuman(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

export function requireFirst(positionals: string[], label: string): string {
  const value = positionals[0]
  if (!value) throw new Error(`Missing ${label}`)
  return value
}

export function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`)
  return parsed
}

export function parseCliValue(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (value !== '' && Number.isFinite(Number(value))) return Number(value)
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function parseJsonFlag(flags: Map<string, string[]>, key: string): unknown {
  if (!flags.has(key)) return undefined
  return parseCliValue(getFlag(flags, key) ?? '')
}

export function parseObjectValue(
  value: string | undefined,
  label: string
): Record<string, unknown> {
  const parsed = parseCliValue(value ?? '')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

export function parseJsonStringFlag(flags: Map<string, string[]>, key: string): string | undefined {
  if (!flags.has(key)) return undefined
  return JSON.stringify(parseCliValue(getFlag(flags, key) ?? ''))
}

export function parseBooleanFlag(flags: Map<string, string[]>, key: string): boolean | undefined {
  if (!flags.has(key)) return undefined
  const value = parseCliValue(getFlag(flags, key) ?? 'true')
  if (typeof value !== 'boolean') throw new Error(`Invalid boolean: --${key}`)
  return value
}

export function parseReminderStatus(value: string | undefined) {
  if (!value) return undefined
  if (!['pending', 'triggered', 'dismissed', 'snoozed'].includes(value)) {
    throw new Error(`Invalid reminder status: ${value}`)
  }
  return value as 'pending' | 'triggered' | 'dismissed' | 'snoozed'
}

export function parseReminderTargetType(value: string | undefined) {
  if (!value || !['note', 'journal', 'highlight', 'task', 'note_date'].includes(value)) {
    throw new Error('Reminder target type must be note, journal, highlight, task, or note_date')
  }
  return value as 'note' | 'journal' | 'highlight' | 'task' | 'note_date'
}

export function parseSearchItemType(value: string | undefined) {
  if (!value || !['note', 'journal', 'task', 'inbox'].includes(value)) {
    throw new Error('Search reason item type must be note, journal, task, or inbox')
  }
  return value as 'note' | 'journal' | 'task' | 'inbox'
}

export function parseNullableFlag(
  flags: Map<string, string[]>,
  key: string
): string | null | undefined {
  if (!flags.has(key)) return undefined
  const value = getFlag(flags, key)
  return value === 'null' ? null : (value ?? null)
}

export function parsePositionFlags(flags: Map<string, string[]>): number[] {
  return getFlagList(flags, 'position').map((value) => parseNumber(value, 0))
}
