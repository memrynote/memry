import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import manifest from '../../../../packages/editor-schema/src/registry-manifest.json'
import {
  markdownToYFragment,
  yDocToMarkdown,
  yFragmentToBlocks
} from '../../src/main/sync/blocknote-converter'
import {
  IOS_PARITY_ATTACHMENTS,
  IOS_PARITY_BODY,
  IOS_PARITY_NOTE,
  IOS_PARITY_NOTE_PATH,
  iosParityAssetSize
} from './ios-parity'
import { TASKS } from './tasks'

const FRAGMENT = 'prosemirror'

/**
 * On-disk syntax of each inline type. Most inline nodes are built by the
 * renderer from these tokens, so the main-process parse cannot see them; the
 * body is checked for the syntax instead. Keyed by the registry, so a new
 * inline type fails here until the note carries it.
 */
const INLINE_SYNTAX: Record<string, RegExp> = {
  text: /\w/,
  link: /\[[^\]]+\]\(https?:\/\/[^)]+\)/,
  wikiLink: /\[\[[^\]|]+\|[^\]]+\]\]/,
  hashTag: /(^|\s)#[a-z][\w/-]*/m,
  dateMention: /\(\(date:[A-Za-z0-9,;]+\)\)/,
  linkMention: /\(\(mention:[^)]+\)\)/,
  inlineCheckbox: /\| \[[ x]\] /,
  inlineImage: /\| !\[[^\]]*\]\([^)]+\) \|/
}

interface AnyBlock {
  type: string
  props?: Record<string, unknown>
  content?: unknown
  children?: AnyBlock[]
}

interface Seen {
  blocks: Set<string>
  inline: Set<string>
  styles: Set<string>
  fileMimeTypes: Set<string>
}

function walkInline(content: unknown, seen: Seen): void {
  if (!content) return
  if (Array.isArray(content)) {
    for (const node of content as { type: string; styles?: object; content?: unknown }[]) {
      seen.inline.add(node.type)
      for (const style of Object.keys(node.styles ?? {})) seen.styles.add(style)
      walkInline(node.content, seen)
    }
    return
  }
  if (typeof content === 'object' && 'rows' in content) {
    for (const row of (content as { rows: { cells: unknown[] }[] }).rows) {
      for (const cell of row.cells) {
        walkInline(
          typeof cell === 'object' && cell !== null && 'content' in cell ? cell.content : cell,
          seen
        )
      }
    }
  }
}

function walkBlocks(blocks: AnyBlock[], seen: Seen): void {
  for (const block of blocks) {
    seen.blocks.add(block.type)
    if (block.type === 'file') seen.fileMimeTypes.add(String(block.props?.mimeType))
    walkInline(block.content, seen)
    walkBlocks(block.children ?? [], seen)
  }
}

async function seedDoc(): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(
    IOS_PARITY_BODY,
    doc.getXmlFragment(FRAGMENT),
    IOS_PARITY_NOTE_PATH
  )
  expect(ok).toBe(true)
  return doc
}

describe('iOS Parity Test seed note', () => {
  it('uses every block, inline node and style the editor registers', async () => {
    const doc = await seedDoc()
    const blocks = ((await yFragmentToBlocks(doc.getXmlFragment(FRAGMENT))) ?? []) as AnyBlock[]
    const seen: Seen = {
      blocks: new Set(),
      inline: new Set(),
      styles: new Set(),
      fileMimeTypes: new Set()
    }
    walkBlocks(blocks, seen)

    // The editor never writes BlockNote's own audio/video blocks: the picker
    // and drag-drop insert a `file` block whose mimeType picks the player.
    const written = manifest.blocks.filter((type) => type !== 'audio' && type !== 'video')
    expect([...seen.blocks].sort()).toEqual(expect.arrayContaining(written))
    expect([...seen.fileMimeTypes].sort()).toEqual(['application/pdf', 'audio/mp4', 'video/mp4'])
    for (const type of manifest.inline) {
      expect(INLINE_SYNTAX[type], `no syntax check for inline type ${type}`).toBeDefined()
      expect(IOS_PARITY_BODY, type).toMatch(INLINE_SYNTAX[type])
    }
    expect([...seen.styles]).toEqual(expect.arrayContaining(manifest.styles))
  })

  it('writes back byte for byte, so opening it never rewrites the file', async () => {
    const doc = await seedDoc()
    // A document carrying CriticMarkup serializes without it; write-back puts
    // the marks back from their own record. Everything else must match, and the
    // file writer supplies the final newline.
    const withoutCritic = IOS_PARITY_BODY.replace(/\{==(.*?)==\}\{>>.*?<<\}/g, '$1').trimEnd()
    expect(await yDocToMarkdown(doc, FRAGMENT, { notePath: IOS_PARITY_NOTE_PATH })).toBe(
      withoutCritic
    )
  })

  it('references only seeded tasks and shipped attachments', () => {
    const taskIds = new Set(TASKS.map((task) => task.id))
    const refs = [...IOS_PARITY_BODY.matchAll(/\{task:([^}]+)\}/g)].map((match) => match[1])
    expect(refs).toHaveLength(3)
    for (const id of refs) expect(taskIds).toContain(id)

    for (const name of IOS_PARITY_ATTACHMENTS) {
      expect(IOS_PARITY_BODY).toContain(`/${name}`)
    }
    for (const marker of IOS_PARITY_BODY.matchAll(/<!-- file:(\{.*?\}) -->/g)) {
      const props = JSON.parse(marker[1]) as { name: string; size: number }
      expect(props.size).toBe(
        iosParityAssetSize(props.name as (typeof IOS_PARITY_ATTACHMENTS)[number])
      )
    }
  })

  it('carries every property type in its frontmatter', () => {
    expect(Object.keys(IOS_PARITY_NOTE.frontmatter)).toEqual([
      'tags',
      'aliases',
      'author',
      'rating',
      'deadline',
      'shared',
      'url',
      'status',
      'priority',
      'format',
      'related',
      'project'
    ])
  })
})
