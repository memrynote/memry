/**
 * What an older desktop release's BlockNote wrote into a note's `prosemirror`
 * fragment, so the core reads those documents the way they are.
 *
 * Notes written by a release live on in every vault and on the server. A newer
 * schema that no longer declares an attribute or a mark those releases wrote
 * reads them with loss (the core's `ReadFragment::lost`), and the external feed
 * then refuses to replace the body. This script asks the real build: its
 * `pmSchema` (every node and mark with each attribute's default) and the bytes
 * its `blocksToYXmlFragment` (the path desktop main calls) writes for every
 * case of the note-blocks corpus.
 *
 * Two steps, because a release tree predates this script and its corpus:
 *
 *   1. In this tree: `npx tsx scripts/markdown-oracle/blocknote-history.mts cases <cases.json>`
 *      writes `NOTE_BLOCK_CASES` plus the link cases below as plain block JSON.
 *   2. In a worktree at the release tag (`git worktree add .worktrees/<name> <tag>`, then
 *      `pnpm install --frozen-lockfile --ignore-scripts --filter "@memry/desktop..."`), copy
 *      this file into its `apps/desktop/` and run
 *      `npx tsx blocknote-history.mts write <cases.json> <out.json> <tag>`.
 *
 * The output is committed as `packages/contracts/test-vectors/markdown-convert/blocknote-<version>.json`;
 * `cases-pm.ts` turns its documents into `yxml/read/bn-<version>-*` cases. A case
 * whose block type the release did not have is recorded with its error.
 *
 * The `write` step needs `@memry/editor-schema` in the release tree, which tags
 * from v2026-08-14 have. Earlier releases build the same BlockNote with the
 * renderer's own block specs; their schema is compared by reading those specs.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import * as Y from 'yjs'

type Attrs = Record<string, unknown>
interface AttrSpec {
  default?: unknown
}
interface TypeSpec {
  attrs?: Record<string, AttrSpec | undefined>
}
interface SpecMap {
  forEach(callback: (name: string, spec: TypeSpec) => void): void
}
interface PmSchema {
  spec: { nodes: SpecMap; marks: SpecMap }
}
interface Writer {
  editor: { pmSchema: PmSchema }
  blocksToYXmlFragment(blocks: unknown[], fragment: Y.XmlFragment): void
}
interface BlockCase {
  name: string
  blocks: unknown[]
}

/** Links as the editor writes them, the one inline mark with attributes besides colours. */
const LINK_CASES: BlockCase[] = [
  {
    name: 'link written by the editor',
    blocks: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ', styles: {} },
          { type: 'link', href: 'https://example.com', content: 'example' }
        ]
      }
    ]
  },
  {
    name: 'link with marks inside a table',
    blocks: [
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [
            {
              cells: [
                [
                  {
                    type: 'link',
                    href: 'https://a.example',
                    content: [{ type: 'text', text: 'a', styles: { bold: true } }]
                  }
                ]
              ]
            }
          ]
        }
      }
    ]
  }
]

/** The client id and block ids of `conformance-ydoc.ts`, so a document's bytes are reproducible. */
const CLIENT_ID = 0x6d656d72

function withIds(blocks: unknown[], prefix: string): unknown[] {
  return blocks.map((block, index) => {
    if (block === null || typeof block !== 'object') return block
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- block JSON is an object here; id and children are read defensively
    const entry = block as Record<string, unknown> & { children?: unknown[] }
    const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `${prefix}-${index}`
    return {
      ...entry,
      id,
      ...(Array.isArray(entry.children) ? { children: withIds(entry.children, id) } : {})
    }
  })
}

function slug(name: string): string {
  return name
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

/**
 * Each attribute with its default. JSON has no `undefined`, so an attribute whose default is
 * `undefined` (`numberedListItem.start`, `textColor.stringValue`) is written as
 * `<undefined>` rather than dropped, and one with no default as `<required>`.
 */
function attrsOf(spec: TypeSpec): Attrs {
  return Object.fromEntries(
    Object.entries(spec.attrs ?? {}).map(([name, attr]) => {
      if (!attr || !('default' in attr)) return [name, '<required>']
      return [name, attr.default === undefined ? '<undefined>' : attr.default]
    })
  )
}

/** `exports` hides `package.json`, so it is found above the resolved entry. */
function version(pkg: string): string {
  let dir = dirname(createRequire(import.meta.url).resolve(pkg))
  while (!existsSync(join(dir, 'package.json')) || !dir.endsWith(pkg)) dir = dirname(dir)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a package.json
  return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string })
    .version
}

async function cases(out: string): Promise<void> {
  // Loaded here only: a release tree running `write` has no corpus to import.
  const { NOTE_BLOCK_CASES } = await import('@memry/editor-schema/conformance')
  const all = [...NOTE_BLOCK_CASES, ...LINK_CASES].map(({ name, blocks }) => ({ name, blocks }))
  writeFileSync(out, `${JSON.stringify(all, null, 1)}\n`)
}

async function write(input: string, out: string, tag: string): Promise<void> {
  // Imported by name at run time: this file runs in release trees whose packages differ.
  const { ServerBlockNoteEditor } = await import('@blocknote/server-util')
  const { createMemrySchema } = await import('@memry/editor-schema')
  const { memryCodeBlockOptions } = await import('@memry/editor-schema/code-block')
  const { createServerBlockSpecs, createServerInlineSpecs } =
    await import('@memry/editor-schema/server')
  const schema = createMemrySchema({
    codeBlock: memryCodeBlockOptions,
    blocks: createServerBlockSpecs(),
    inline: createServerInlineSpecs()
  })
  const created: object = ServerBlockNoteEditor.create({ schema })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema-specific generic cannot be named across releases; Writer is the part this script calls
  const writer = created as Writer
  const nodes: Record<string, Attrs> = {}
  const marks: Record<string, Attrs> = {}
  writer.editor.pmSchema.spec.nodes.forEach((name, spec) => (nodes[name] = attrsOf(spec)))
  writer.editor.pmSchema.spec.marks.forEach((name, spec) => (marks[name] = attrsOf(spec)))

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the file is the output of the `cases` step
  const inputCases = JSON.parse(readFileSync(input, 'utf8')) as BlockCase[]
  const docs = inputCases.map(({ name, blocks }) => {
    const doc = new Y.Doc()
    doc.clientID = CLIENT_ID
    try {
      if (blocks.length > 0)
        writer.blocksToYXmlFragment(withIds(blocks, slug(name)), doc.getXmlFragment('prosemirror'))
      return { name, updateHex: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('hex') }
    } catch (error) {
      return { name, error: String(error) }
    }
  })
  const meta = {
    tag,
    blocknote: version('@blocknote/core'),
    generator: 'apps/desktop/scripts/markdown-oracle/blocknote-history.mts',
    note: 'pmSchema of the release (attribute: default) and what its blocksToYXmlFragment writes per note-blocks case'
  }
  writeFileSync(out, `${JSON.stringify({ meta, nodes, marks, docs }, null, 1)}\n`)
}

const [mode, ...args] = process.argv.slice(2)
if (mode === 'cases' && args.length === 1) await cases(args[0])
else if (mode === 'write' && args.length === 3) await write(args[0], args[1], args[2])
else throw new Error('usage: blocknote-history.mts cases <out> | write <cases> <out> <tag>')
