import type { MemryApp } from '../app-core/memry-app.ts'
import { print, requireFirst, type CliIo, type ParsedCli } from '../cli-support.ts'

/** `home-pages` commands: read the home boards. Widgets and covers are edited in the desktop app. */
export async function runHomePages(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.homePages.list())
      return
    case 'get': {
      const id = requireFirst(parsed.positionals, 'home page id')
      const page = await app.homePages.get(id)
      if (!page) throw new Error(`Home page not found: ${id}`)
      print(io, parsed.json, page)
      return
    }
    default:
      throw new Error('Usage: memrynote home-pages <list|get> [args]')
  }
}
