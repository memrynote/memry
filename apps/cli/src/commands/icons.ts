import type { MemryApp } from '../app-core/memry-app.ts'
import { getFlag, hasFlag, print, requireFirst, type CliIo, type ParsedCli } from '../run.ts'

/** `icons` commands: the vault's custom icon library. */
export async function runIcons(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  const { customIcons } = app
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await customIcons.list())
      return
    case 'add':
      print(
        io,
        parsed.json,
        await customIcons.add(
          requireFirst(parsed.positionals, 'icon file path'),
          getFlag(parsed.flags, 'name')
        )
      )
      return
    case 'rename': {
      const id = requireFirst(parsed.positionals, 'icon id')
      print(
        io,
        parsed.json,
        await customIcons.rename(id, requireFirst(parsed.positionals.slice(1), 'new name'))
      )
      return
    }
    case 'delete': {
      const id = requireFirst(parsed.positionals, 'icon id')
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete an icon')
      const result = await customIcons.delete(id)
      if (!result.success) throw new Error(`Custom icon ${id} not found`)
      print(io, parsed.json, result)
      return
    }
    default:
      throw new Error('Usage: memrynote icons <list|add|rename|delete> [args]')
  }
}
