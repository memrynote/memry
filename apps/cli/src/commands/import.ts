import type { MemryApp } from '../app-core/memry-app.ts'
import { getFlag, print, type CliIo, type ParsedCli } from '../run.ts'

/** `import` commands: bring files from other apps into the vault. */
export async function runImport(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  const { importer } = app
  switch (parsed.subcommand) {
    case 'sources':
      print(io, parsed.json, importer.sources())
      return
    case 'preview':
    case 'start': {
      const source = parsed.positionals[0]
      if (!source)
        throw new Error(`Usage: memrynote import ${parsed.subcommand} <source> <path...>`)
      const paths = parsed.positionals.slice(1)
      const options = { folder: getFlag(parsed.flags, 'folder') }
      print(
        io,
        parsed.json,
        parsed.subcommand === 'preview'
          ? await importer.preview(source, paths, options)
          : await importer.start(source, paths, options)
      )
      return
    }
    default:
      throw new Error('Usage: memrynote import <sources|preview|start> [args]')
  }
}
