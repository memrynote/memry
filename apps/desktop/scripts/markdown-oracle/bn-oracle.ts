/**
 * Oracle ops for the BlockNote parse path (stage 3 of #3522): `markdownToHtml`,
 * `HTMLToBlocks` (nested lists, whitespace, the ProseMirror DOMParser,
 * `nodeToBlock`) and the memry-layer-free markdown parse. All run on the memry
 * schema exactly as `blocknote-converter.ts` builds it.
 */
import { markdownToHTML, type Block } from '@blocknote/core'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { createMemrySchema } from '@memry/editor-schema'
import { memryCodeBlockOptions } from '@memry/editor-schema/code-block'
import {
  FUZZ_FAMILIES,
  ROUNDTRIP_CASES,
  createSeededRandom
} from '@memry/editor-schema/conformance'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'

import { markdownToBlocks } from '../../src/main/sync/blocknote-converter'

let editor: ServerBlockNoteEditor | undefined

export function getEditor(): ServerBlockNoteEditor {
  editor ??= ServerBlockNoteEditor.create({
    schema: createMemrySchema({
      codeBlock: memryCodeBlockOptions,
      blocks: createServerBlockSpecs(),
      inline: createServerInlineSpecs()
    })
  })
  return editor
}

export interface CanonicalBlock {
  type: string
  props: Record<string, unknown>
  content: unknown
  children: CanonicalBlock[]
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).toSorted()) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- value is a JSON object
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined && entry !== null) out[key] = canonicalValue(entry)
    }
    return out
  }
  return value
}

/** Block JSON as the vectors state it: `id` dropped, props sorted, `undefined` and `null` props omitted. */
export function canonicalBlocks(blocks: readonly Block[]): CanonicalBlock[] {
  return blocks.map((block) => {
    const props: Record<string, unknown> = {}
    for (const key of Object.keys(block.props).toSorted()) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- props are JSON values
      const value = (block.props as Record<string, unknown>)[key]
      if (value !== undefined && value !== null) props[key] = canonicalValue(value)
    }
    return {
      type: block.type,
      props,
      content: block.content === undefined ? null : canonicalValue(block.content),
      children: canonicalBlocks(block.children ?? [])
    }
  })
}

export function mdToHtml(markdown: string): string {
  return markdownToHTML(markdown)
}

export async function htmlToBlocks(html: string): Promise<CanonicalBlock[]> {
  return canonicalBlocks(await getEditor().tryParseHTMLToBlocks(html))
}

/**
 * BlockNote's own markdown parse, plus whether the memry layers (comment
 * masking, repairs, marker passes of `markdownToBlocks`) left it unchanged.
 * Vectors keep only the cases where they did; the rest belong to the memry
 * layers of a later stage.
 */
export async function bnParse(
  markdown: string
): Promise<{ blocks: CanonicalBlock[]; memryLayerNoop: boolean }> {
  const blocks = canonicalBlocks(await getEditor().tryParseMarkdownToBlocks(markdown))
  const memry = await markdownToBlocks(markdown)
  const memryBlocks = memry === null ? null : canonicalBlocks(memry)
  return { blocks, memryLayerNoop: JSON.stringify(blocks) === JSON.stringify(memryBlocks) }
}

/** The markdown inputs of the shared conformance corpus: 275 round-trip cases and 6 fuzz families by 48. */
export function markdownSources(): { name: string; markdown: string }[] {
  const out: { name: string; markdown: string }[] = []
  for (const c of ROUNDTRIP_CASES) out.push({ name: `rt-${c.name}`, markdown: c.markdown })
  for (const family of FUZZ_FAMILIES) {
    const random = createSeededRandom(0x1848)
    for (let i = 0; i < 48; i++) {
      out.push({ name: `fz-${family.name}-${i}`, markdown: family.generate(random) })
    }
  }
  return out
}
