import type { MemryApp } from './app-core/memry-app.ts'
import { runVaultAdmin } from './commands/vault-admin.ts'
import { runFolderTools, runNoteTools, runPropertyTools } from './commands/note-tools.ts'
import {
  type CliIo,
  type CliVaultRegistry,
  type ParsedCli,
  type PdfExportOptions,
  getFlag,
  getFlagList,
  hasFlag,
  listKnownVaults,
  parseBooleanFlag,
  parseCliValue,
  parseJsonStringFlag,
  parseNumber,
  parseObjectValue,
  print,
  requireFirst,
  requireVaultRegistry,
  resolveDefaultVaultPath
} from './cli-support.ts'

export async function runVault(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
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
    case 'reindex':
    case 'set-icon':
    case 'activity':
    case 'locks':
      return runVaultAdmin(app, parsed, io)
    default:
      throw new Error(
        'Usage: memrynote vault list|current|use|remove OR memrynote [--vault <path>] vault init|status|config|update-config|reindex|set-icon|activity|locks'
      )
  }
}

export async function runVaultRegistryCommand(
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
    case 'remove': {
      const reference = parsed.positionals[0]
      if (!reference) throw new Error('Usage: memrynote vault remove <vault-name-or-path> --yes')
      if (!hasFlag(parsed.flags, 'yes')) {
        throw new Error('Pass --yes to remove the vault from the list (its files are kept)')
      }
      const resolved = await requireVaultRegistry(registry)
      if (!resolved.removeVault) {
        throw new Error('This CLI cannot remove vaults. Run Memry from the desktop app command.')
      }
      print(io, parsed.json, { removed: await resolved.removeVault(reference) })
      return true
    }
    default:
      return false
  }
}

export async function runNotes(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  if (await runNoteTools(app, parsed, io)) return
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
              : (parseBooleanFlag(parsed.flags, 'include-metadata') ?? true),
            includeTaskMarkers: hasFlag(parsed.flags, 'include-task-markers')
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
            includeTaskMarkers: hasFlag(parsed.flags, 'include-task-markers'),
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
        'Usage: memrynote [--vault <path>] notes create|list|get|exists|preview|resolve|links|update|rename|move|set-local-only|local-only-count|delete|attach|attachments|delete-attachment|import-files|export-html|export-pdf|export-markdown|snapshot|versions|version|restore-version|delete-version|aliases|apply-template|unlinked-mentions|link-mention|carried-tasks|similar|suggest-tags|positions|reorder|read-lines|grep|attachment-rename'
      )
  }
}

export async function runFolders(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  if (await runFolderTools(app, parsed, io)) return
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
      throw new Error(
        'Usage: memrynote [--vault <path>] folders list|create|rename|delete|template'
      )
  }
}

export async function runProperties(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  if (await runPropertyTools(app, parsed, io)) return
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
        'Usage: memrynote [--vault <path>] properties get|set|rename|definitions|define|update-definition|delete-definition|ensure|option-add|option-remove|option-rename|option-color|merge|resolve-refs|calendar-names|calendar-visibility'
      )
  }
}

export async function runFolderView(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
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
