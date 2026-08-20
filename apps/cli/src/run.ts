// When you add or rename a subcommand/flag in this file, update
// apps/docs/src/user-guide/cli-reference.md to match.

import { createMemryApp as defaultCreateMemryApp, type MemryApp } from '@memry/app-core'

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
}

export interface CliRuntimeDeps {
  createApp?: typeof defaultCreateMemryApp
  vaultRegistry?: CliVaultRegistry
}

interface ParsedCli {
  vaultPath: string | null
  json: boolean
  command: string | null
  subcommand: string | null
  positionals: string[]
  flags: Map<string, string[]>
}

type TaskListOptions = NonNullable<Parameters<MemryApp['tasks']['list']>[0]>
type PdfExportOptions = NonNullable<Parameters<MemryApp['exportPdf']>[2]>
type CalendarSourceListOptions = NonNullable<Parameters<MemryApp['calendar']['sources']['list']>[0]>
type CalendarBindingListOptions = NonNullable<
  Parameters<MemryApp['calendar']['bindings']['list']>[0]
>
type AgentBackend = Parameters<MemryApp['agent']['backendModels']>[0]
type AgentLocalProviderSettingsInput = Parameters<MemryApp['agent']['setLocalProviderSettings']>[0]

function getFlag(flags: Map<string, string[]>, key: string): string | undefined {
  return flags.get(key)?.at(-1)
}

function getFlagList(flags: Map<string, string[]>, key: string): string[] {
  return flags.get(key) ?? []
}

function hasFlag(flags: Map<string, string[]>, key: string): boolean {
  return flags.has(key)
}

function parseCli(args: string[]): ParsedCli {
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

function print(io: CliIo, json: boolean, value: unknown): void {
  const line = json ? JSON.stringify(value) : formatHuman(value)
  io.stdout?.(line)
}

async function requireVaultRegistry(
  registry: CliVaultRegistry | undefined
): Promise<CliVaultRegistry> {
  if (!registry) {
    throw new Error(
      'No CLI vault registry is available. Pass --vault <path> or run Memry from the desktop app command.'
    )
  }
  return registry
}

async function listKnownVaults(registry: CliVaultRegistry | undefined): Promise<CliKnownVault[]> {
  return await (await requireVaultRegistry(registry)).listVaults()
}

async function resolveDefaultVaultPath(registry: CliVaultRegistry | undefined): Promise<string> {
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

function formatHuman(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

function requireFirst(positionals: string[], label: string): string {
  const value = positionals[0]
  if (!value) throw new Error(`Missing ${label}`)
  return value
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`)
  return parsed
}

function parseCliValue(value: string): unknown {
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

function parseJsonFlag(flags: Map<string, string[]>, key: string): unknown | undefined {
  if (!flags.has(key)) return undefined
  return parseCliValue(getFlag(flags, key) ?? '')
}

function parseObjectValue(value: string | undefined, label: string): Record<string, unknown> {
  const parsed = parseCliValue(value ?? '')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function parseJsonStringFlag(flags: Map<string, string[]>, key: string): string | undefined {
  if (!flags.has(key)) return undefined
  return JSON.stringify(parseCliValue(getFlag(flags, key) ?? ''))
}

function parseBooleanFlag(flags: Map<string, string[]>, key: string): boolean | undefined {
  if (!flags.has(key)) return undefined
  const value = parseCliValue(getFlag(flags, key) ?? 'true')
  if (typeof value !== 'boolean') throw new Error(`Invalid boolean: --${key}`)
  return value
}

function parseReminderStatus(value: string | undefined) {
  if (!value) return undefined
  if (!['pending', 'triggered', 'dismissed', 'snoozed'].includes(value)) {
    throw new Error(`Invalid reminder status: ${value}`)
  }
  return value as 'pending' | 'triggered' | 'dismissed' | 'snoozed'
}

function parseReminderTargetType(value: string | undefined) {
  if (!value || !['note', 'journal', 'highlight', 'task', 'note_date'].includes(value)) {
    throw new Error('Reminder target type must be note, journal, highlight, task, or note_date')
  }
  return value as 'note' | 'journal' | 'highlight' | 'task' | 'note_date'
}

function parseSearchItemType(value: string | undefined) {
  if (!value || !['note', 'journal', 'task', 'inbox'].includes(value)) {
    throw new Error('Search reason item type must be note, journal, task, or inbox')
  }
  return value as 'note' | 'journal' | 'task' | 'inbox'
}

function parseNullableFlag(flags: Map<string, string[]>, key: string): string | null | undefined {
  if (!flags.has(key)) return undefined
  const value = getFlag(flags, key)
  return value === 'null' ? null : (value ?? null)
}

function parsePositionFlags(flags: Map<string, string[]>): number[] {
  return getFlagList(flags, 'position').map((value) => parseNumber(value, 0))
}

async function runVault(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'init':
    case 'status':
    case 'open':
      print(io, parsed.json, app.vault.status())
      return
    case 'config':
      print(io, parsed.json, app.vault.config())
      return
    case 'update-config':
      print(
        io,
        parsed.json,
        await app.vault.updateConfig(
          parseObjectValue(parsed.positionals[0], 'vault config') as Partial<
            ReturnType<typeof app.vault.config>
          >
        )
      )
      return
    default:
      throw new Error(
        'Usage: memrynote vault list|current|use OR memrynote [--vault <path>] vault init|status|config|update-config'
      )
  }
}

async function runVaultRegistryCommand(
  parsed: ParsedCli,
  io: CliIo,
  registry: CliVaultRegistry | undefined
): Promise<boolean> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await listKnownVaults(registry))
      return true
    case 'current': {
      const path = parsed.vaultPath ?? (await resolveDefaultVaultPath(registry))
      const vault = (await listKnownVaults(registry)).find((item) => item.path === path)
      print(io, parsed.json, vault ?? { path })
      return true
    }
    case 'use': {
      const reference = parsed.positionals[0] ?? parsed.vaultPath
      if (!reference) throw new Error('Usage: memrynote vault use <vault-name-or-path>')
      const vault = await (await requireVaultRegistry(registry)).setDefaultVaultPath(reference)
      print(io, parsed.json, vault)
      return true
    }
    default:
      return false
  }
}

async function runNotes(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'create':
      print(
        io,
        parsed.json,
        await app.notes.create({
          title: requireFirst(parsed.positionals, 'note title'),
          content: getFlag(parsed.flags, 'content') ?? '',
          folder: getFlag(parsed.flags, 'folder'),
          tags: getFlagList(parsed.flags, 'tag'),
          properties: parsed.flags.has('properties')
            ? parseObjectValue(getFlag(parsed.flags, 'properties'), 'note properties')
            : undefined
        })
      )
      return
    case 'list':
      print(
        io,
        parsed.json,
        await app.notes.list({
          folder: getFlag(parsed.flags, 'folder'),
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 100)
        })
      )
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.notes.get(requireFirst(parsed.positionals, 'note id or path'))
      )
      return
    case 'exists':
      print(io, parsed.json, {
        exists: await app.notes.exists(requireFirst(parsed.positionals, 'note id or path'))
      })
      return
    case 'preview':
      print(
        io,
        parsed.json,
        await app.notes.previewByTitle(requireFirst(parsed.positionals, 'note title'))
      )
      return
    case 'resolve':
      // Heading-aware on purpose: `[[Meeting#Decisions]]` is a link somebody
      // can paste here, and it must reach `Meeting` (#1557).
      print(
        io,
        parsed.json,
        await app.notes.resolveWikiTarget(requireFirst(parsed.positionals, 'note title'))
      )
      return
    case 'links':
      print(
        io,
        parsed.json,
        await app.notes.getLinks(requireFirst(parsed.positionals, 'note id or path'))
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.notes.update({
          id: requireFirst(parsed.positionals, 'note id or path'),
          title: getFlag(parsed.flags, 'title'),
          content: getFlag(parsed.flags, 'content'),
          append: getFlag(parsed.flags, 'append'),
          tags: parsed.flags.has('tag') ? getFlagList(parsed.flags, 'tag') : undefined,
          properties: parsed.flags.has('properties')
            ? parseObjectValue(getFlag(parsed.flags, 'properties'), 'note properties')
            : undefined
        })
      )
      return
    case 'rename':
      print(
        io,
        parsed.json,
        await app.notes.rename(
          requireFirst(parsed.positionals, 'note id or path'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'move':
      print(
        io,
        parsed.json,
        await app.notes.move(
          requireFirst(parsed.positionals, 'note id or path'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'set-local-only': {
      const localOnly = parseCliValue(parsed.positionals[1] ?? 'true')
      if (typeof localOnly !== 'boolean') throw new Error('localOnly must be true or false')
      print(
        io,
        parsed.json,
        await app.notes.setLocalOnly(requireFirst(parsed.positionals, 'note id or path'), localOnly)
      )
      return
    }
    case 'local-only-count':
      print(io, parsed.json, await app.notes.localOnlyCount())
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a note')
      print(io, parsed.json, {
        success: await app.notes.delete(requireFirst(parsed.positionals, 'note id or path'))
      })
      return
    case 'attach':
      print(
        io,
        parsed.json,
        await app.attachments.add(
          requireFirst(parsed.positionals, 'note id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'attachments':
      print(
        io,
        parsed.json,
        await app.attachments.list(requireFirst(parsed.positionals, 'note id'))
      )
      return
    case 'delete-attachment':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete an attachment')
      print(io, parsed.json, {
        success: await app.attachments.delete(
          requireFirst(parsed.positionals, 'note id'),
          parsed.positionals[1] ?? ''
        )
      })
      return
    case 'import-files':
      print(
        io,
        parsed.json,
        await app.importFiles({
          sourcePaths: parsed.positionals,
          targetFolder: getFlag(parsed.flags, 'folder')
        })
      )
      return
    case 'export-html':
      print(
        io,
        parsed.json,
        await app.exportHtml(
          requireFirst(parsed.positionals, 'note id'),
          parsed.positionals[1] ?? '',
          {
            includeMetadata: hasFlag(parsed.flags, 'no-metadata')
              ? false
              : (parseBooleanFlag(parsed.flags, 'include-metadata') ?? true)
          }
        )
      )
      return
    case 'export-pdf':
      print(
        io,
        parsed.json,
        await app.exportPdf(
          requireFirst(parsed.positionals, 'note id'),
          parsed.positionals[1] ?? '',
          {
            includeMetadata: hasFlag(parsed.flags, 'no-metadata')
              ? false
              : (parseBooleanFlag(parsed.flags, 'include-metadata') ?? true),
            pageSize: getFlag(parsed.flags, 'page-size') as PdfExportOptions['pageSize']
          }
        )
      )
      return
    case 'export-markdown':
      print(
        io,
        parsed.json,
        await app.exportMarkdown(
          requireFirst(parsed.positionals, 'note id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'snapshot':
      print(
        io,
        parsed.json,
        await app.versions.create(
          requireFirst(parsed.positionals, 'note id'),
          (getFlag(parsed.flags, 'reason') ?? 'manual') as Parameters<
            typeof app.versions.create
          >[1],
          hasFlag(parsed.flags, 'force')
        )
      )
      return
    case 'versions':
      print(
        io,
        parsed.json,
        await app.versions.history(
          requireFirst(parsed.positionals, 'note id'),
          parseNumber(getFlag(parsed.flags, 'limit'), 50)
        )
      )
      return
    case 'version':
      print(
        io,
        parsed.json,
        await app.versions.get(requireFirst(parsed.positionals, 'snapshot id'))
      )
      return
    case 'restore-version':
      print(
        io,
        parsed.json,
        await app.versions.restore(requireFirst(parsed.positionals, 'snapshot id'))
      )
      return
    case 'delete-version':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a snapshot')
      print(io, parsed.json, {
        success: await app.versions.delete(requireFirst(parsed.positionals, 'snapshot id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] notes create|list|get|exists|preview|resolve|links|update|rename|move|set-local-only|local-only-count|delete|attach|attachments|delete-attachment|import-files|export-html|export-pdf|export-markdown|snapshot|versions|version|restore-version|delete-version'
      )
  }
}

async function runFolders(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.folders.list())
      return
    case 'create':
      print(
        io,
        parsed.json,
        await app.folders.create(requireFirst(parsed.positionals, 'folder path'))
      )
      return
    case 'rename':
      print(
        io,
        parsed.json,
        await app.folders.rename(
          requireFirst(parsed.positionals, 'old folder path'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a folder')
      print(io, parsed.json, {
        success: await app.folders.delete(requireFirst(parsed.positionals, 'folder path'))
      })
      return
    default:
      throw new Error('Usage: memrynote [--vault <path>] folders list|create|rename|delete')
  }
}

async function runProperties(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'get':
      print(
        io,
        parsed.json,
        await app.properties.get(requireFirst(parsed.positionals, 'entity id'))
      )
      return
    case 'set':
      print(
        io,
        parsed.json,
        await app.properties.set(
          requireFirst(parsed.positionals, 'entity id'),
          parseObjectValue(parsed.positionals[1], 'properties')
        )
      )
      return
    case 'rename':
      print(
        io,
        parsed.json,
        await app.properties.rename(
          requireFirst(parsed.positionals, 'entity id'),
          parsed.positionals[1] ?? '',
          parsed.positionals[2] ?? ''
        )
      )
      return
    case 'definitions':
      print(io, parsed.json, await app.properties.definitions())
      return
    case 'define':
      print(
        io,
        parsed.json,
        await app.properties.createDefinition({
          name: requireFirst(parsed.positionals, 'property name'),
          type: parsed.positionals[1] ?? '',
          options: parseJsonStringFlag(parsed.flags, 'options'),
          defaultValue: parseJsonStringFlag(parsed.flags, 'default'),
          color: getFlag(parsed.flags, 'color') ?? null
        })
      )
      return
    case 'update-definition':
      print(
        io,
        parsed.json,
        await app.properties.updateDefinition(requireFirst(parsed.positionals, 'property name'), {
          type: getFlag(parsed.flags, 'type'),
          options: parseJsonStringFlag(parsed.flags, 'options'),
          defaultValue: parseJsonStringFlag(parsed.flags, 'default'),
          color: getFlag(parsed.flags, 'color') ?? undefined
        })
      )
      return
    case 'delete-definition':
      if (!hasFlag(parsed.flags, 'yes')) {
        throw new Error('Pass --yes to delete a property definition')
      }
      print(io, parsed.json, {
        success: await app.properties.deleteDefinition(
          requireFirst(parsed.positionals, 'property name')
        )
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] properties get|set|rename|definitions|define|update-definition|delete-definition'
      )
  }
}

async function runFolderView(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'config':
      print(
        io,
        parsed.json,
        await app.folderView.getConfig(requireFirst(parsed.positionals, 'folder path'))
      )
      return
    case 'set-config':
      print(
        io,
        parsed.json,
        await app.folderView.setConfig(
          requireFirst(parsed.positionals, 'folder path'),
          parseObjectValue(parsed.positionals[1], 'folder view config')
        )
      )
      return
    case 'views':
      print(
        io,
        parsed.json,
        await app.folderView.getViews(requireFirst(parsed.positionals, 'folder path'))
      )
      return
    case 'set-view':
      print(
        io,
        parsed.json,
        await app.folderView.setView(
          requireFirst(parsed.positionals, 'folder path'),
          parseObjectValue(parsed.positionals[1], 'folder view') as unknown as Parameters<
            typeof app.folderView.setView
          >[1]
        )
      )
      return
    case 'delete-view':
      print(
        io,
        parsed.json,
        await app.folderView.deleteView(
          requireFirst(parsed.positionals, 'folder path'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'list':
      print(
        io,
        parsed.json,
        await app.folderView.listWithProperties({
          folderPath: requireFirst(parsed.positionals, 'folder path'),
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 100),
          offset: parseNumber(getFlag(parsed.flags, 'offset'), 0)
        })
      )
      return
    case 'properties':
      print(
        io,
        parsed.json,
        await app.folderView.getAvailableProperties(requireFirst(parsed.positionals, 'folder path'))
      )
      return
    case 'suggestions':
      print(
        io,
        parsed.json,
        await app.folderView.getFolderSuggestions(requireFirst(parsed.positionals, 'note id'))
      )
      return
    case 'exists':
      print(io, parsed.json, {
        exists: await app.folderView.exists(requireFirst(parsed.positionals, 'folder path'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] folder-view config|set-config|views|set-view|delete-view|list|properties|suggestions|exists'
      )
  }
}

async function runTasks(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'create':
      print(
        io,
        parsed.json,
        await app.tasks.create({
          title: requireFirst(parsed.positionals, 'task title'),
          description: getFlag(parsed.flags, 'description'),
          projectId: getFlag(parsed.flags, 'project') ?? undefined,
          statusId: parseNullableFlag(parsed.flags, 'status'),
          parentId: parseNullableFlag(parsed.flags, 'parent'),
          dueDate: getFlag(parsed.flags, 'due') ?? null,
          dueTime: getFlag(parsed.flags, 'due-time') ?? null,
          startDate: getFlag(parsed.flags, 'start') ?? null,
          repeatConfig: parsed.flags.has('repeat')
            ? parseCliValue(getFlag(parsed.flags, 'repeat') ?? 'null')
            : undefined,
          repeatFrom: parseNullableFlag(parsed.flags, 'repeat-from'),
          sourceNoteId: parseNullableFlag(parsed.flags, 'source-note'),
          priority: parseNumber(getFlag(parsed.flags, 'priority'), 0),
          tags: getFlagList(parsed.flags, 'tag'),
          linkedNoteIds: getFlagList(parsed.flags, 'link-note')
        })
      )
      return
    case 'list':
      print(
        io,
        parsed.json,
        await app.tasks.list({
          includeCompleted: hasFlag(parsed.flags, 'completed'),
          includeArchived: hasFlag(parsed.flags, 'archived'),
          projectId: getFlag(parsed.flags, 'project'),
          statusId: parseNullableFlag(parsed.flags, 'status'),
          parentId: parseNullableFlag(parsed.flags, 'parent'),
          dueBefore: getFlag(parsed.flags, 'due-before'),
          dueAfter: getFlag(parsed.flags, 'due-after'),
          tags: getFlagList(parsed.flags, 'tag'),
          search: getFlag(parsed.flags, 'search'),
          sortBy: getFlag(parsed.flags, 'sort-by') as TaskListOptions['sortBy'],
          sortOrder: getFlag(parsed.flags, 'sort-order') as TaskListOptions['sortOrder'],
          limit: parsed.flags.has('limit')
            ? parseNumber(getFlag(parsed.flags, 'limit'), 100)
            : undefined,
          offset: parsed.flags.has('offset')
            ? parseNumber(getFlag(parsed.flags, 'offset'), 0)
            : undefined
        })
      )
      return
    case 'get':
      print(io, parsed.json, await app.tasks.get(requireFirst(parsed.positionals, 'task id')))
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.tasks.update(requireFirst(parsed.positionals, 'task id'), {
          title: getFlag(parsed.flags, 'title'),
          description: getFlag(parsed.flags, 'description'),
          projectId: getFlag(parsed.flags, 'project') ?? undefined,
          statusId: parseNullableFlag(parsed.flags, 'status'),
          parentId: parseNullableFlag(parsed.flags, 'parent'),
          dueDate: getFlag(parsed.flags, 'due') ?? undefined,
          dueTime: getFlag(parsed.flags, 'due-time') ?? undefined,
          startDate: getFlag(parsed.flags, 'start') ?? undefined,
          repeatConfig: parsed.flags.has('repeat')
            ? parseCliValue(getFlag(parsed.flags, 'repeat') ?? 'null')
            : undefined,
          repeatFrom: parseNullableFlag(parsed.flags, 'repeat-from'),
          sourceNoteId: parseNullableFlag(parsed.flags, 'source-note'),
          priority: parsed.flags.has('priority')
            ? parseNumber(getFlag(parsed.flags, 'priority'), 0)
            : undefined,
          tags: parsed.flags.has('tag') ? getFlagList(parsed.flags, 'tag') : undefined,
          linkedNoteIds: parsed.flags.has('link-note')
            ? getFlagList(parsed.flags, 'link-note')
            : undefined
        })
      )
      return
    case 'done':
    case 'complete':
      print(io, parsed.json, await app.tasks.complete(requireFirst(parsed.positionals, 'task id')))
      return
    case 'reopen':
      print(io, parsed.json, await app.tasks.reopen(requireFirst(parsed.positionals, 'task id')))
      return
    case 'archive':
      print(io, parsed.json, await app.tasks.archive(requireFirst(parsed.positionals, 'task id')))
      return
    case 'unarchive':
      print(io, parsed.json, await app.tasks.unarchive(requireFirst(parsed.positionals, 'task id')))
      return
    case 'move':
      print(
        io,
        parsed.json,
        await app.tasks.move(requireFirst(parsed.positionals, 'task id'), {
          projectId: getFlag(parsed.flags, 'project'),
          statusId: parseNullableFlag(parsed.flags, 'status'),
          parentId: parseNullableFlag(parsed.flags, 'parent'),
          position: parsed.flags.has('position')
            ? parseNumber(getFlag(parsed.flags, 'position'), 0)
            : undefined
        })
      )
      return
    case 'get-subtasks':
      print(
        io,
        parsed.json,
        await app.tasks.getSubtasks(requireFirst(parsed.positionals, 'task id'))
      )
      return
    case 'get-linked-tasks':
      print(
        io,
        parsed.json,
        await app.tasks.getLinkedTasks(requireFirst(parsed.positionals, 'note id'))
      )
      return
    case 'today':
      print(io, parsed.json, await app.tasks.today(getFlag(parsed.flags, 'date')))
      return
    case 'upcoming':
      print(
        io,
        parsed.json,
        await app.tasks.upcoming({
          days: parsed.flags.has('days')
            ? parseNumber(getFlag(parsed.flags, 'days'), 7)
            : undefined,
          fromDate: getFlag(parsed.flags, 'from')
        })
      )
      return
    case 'overdue':
      print(io, parsed.json, await app.tasks.overdue(getFlag(parsed.flags, 'date')))
      return
    case 'stats':
      print(io, parsed.json, await app.tasks.stats(getFlag(parsed.flags, 'date')))
      return
    case 'tags':
      print(io, parsed.json, await app.tasks.getTags())
      return
    case 'convert-to-subtask':
      print(
        io,
        parsed.json,
        await app.tasks.convertToSubtask(
          requireFirst(parsed.positionals, 'task id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'convert-to-task':
      print(
        io,
        parsed.json,
        await app.tasks.convertToTask(requireFirst(parsed.positionals, 'task id'))
      )
      return
    case 'duplicate':
      print(io, parsed.json, await app.tasks.duplicate(requireFirst(parsed.positionals, 'task id')))
      return
    case 'bulk-done':
    case 'bulk-complete':
      print(io, parsed.json, { count: await app.tasks.bulkComplete(parsed.positionals) })
      return
    case 'bulk-archive':
      print(io, parsed.json, { count: await app.tasks.bulkArchive(parsed.positionals) })
      return
    case 'bulk-move': {
      const projectId = getFlag(parsed.flags, 'project')
      if (!projectId) throw new Error('Pass --project to bulk-move tasks')
      print(io, parsed.json, { count: await app.tasks.bulkMove(parsed.positionals, projectId) })
      return
    }
    case 'bulk-delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete tasks')
      print(io, parsed.json, { count: await app.tasks.bulkDelete(parsed.positionals) })
      return
    case 'reorder':
      print(io, parsed.json, {
        success: await app.tasks.reorder(parsed.positionals, parsePositionFlags(parsed.flags))
      })
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a task')
      print(io, parsed.json, {
        success: await app.tasks.delete(requireFirst(parsed.positionals, 'task id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] tasks create|list|get|update|done|reopen|archive|unarchive|move|get-subtasks|get-linked-tasks|today|upcoming|overdue|stats|tags|convert-to-subtask|convert-to-task|duplicate|bulk-done|bulk-archive|bulk-move|bulk-delete|reorder|delete'
      )
  }
}

async function runProjects(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.tasks.projects.list())
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.tasks.projects.get(requireFirst(parsed.positionals, 'project id'))
      )
      return
    case 'create':
      print(
        io,
        parsed.json,
        await app.tasks.projects.create({
          name: requireFirst(parsed.positionals, 'project name'),
          description: getFlag(parsed.flags, 'description'),
          color: getFlag(parsed.flags, 'color'),
          icon: getFlag(parsed.flags, 'icon') ?? null
        })
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.tasks.projects.update(requireFirst(parsed.positionals, 'project id'), {
          name: getFlag(parsed.flags, 'name'),
          description: getFlag(parsed.flags, 'description'),
          color: getFlag(parsed.flags, 'color'),
          icon: getFlag(parsed.flags, 'icon') ?? undefined
        })
      )
      return
    case 'archive':
      print(
        io,
        parsed.json,
        await app.tasks.projects.archive(requireFirst(parsed.positionals, 'project id'))
      )
      return
    case 'unarchive':
      print(
        io,
        parsed.json,
        await app.tasks.projects.unarchive(requireFirst(parsed.positionals, 'project id'))
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a project')
      print(io, parsed.json, {
        success: await app.tasks.projects.delete(requireFirst(parsed.positionals, 'project id'))
      })
      return
    case 'reorder':
      print(io, parsed.json, {
        success: await app.tasks.projects.reorder(
          parsed.positionals,
          parsePositionFlags(parsed.flags)
        )
      })
      return
    case 'statuses':
      print(
        io,
        parsed.json,
        await app.tasks.projects.statuses(requireFirst(parsed.positionals, 'project id'))
      )
      return
    case 'status-create':
      print(
        io,
        parsed.json,
        await app.tasks.projects.createStatus(requireFirst(parsed.positionals, 'project id'), {
          name: parsed.positionals[1] ?? '',
          color: getFlag(parsed.flags, 'color'),
          isDone: parseBooleanFlag(parsed.flags, 'done')
        })
      )
      return
    case 'status-update':
      print(
        io,
        parsed.json,
        await app.tasks.projects.updateStatus(requireFirst(parsed.positionals, 'status id'), {
          name: getFlag(parsed.flags, 'name'),
          color: getFlag(parsed.flags, 'color'),
          position: parsed.flags.has('position')
            ? parseNumber(getFlag(parsed.flags, 'position'), 0)
            : undefined,
          isDefault: parseBooleanFlag(parsed.flags, 'default'),
          isDone: parseBooleanFlag(parsed.flags, 'done')
        })
      )
      return
    case 'status-delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a status')
      print(io, parsed.json, {
        success: await app.tasks.projects.deleteStatus(
          requireFirst(parsed.positionals, 'status id')
        )
      })
      return
    case 'status-reorder':
      print(io, parsed.json, {
        success: await app.tasks.projects.reorderStatuses(
          parsed.positionals,
          parsePositionFlags(parsed.flags)
        )
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] projects list|get|create|update|archive|unarchive|delete|reorder|statuses|status-create|status-update|status-delete|status-reorder'
      )
  }
}

async function runInbox(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'capture':
      print(
        io,
        parsed.json,
        await app.inbox.captureText({
          title: getFlag(parsed.flags, 'title'),
          content: requireFirst(parsed.positionals, 'inbox content'),
          tags: getFlagList(parsed.flags, 'tag')
        })
      )
      return
    case 'capture-link':
      print(
        io,
        parsed.json,
        await app.inbox.captureLink({
          url: requireFirst(parsed.positionals, 'inbox URL'),
          tags: getFlagList(parsed.flags, 'tag')
        })
      )
      return
    case 'capture-file':
      print(
        io,
        parsed.json,
        await app.inbox.captureFile({
          filePath: requireFirst(parsed.positionals, 'inbox file path'),
          mimeType: getFlag(parsed.flags, 'mime'),
          title: getFlag(parsed.flags, 'title'),
          tags: getFlagList(parsed.flags, 'tag')
        })
      )
      return
    case 'get':
      print(io, parsed.json, await app.inbox.get(requireFirst(parsed.positionals, 'inbox item id')))
      return
    case 'list':
      print(
        io,
        parsed.json,
        await app.inbox.list({
          includeArchived: hasFlag(parsed.flags, 'archived'),
          includeSnoozed: hasFlag(parsed.flags, 'include-snoozed')
        })
      )
      return
    case 'tags':
      print(io, parsed.json, await app.inbox.tags())
      return
    case 'stats':
      print(io, parsed.json, await app.inbox.stats())
      return
    case 'patterns':
      print(io, parsed.json, await app.inbox.patterns())
      return
    case 'archived':
      print(
        io,
        parsed.json,
        await app.inbox.archived({
          search: getFlag(parsed.flags, 'search'),
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 50),
          offset: parseNumber(getFlag(parsed.flags, 'offset'), 0)
        })
      )
      return
    case 'filing-history':
      print(
        io,
        parsed.json,
        await app.inbox.filingHistory({
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 20)
        })
      )
      return
    case 'stale-threshold':
      print(io, parsed.json, await app.inbox.getStaleThreshold())
      return
    case 'set-stale-threshold':
      print(
        io,
        parsed.json,
        await app.inbox.setStaleThreshold(
          parseNumber(requireFirst(parsed.positionals, 'stale threshold days'), 7)
        )
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.inbox.update(requireFirst(parsed.positionals, 'inbox item id'), {
          title: getFlag(parsed.flags, 'title'),
          content: getFlag(parsed.flags, 'content')
        })
      )
      return
    case 'add-tag':
      print(
        io,
        parsed.json,
        await app.inbox.addTag(
          requireFirst(parsed.positionals, 'inbox item id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'remove-tag':
      print(
        io,
        parsed.json,
        await app.inbox.removeTag(
          requireFirst(parsed.positionals, 'inbox item id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'mark-viewed':
      print(
        io,
        parsed.json,
        await app.inbox.markViewed(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'convert-note':
      print(
        io,
        parsed.json,
        await app.inbox.convertToNote(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'convert-task':
      print(
        io,
        parsed.json,
        await app.inbox.convertToTask(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'link-note':
      print(
        io,
        parsed.json,
        await app.inbox.linkToNote(
          requireFirst(parsed.positionals, 'inbox item id'),
          parsed.positionals[1] ?? '',
          getFlagList(parsed.flags, 'tag')
        )
      )
      return
    case 'snooze':
      print(
        io,
        parsed.json,
        await app.inbox.snooze(
          requireFirst(parsed.positionals, 'inbox item id'),
          getFlag(parsed.flags, 'until') ?? '',
          getFlag(parsed.flags, 'reason')
        )
      )
      return
    case 'unsnooze':
      print(
        io,
        parsed.json,
        await app.inbox.unsnooze(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'snoozed':
      print(io, parsed.json, await app.inbox.snoozed())
      return
    case 'bulk-tag':
      print(
        io,
        parsed.json,
        await app.inbox.bulkTag(parsed.positionals, getFlagList(parsed.flags, 'tag'))
      )
      return
    case 'bulk-snooze':
      print(
        io,
        parsed.json,
        await app.inbox.bulkSnooze(
          parsed.positionals,
          getFlag(parsed.flags, 'until') ?? '',
          getFlag(parsed.flags, 'reason')
        )
      )
      return
    case 'bulk-archive':
      print(io, parsed.json, await app.inbox.bulkArchive(parsed.positionals))
      return
    case 'archive':
      print(
        io,
        parsed.json,
        await app.inbox.archive(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'unarchive':
      print(
        io,
        parsed.json,
        await app.inbox.unarchive(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete an inbox item')
      print(io, parsed.json, {
        success: await app.inbox.deletePermanent(requireFirst(parsed.positionals, 'inbox item id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] inbox capture|capture-link|capture-file|get|list|tags|stats|patterns|archived|filing-history|stale-threshold|set-stale-threshold|update|add-tag|remove-tag|mark-viewed|convert-note|convert-task|link-note|snooze|unsnooze|snoozed|bulk-tag|bulk-snooze|bulk-archive|archive|unarchive|delete'
      )
  }
}

async function runJournal(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'get':
      print(
        io,
        parsed.json,
        await app.journal.get(requireFirst(parsed.positionals, 'journal date'))
      )
      return
    case 'write':
      print(
        io,
        parsed.json,
        await app.journal.write(
          requireFirst(parsed.positionals, 'journal date'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'append':
      print(
        io,
        parsed.json,
        await app.journal.append(
          requireFirst(parsed.positionals, 'journal date'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a journal entry')
      print(io, parsed.json, {
        success: await app.journal.delete(requireFirst(parsed.positionals, 'journal date'))
      })
      return
    case 'month':
      print(
        io,
        parsed.json,
        await app.journal.month(
          parseNumber(requireFirst(parsed.positionals, 'journal year'), 0),
          parseNumber(parsed.positionals[1], 0)
        )
      )
      return
    case 'heatmap':
      print(
        io,
        parsed.json,
        await app.journal.heatmap(parseNumber(requireFirst(parsed.positionals, 'journal year'), 0))
      )
      return
    case 'stats':
      print(
        io,
        parsed.json,
        await app.journal.yearStats(
          parseNumber(requireFirst(parsed.positionals, 'journal year'), 0)
        )
      )
      return
    case 'context':
      print(
        io,
        parsed.json,
        await app.journal.dayContext(requireFirst(parsed.positionals, 'journal date'))
      )
      return
    case 'tags':
      print(io, parsed.json, await app.journal.allTags())
      return
    case 'streak':
      print(io, parsed.json, await app.journal.streak())
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] journal get|write|append|delete|month|heatmap|stats|context|tags|streak'
      )
  }
}

async function runTags(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.tags.list())
      return
    case 'notes':
      print(io, parsed.json, await app.tags.notes(requireFirst(parsed.positionals, 'tag name')))
      return
    case 'color':
    case 'set-color':
      print(
        io,
        parsed.json,
        await app.tags.setColor(
          requireFirst(parsed.positionals, 'tag name'),
          getFlag(parsed.flags, 'color') ?? parsed.positionals[1] ?? ''
        )
      )
      return
    case 'rename':
      print(
        io,
        parsed.json,
        await app.tags.rename(
          requireFirst(parsed.positionals, 'old tag name'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'remove-from-note':
      print(
        io,
        parsed.json,
        await app.tags.removeFromNote(
          requireFirst(parsed.positionals, 'note id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'merge':
      print(
        io,
        parsed.json,
        await app.tags.merge(
          requireFirst(parsed.positionals, 'source tag'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a tag')
      print(io, parsed.json, {
        success: await app.tags.delete(requireFirst(parsed.positionals, 'tag name'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] tags list|notes|color|rename|remove-from-note|merge|delete'
      )
  }
}

async function runSettings(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.settings.list())
      return
    case 'groups':
      print(io, parsed.json, await app.settings.groups())
      return
    case 'group':
      print(
        io,
        parsed.json,
        await app.settings.getGroup(requireFirst(parsed.positionals, 'group name'))
      )
      return
    case 'set-group':
      print(
        io,
        parsed.json,
        await app.settings.setGroup(
          requireFirst(parsed.positionals, 'group name'),
          parseObjectValue(parsed.positionals[1], 'settings group update')
        )
      )
      return
    case 'ai':
      print(io, parsed.json, await app.settings.ai())
      return
    case 'set-ai': {
      const enabled = parseCliValue(requireFirst(parsed.positionals, 'AI enabled value'))
      if (typeof enabled !== 'boolean') throw new Error('AI enabled value must be true or false')
      print(io, parsed.json, await app.settings.setAi({ enabled }))
      return
    }
    case 'get':
      print(
        io,
        parsed.json,
        await app.settings.get(requireFirst(parsed.positionals, 'setting key'))
      )
      return
    case 'set':
      print(
        io,
        parsed.json,
        await app.settings.set(
          requireFirst(parsed.positionals, 'setting key'),
          parseCliValue(parsed.positionals[1] ?? '')
        )
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a setting')
      print(io, parsed.json, {
        success: await app.settings.delete(requireFirst(parsed.positionals, 'setting key'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] settings list|groups|group|set-group|ai|set-ai|get|set|delete'
      )
  }
}

async function runLocale(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'get':
      print(io, parsed.json, await app.locale.get())
      return
    case 'set':
      print(io, parsed.json, await app.locale.set(requireFirst(parsed.positionals, 'locale code')))
      return
    case 'list':
      print(io, parsed.json, await app.locale.list())
      return
    default:
      throw new Error('Usage: memrynote [--vault <path>] locale get|set|list')
  }
}

async function runReminders(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'create':
      print(
        io,
        parsed.json,
        await app.reminders.create({
          targetType: parseReminderTargetType(parsed.positionals[0]),
          targetId: parsed.positionals[1] ?? '',
          remindAt: getFlag(parsed.flags, 'at') ?? '',
          title: getFlag(parsed.flags, 'title') ?? null,
          note: getFlag(parsed.flags, 'note') ?? null,
          highlightText: getFlag(parsed.flags, 'highlight-text') ?? null,
          highlightStart: parsed.flags.has('highlight-start')
            ? parseNumber(getFlag(parsed.flags, 'highlight-start'), 0)
            : null,
          highlightEnd: parsed.flags.has('highlight-end')
            ? parseNumber(getFlag(parsed.flags, 'highlight-end'), 0)
            : null
        })
      )
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.reminders.get(requireFirst(parsed.positionals, 'reminder id'))
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.reminders.update({
          id: requireFirst(parsed.positionals, 'reminder id'),
          remindAt: getFlag(parsed.flags, 'at'),
          title: parseNullableFlag(parsed.flags, 'title'),
          note: parseNullableFlag(parsed.flags, 'note')
        })
      )
      return
    case 'list':
      print(
        io,
        parsed.json,
        await app.reminders.list({
          targetType: parsed.flags.has('target-type')
            ? parseReminderTargetType(getFlag(parsed.flags, 'target-type'))
            : undefined,
          targetId: getFlag(parsed.flags, 'target-id'),
          status: parseReminderStatus(getFlag(parsed.flags, 'status')),
          fromDate: getFlag(parsed.flags, 'from'),
          toDate: getFlag(parsed.flags, 'to'),
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 50),
          offset: parseNumber(getFlag(parsed.flags, 'offset'), 0)
        })
      )
      return
    case 'for-target':
      print(
        io,
        parsed.json,
        await app.reminders.forTarget(
          parseReminderTargetType(parsed.positionals[0]),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'due':
      print(io, parsed.json, await app.reminders.due())
      return
    case 'upcoming':
      print(
        io,
        parsed.json,
        await app.reminders.upcoming(parseNumber(getFlag(parsed.flags, 'days'), 7))
      )
      return
    case 'dismiss':
      print(
        io,
        parsed.json,
        await app.reminders.dismiss(requireFirst(parsed.positionals, 'reminder id'))
      )
      return
    case 'snooze':
      print(
        io,
        parsed.json,
        await app.reminders.snooze(
          requireFirst(parsed.positionals, 'reminder id'),
          getFlag(parsed.flags, 'until') ?? parsed.positionals[1] ?? ''
        )
      )
      return
    case 'count-pending':
      print(io, parsed.json, await app.reminders.countPending())
      return
    case 'bulk-dismiss':
      print(io, parsed.json, await app.reminders.bulkDismiss(parsed.positionals))
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a reminder')
      print(io, parsed.json, {
        success: await app.reminders.delete(requireFirst(parsed.positionals, 'reminder id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] reminders create|get|update|list|for-target|due|upcoming|dismiss|snooze|count-pending|bulk-dismiss|delete'
      )
  }
}

async function runTemplates(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.templates.list())
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.templates.get(requireFirst(parsed.positionals, 'template id'))
      )
      return
    case 'create':
      print(
        io,
        parsed.json,
        await app.templates.create({
          name: requireFirst(parsed.positionals, 'template name'),
          description: getFlag(parsed.flags, 'description'),
          icon: getFlag(parsed.flags, 'icon') ?? null,
          content: getFlag(parsed.flags, 'content') ?? '',
          tags: getFlagList(parsed.flags, 'tag')
        })
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.templates.update(requireFirst(parsed.positionals, 'template id'), {
          name: getFlag(parsed.flags, 'name'),
          description: getFlag(parsed.flags, 'description'),
          icon: parsed.flags.has('icon') ? (getFlag(parsed.flags, 'icon') ?? null) : undefined,
          content: getFlag(parsed.flags, 'content'),
          tags: parsed.flags.has('tag') ? getFlagList(parsed.flags, 'tag') : undefined
        })
      )
      return
    case 'duplicate':
      print(
        io,
        parsed.json,
        await app.templates.duplicate(
          requireFirst(parsed.positionals, 'template id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a template')
      print(io, parsed.json, {
        success: await app.templates.delete(requireFirst(parsed.positionals, 'template id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] templates list|get|create|update|duplicate|delete'
      )
  }
}

async function runBookmarks(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.bookmarks.list({ itemType: getFlag(parsed.flags, 'type') }))
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.bookmarks.get(requireFirst(parsed.positionals, 'bookmark id'))
      )
      return
    case 'get-by-item':
      print(
        io,
        parsed.json,
        await app.bookmarks.getByItem(
          requireFirst(parsed.positionals, 'bookmark item type'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'list-by-type':
      print(
        io,
        parsed.json,
        await app.bookmarks.list({
          itemType: requireFirst(parsed.positionals, 'bookmark item type')
        })
      )
      return
    case 'add':
      print(
        io,
        parsed.json,
        await app.bookmarks.add({
          itemType: requireFirst(parsed.positionals, 'bookmark item type'),
          itemId: parsed.positionals[1] ?? ''
        })
      )
      return
    case 'toggle':
      print(
        io,
        parsed.json,
        await app.bookmarks.toggle({
          itemType: requireFirst(parsed.positionals, 'bookmark item type'),
          itemId: parsed.positionals[1] ?? ''
        })
      )
      return
    case 'remove':
      print(io, parsed.json, {
        success: await app.bookmarks.remove(
          requireFirst(parsed.positionals, 'bookmark item type'),
          parsed.positionals[1] ?? ''
        )
      })
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a bookmark')
      print(io, parsed.json, {
        success: await app.bookmarks.delete(requireFirst(parsed.positionals, 'bookmark id'))
      })
      return
    case 'has':
      print(io, parsed.json, {
        bookmarked: await app.bookmarks.has(
          requireFirst(parsed.positionals, 'bookmark item type'),
          parsed.positionals[1] ?? ''
        )
      })
      return
    case 'reorder':
      print(io, parsed.json, await app.bookmarks.reorder(parsed.positionals))
      return
    case 'bulk-create': {
      const parsedItems = parseCliValue(requireFirst(parsed.positionals, 'bookmark items'))
      if (!Array.isArray(parsedItems)) throw new Error('Bookmark items must be a JSON array')
      print(
        io,
        parsed.json,
        await app.bookmarks.bulkCreate(
          parsedItems.map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              throw new Error('Bookmark bulk item must be a JSON object')
            }
            const input = item as Record<string, unknown>
            if (typeof input.itemType !== 'string' || typeof input.itemId !== 'string') {
              throw new Error('Bookmark bulk item requires itemType and itemId')
            }
            return { itemType: input.itemType, itemId: input.itemId }
          })
        )
      )
      return
    }
    case 'bulk-delete':
      print(io, parsed.json, {
        success: await app.bookmarks.bulkDelete(parsed.positionals)
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] bookmarks list|get|get-by-item|list-by-type|add|toggle|remove|delete|has|reorder|bulk-create|bulk-delete'
      )
  }
}

async function runSavedFilters(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.savedFilters.list())
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.savedFilters.get(requireFirst(parsed.positionals, 'saved filter id'))
      )
      return
    case 'create':
      print(
        io,
        parsed.json,
        await app.savedFilters.create({
          name: requireFirst(parsed.positionals, 'saved filter name'),
          config: parseJsonFlag(parsed.flags, 'config') ?? {}
        })
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.savedFilters.update(requireFirst(parsed.positionals, 'saved filter id'), {
          name: getFlag(parsed.flags, 'name'),
          config: parseJsonFlag(parsed.flags, 'config')
        })
      )
      return
    case 'reorder':
      print(
        io,
        parsed.json,
        await app.savedFilters.reorder(parsed.positionals, parsePositionFlags(parsed.flags))
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a saved filter')
      print(io, parsed.json, {
        success: await app.savedFilters.delete(requireFirst(parsed.positionals, 'saved filter id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] saved-filters list|get|create|update|reorder|delete'
      )
  }
}

async function runCalendar(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  if (parsed.subcommand === 'sources') {
    print(
      io,
      parsed.json,
      await app.calendar.sources.list({
        provider: getFlag(parsed.flags, 'provider'),
        kind: getFlag(parsed.flags, 'kind') as CalendarSourceListOptions['kind'],
        selectedOnly: hasFlag(parsed.flags, 'selected')
      })
    )
    return
  }

  if (parsed.subcommand === 'select-source') {
    print(
      io,
      parsed.json,
      await app.calendar.sources.updateSelection(
        requireFirst(parsed.positionals, 'calendar source id'),
        parseBooleanFlag(parsed.flags, 'selected') ?? true
      )
    )
    return
  }

  if (parsed.subcommand === 'provider-status') {
    const provider = getFlag(parsed.flags, 'provider') ?? parsed.positionals[0]
    if (!provider) throw new Error('Pass --provider to provider-status')
    print(
      io,
      parsed.json,
      await app.calendar.providerStatus({
        provider,
        accountId: getFlag(parsed.flags, 'account')
      })
    )
    return
  }

  if (parsed.subcommand === 'google-settings') {
    print(io, parsed.json, await app.calendar.googleSettings())
    return
  }

  if (parsed.subcommand === 'set-default-google-calendar') {
    print(
      io,
      parsed.json,
      await app.calendar.setDefaultGoogleCalendar(
        parseNullableFlag(parsed.flags, 'calendar') ??
          (parsed.positionals[0] === 'null'
            ? null
            : requireFirst(parsed.positionals, 'calendar id')),
        parseBooleanFlag(parsed.flags, 'mark-onboarding') ?? true
      )
    )
    return
  }

  if (parsed.subcommand === 'range') {
    print(
      io,
      parsed.json,
      await app.calendar.range({
        startAt: getFlag(parsed.flags, 'start') ?? '',
        endAt: getFlag(parsed.flags, 'end') ?? '',
        includeUnselectedSources: hasFlag(parsed.flags, 'include-unselected')
      })
    )
    return
  }

  if (parsed.subcommand === 'external') {
    const action = requireFirst(parsed.positionals, 'calendar external action')
    const args = parsed.positionals.slice(1)

    switch (action) {
      case 'list':
        print(
          io,
          parsed.json,
          await app.calendar.external.list({
            sourceId: getFlag(parsed.flags, 'source'),
            includeArchived: hasFlag(parsed.flags, 'archived'),
            start: getFlag(parsed.flags, 'start'),
            end: getFlag(parsed.flags, 'end')
          })
        )
        return
      case 'get':
        print(
          io,
          parsed.json,
          await app.calendar.external.get(requireFirst(args, 'external calendar event id'))
        )
        return
      case 'promote':
        print(
          io,
          parsed.json,
          await app.calendar.external.promote(requireFirst(args, 'external calendar event id'))
        )
        return
      default:
        throw new Error('Usage: memrynote [--vault <path>] calendar external list|get|promote')
    }
  }

  if (parsed.subcommand === 'bindings') {
    const action = requireFirst(parsed.positionals, 'calendar bindings action')
    const args = parsed.positionals.slice(1)

    switch (action) {
      case 'list':
        print(
          io,
          parsed.json,
          await app.calendar.bindings.list({
            sourceType: getFlag(parsed.flags, 'source-type') as
              CalendarBindingListOptions['sourceType'] | undefined,
            sourceId: getFlag(parsed.flags, 'source'),
            provider: getFlag(parsed.flags, 'provider'),
            includeArchived: hasFlag(parsed.flags, 'archived')
          })
        )
        return
      case 'get':
        print(io, parsed.json, await app.calendar.bindings.get(requireFirst(args, 'binding id')))
        return
      default:
        throw new Error('Usage: memrynote [--vault <path>] calendar bindings list|get')
    }
  }

  if (parsed.subcommand !== 'events') {
    throw new Error(
      'Usage: memrynote [--vault <path>] calendar events create|get|list|update|delete OR calendar sources|select-source|provider-status|google-settings|set-default-google-calendar|range|external|bindings'
    )
  }

  const action = requireFirst(parsed.positionals, 'calendar events action')
  const args = parsed.positionals.slice(1)

  switch (action) {
    case 'create':
      print(
        io,
        parsed.json,
        await app.calendar.events.create({
          title: requireFirst(args, 'calendar event title'),
          startAt: getFlag(parsed.flags, 'start') ?? '',
          endAt: getFlag(parsed.flags, 'end') ?? null,
          timezone: getFlag(parsed.flags, 'timezone') ?? 'UTC',
          description: getFlag(parsed.flags, 'description') ?? null,
          location: getFlag(parsed.flags, 'location') ?? null,
          isAllDay: parseBooleanFlag(parsed.flags, 'all-day') ?? false
        })
      )
      return
    case 'get':
      print(io, parsed.json, await app.calendar.events.get(requireFirst(args, 'calendar event id')))
      return
    case 'list':
      print(
        io,
        parsed.json,
        await app.calendar.events.list({
          start: getFlag(parsed.flags, 'start'),
          end: getFlag(parsed.flags, 'end'),
          includeArchived: hasFlag(parsed.flags, 'archived')
        })
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.calendar.events.update(requireFirst(args, 'calendar event id'), {
          title: getFlag(parsed.flags, 'title'),
          startAt: getFlag(parsed.flags, 'start'),
          endAt: parsed.flags.has('end') ? (getFlag(parsed.flags, 'end') ?? null) : undefined,
          timezone: getFlag(parsed.flags, 'timezone'),
          description: parsed.flags.has('description')
            ? (getFlag(parsed.flags, 'description') ?? null)
            : undefined,
          location: parsed.flags.has('location')
            ? (getFlag(parsed.flags, 'location') ?? null)
            : undefined,
          isAllDay: parseBooleanFlag(parsed.flags, 'all-day')
        })
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a calendar event')
      print(io, parsed.json, {
        success: await app.calendar.events.delete(requireFirst(args, 'calendar event id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] calendar events create|get|list|update|delete'
      )
  }
}

async function runSync(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'status':
      print(io, parsed.json, await app.sync.status())
      return
    case 'queue-size':
      print(io, parsed.json, await app.sync.queueSize())
      return
    case 'history':
      print(
        io,
        parsed.json,
        await app.sync.history({
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 50),
          offset: parseNumber(getFlag(parsed.flags, 'offset'), 0)
        })
      )
      return
    case 'devices':
      print(io, parsed.json, await app.sync.devices())
      return
    case 'storage':
      print(io, parsed.json, await app.sync.storageBreakdown())
      return
    case 'quarantine':
      print(io, parsed.json, await app.sync.quarantinedItems())
      return
    case 'check-device':
      print(io, parsed.json, await app.sync.checkDeviceStatus())
      return
    case 'pause':
      print(io, parsed.json, await app.sync.pause())
      return
    case 'resume':
      print(io, parsed.json, await app.sync.resume())
      return
    case 'settings':
      print(io, parsed.json, await app.sync.getSyncedSettings())
      return
    case 'update-setting':
      print(
        io,
        parsed.json,
        await app.sync.updateSyncedSetting(
          requireFirst(parsed.positionals, 'synced setting path'),
          parseCliValue(parsed.positionals[1] ?? 'null')
        )
      )
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] sync status|queue-size|history|devices|storage|quarantine|check-device|pause|resume|settings|update-setting'
      )
  }
}

function parseAgentBackend(value: string | undefined): AgentBackend {
  if (value === 'claude_cli' || value === 'codex_cli') return value
  throw new Error('Agent backend must be claude_cli or codex_cli')
}

async function runAgent(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'backends':
      print(io, parsed.json, await app.agent.backendStatuses())
      return
    case 'models':
      print(
        io,
        parsed.json,
        await app.agent.backendModels(
          parseAgentBackend(getFlag(parsed.flags, 'backend') ?? parsed.positionals[0])
        )
      )
      return
    case 'local-settings':
      print(io, parsed.json, await app.agent.getLocalProviderSettings())
      return
    case 'set-local-settings': {
      const input: AgentLocalProviderSettingsInput = {}
      const preset = getFlag(parsed.flags, 'preset')
      if (preset) {
        if (
          preset !== 'ollama' &&
          preset !== 'lm_studio' &&
          preset !== 'llama_cpp' &&
          preset !== 'custom'
        ) {
          throw new Error('Local provider preset must be ollama, lm_studio, llama_cpp, or custom')
        }
        input.preset = preset
      }
      if (parsed.flags.has('base-url')) input.baseUrl = getFlag(parsed.flags, 'base-url') ?? ''
      if (parsed.flags.has('model')) input.model = getFlag(parsed.flags, 'model') ?? ''
      if (parsed.flags.has('allow-non-loopback')) {
        input.allowNonLoopback = parseBooleanFlag(parsed.flags, 'allow-non-loopback') ?? false
      }
      print(io, parsed.json, await app.agent.setLocalProviderSettings(input))
      return
    }
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] agent backends|models|local-settings|set-local-settings'
      )
  }
}

async function runGraph(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'data':
      print(io, parsed.json, await app.graph.data())
      return
    case 'local':
      print(
        io,
        parsed.json,
        await app.graph.local(
          requireFirst(parsed.positionals, 'note id'),
          parseNumber(getFlag(parsed.flags, 'depth'), 2)
        )
      )
      return
    default:
      throw new Error('Usage: memrynote [--vault <path>] graph data|local')
  }
}

async function runSearch(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'stats':
      print(io, parsed.json, await app.searchStats())
      return
    case 'reasons':
      print(io, parsed.json, await app.searchReasons.list())
      return
    case 'add-reason':
      print(
        io,
        parsed.json,
        await app.searchReasons.add({
          itemId: requireFirst(parsed.positionals, 'item id'),
          itemType: parseSearchItemType(parsed.positionals[1]),
          itemTitle: parsed.positionals[2] ?? '',
          searchQuery: parsed.positionals[3] ?? ''
        })
      )
      return
    case 'clear-reasons':
      print(io, parsed.json, await app.searchReasons.clear())
      return
    case 'tags':
      print(io, parsed.json, await app.searchTags())
      return
    case 'rebuild-index': {
      const stats = await app.searchStats()
      print(io, parsed.json, { started: true, indexed: stats.totalIndexed })
      return
    }
    default:
      print(
        io,
        parsed.json,
        await app.search(
          [parsed.subcommand, ...parsed.positionals]
            .filter((part): part is string => !!part)
            .join(' ')
        )
      )
  }
}

async function route(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.command) {
    case 'vault':
      return runVault(app, parsed, io)
    case 'notes':
      return runNotes(app, parsed, io)
    case 'folders':
      return runFolders(app, parsed, io)
    case 'properties':
      return runProperties(app, parsed, io)
    case 'folder-view':
      return runFolderView(app, parsed, io)
    case 'tasks':
      return runTasks(app, parsed, io)
    case 'projects':
      return runProjects(app, parsed, io)
    case 'inbox':
      return runInbox(app, parsed, io)
    case 'journal':
      return runJournal(app, parsed, io)
    case 'tags':
      return runTags(app, parsed, io)
    case 'settings':
      return runSettings(app, parsed, io)
    case 'locale':
      return runLocale(app, parsed, io)
    case 'reminders':
      return runReminders(app, parsed, io)
    case 'templates':
      return runTemplates(app, parsed, io)
    case 'bookmarks':
      return runBookmarks(app, parsed, io)
    case 'saved-filters':
      return runSavedFilters(app, parsed, io)
    case 'calendar':
      return runCalendar(app, parsed, io)
    case 'sync':
      return runSync(app, parsed, io)
    case 'agent':
      return runAgent(app, parsed, io)
    case 'graph':
      return runGraph(app, parsed, io)
    case 'search':
      return runSearch(app, parsed, io)
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] <vault|notes|folders|properties|folder-view|tasks|projects|inbox|journal|tags|settings|locale|reminders|templates|bookmarks|saved-filters|calendar|sync|agent|graph|search>'
      )
  }
}

export async function runCli(
  args: string[],
  io: CliIo = {},
  deps: CliRuntimeDeps = {}
): Promise<number> {
  const parsed = parseCli(args)
  const stderr = io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`))
  const stdout = io.stdout ?? ((line: string) => process.stdout.write(`${line}\n`))

  let app: MemryApp | null = null
  try {
    if (
      parsed.command === 'vault' &&
      (await runVaultRegistryCommand(parsed, { stdout, stderr }, deps.vaultRegistry))
    ) {
      return 0
    }

    const vaultPath = parsed.vaultPath ?? (await resolveDefaultVaultPath(deps.vaultRegistry))
    const createApp = deps.createApp ?? defaultCreateMemryApp
    app = await createApp({ vaultPath })
    await route(app, parsed, { stdout, stderr })
    return 0
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    app?.close()
  }
}
