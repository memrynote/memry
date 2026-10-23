import type { MemryApp } from '../app-core/memry-app.ts'
import { hasFlag, print, requireFirst, type CliIo, type ParsedCli } from '../run.ts'

/** Sync commands added for desktop parity. Returns false for a subcommand it does not own. */
export async function runSyncExtras(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<boolean> {
  const { syncExtras } = app
  switch (parsed.subcommand) {
    case 'trigger':
      await syncExtras.trigger()
      return true
    case 'note-state': {
      const noteId = requireFirst(parsed.positionals, 'note id or path')
      const state = await syncExtras.noteState(noteId)
      if (!state) throw new Error(`Note not found: ${noteId}`)
      print(io, parsed.json, state)
      return true
    }
    case 'large-notes':
      print(io, parsed.json, await syncExtras.largeNotes())
      return true
    case 'unsent-notes':
      print(io, parsed.json, await syncExtras.unsentNotes())
      return true
    case 'binding':
      print(io, parsed.json, await syncExtras.binding())
      return true
    case 'progress':
      await syncExtras.progress()
      return true
    case 'rename-device': {
      const deviceId = requireFirst(parsed.positionals, 'device id')
      await syncExtras.renameDevice(deviceId, requireFirst(parsed.positionals.slice(1), 'new name'))
      return true
    }
    case 'remove-device':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to remove a device')
      await syncExtras.removeDevice(requireFirst(parsed.positionals, 'device id'))
      return true
    default:
      return false
  }
}
