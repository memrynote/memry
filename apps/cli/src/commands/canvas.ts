import { readFileSync } from 'node:fs'
import type { MemryApp } from '../app-core/memry-app.ts'
import {
  getFlag,
  hasFlag,
  parseNullableFlag,
  print,
  requireFirst,
  type CliIo,
  type ParsedCli
} from '../run.ts'

/** `canvas` commands: the canvas index and its `.excalidraw` documents. Drawing stays in the desktop app. */
export async function runCanvas(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  const { canvas } = app
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await canvas.list({ folder: getFlag(parsed.flags, 'folder') }))
      return
    case 'get': {
      const id = requireFirst(parsed.positionals, 'canvas id')
      const record = await canvas.get(id)
      if (!record) throw new Error(`Canvas not found: ${id}`)
      if (hasFlag(parsed.flags, 'no-scene')) {
        const { scene: _scene, ...summary } = record
        print(io, parsed.json, summary)
        return
      }
      print(io, parsed.json, record)
      return
    }
    case 'create': {
      const sceneFile = getFlag(parsed.flags, 'scene-file')
      print(
        io,
        parsed.json,
        await canvas.create({
          title: parseNullableFlag(parsed.flags, 'title'),
          folder: parseNullableFlag(parsed.flags, 'folder'),
          icon: parseNullableFlag(parsed.flags, 'icon'),
          scene: sceneFile ? readFileSync(sceneFile, 'utf8') : undefined
        })
      )
      return
    }
    case 'duplicate': {
      const id = requireFirst(parsed.positionals, 'canvas id')
      const copy = await canvas.duplicate(id)
      if (!copy) throw new Error(`Canvas not found or its document is unreadable: ${id}`)
      print(io, parsed.json, copy)
      return
    }
    case 'delete': {
      const id = requireFirst(parsed.positionals, 'canvas id')
      if (!hasFlag(parsed.flags, 'yes')) {
        throw new Error(
          'Pass --yes to delete a canvas. The document file is removed from the vault.'
        )
      }
      const result = await canvas.delete(id)
      if (!result.deleted) throw new Error(`Canvas not found: ${id}`)
      print(io, parsed.json, result)
      return
    }
    case 'export': {
      const id = requireFirst(parsed.positionals, 'canvas id')
      const result = await canvas.export(id, getFlag(parsed.flags, 'out'))
      if (!result) throw new Error(`Canvas not found: ${id}`)
      // Without --out the Excalidraw document goes to stdout, ready to pipe.
      io.stdout?.('scene' in result ? result.scene : JSON.stringify(result))
      return
    }
    default:
      throw new Error('Usage: memrynote canvas <list|get|create|duplicate|delete|export> [args]')
  }
}
