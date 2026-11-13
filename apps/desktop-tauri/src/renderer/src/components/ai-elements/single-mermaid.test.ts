import { realpathSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_NODE_MODULES = path.resolve(import.meta.dirname, '../../../../../node_modules')

// Each mermaid copy brings its whole diagram graph into the renderer build. Two copies
// pushed `vite build` past the 4 GB CI heap (#4408).
const MERMAID_USERS = [
  ['streamdown'],
  ['@streamdown/mermaid'],
  ['@blocknote/diagram-block'],
  ['@excalidraw/excalidraw', '@excalidraw/mermaid-to-excalidraw']
]

const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`

// pnpm links each package's dependencies as siblings of its real directory.
const resolveChain = (chain: string[]): string => {
  let dir = realpathSync(path.join(APP_NODE_MODULES, chain[0]))
  for (const dep of [...chain.slice(1), 'mermaid']) {
    const end = dir.lastIndexOf(NODE_MODULES_SEGMENT) + NODE_MODULES_SEGMENT.length
    const siblings = dir.slice(0, end)
    dir = realpathSync(path.join(siblings, dep))
  }
  return dir
}

describe('renderer mermaid', () => {
  it('resolves one mermaid for every user', () => {
    const resolved = new Set(MERMAID_USERS.map(resolveChain))
    expect([...resolved]).toHaveLength(1)
  })
})
