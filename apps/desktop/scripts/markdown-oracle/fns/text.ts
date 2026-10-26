/**
 * Layer `text` of stage 4 (#3522): function-level oracle cases. `FNS` maps a
 * name to the TypeScript function the Rust port must reproduce (arguments and
 * result are JSON); `textCases` lists the cases of `layer-text.json`. Inputs only:
 * the expected output is whatever the TypeScript code returns.
 *
 * Two modules draw a random word per process (`html-comments`, `link-destinations`).
 * The functions here swap it for a fixed one (`FIXED_WORD`) in every argument and
 * result, so the vectors are stable and the Rust test pins the same word.
 */
import {
  assembleMarkdownWithBlanks,
  escapeWikiLinkPipesInTableRows,
  extractWikiImageEmbedRefs,
  fenceIndentedCodeBlocks,
  normalizeSerializedMarkdown,
  rewriteWikiImageEmbeds,
  separateBlockImages,
  splitByCodeFences,
  splitMarkdownPreservingBlanks,
  type MarkdownSegment
} from '@memry/shared/empty-lines'
import {
  decodeHtmlCommentTokens,
  encodeHtmlCommentToken,
  hasHtmlCommentToken,
  maskHtmlComments,
  splitHtmlCommentTokens
} from '@memry/shared/html-comments'
import {
  hasHardBreakToken,
  maskHardBreaks,
  restoreHardBreakSpelling,
  unmaskHardBreaks
} from '@memry/shared/hard-breaks'
import {
  createBlockNestingMarker,
  foldBlockNestingMarkers,
  isBlockNestingMarker,
  parseMarkdownWithNestingMarkers,
  restoreBlockNesting,
  splitMarkdownByBlockNestingMarkers
} from '@memry/shared/block-nesting'
import {
  inlineLinkReferences,
  normalizeLinkReferenceLabel,
  restoreLinkReferences,
  stripLinkReferenceDefinitions,
  type LinkReferenceDefinition,
  type LinkReferenceUsage
} from '@memry/shared/link-references'
import {
  blankMarkdownCode,
  maskMarkdownCode,
  replaceMarkdownComments,
  stripMarkdownComments
} from '@memry/shared/markdown-code'
import {
  maskCellCodeSpaces,
  restoreCellCodeSpaces
} from '../../../../../packages/editor-schema/src/inline/cell-code-spaces'
import {
  linkDestination,
  maskLinkDestinations,
  restoreLinkDestinations,
  withLinkDestination
} from '../../../../../packages/editor-schema/src/inline/link-destinations'
import {
  codeSpanRanges,
  linkCodeAsText
} from '../../../../../packages/editor-schema/src/inline/link-code-spans'
import {
  maskInlineTokens,
  restoreInlineTokens
} from '../../../../../packages/editor-schema/src/inline/token-masking'
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'
import { buildTextCases } from './text-cases'

/** The word both random prefixes are shown with in the vectors and pinned to in Rust. */
export const FIXED_WORD = 'ABCDEFGHIJKL'
const FIXED_COMMENT_PREFIX = `MEMRYCMT${FIXED_WORD}`
const FIXED_LINK_PREFIX = `MEMRYLNK${FIXED_WORD}`

const REAL_COMMENT_PREFIX = encodeHtmlCommentToken('').slice(0, -1)
const REAL_LINK_PREFIX = ((): string => {
  const probe = maskLinkDestinations('[a](b c)').markdown
  const word = /MEMRYLNK([A-Z]{12})0X/.exec(probe)?.[1]
  if (!word) throw new Error('link destination placeholder not found')
  return `MEMRYLNK${word}`
})()

const SWAPS: Array<[string, string]> = [
  [FIXED_COMMENT_PREFIX, REAL_COMMENT_PREFIX],
  [FIXED_LINK_PREFIX, REAL_LINK_PREFIX]
]

function swap(value: unknown, direction: 0 | 1): unknown {
  if (typeof value === 'string') {
    let out = value
    for (const pair of SWAPS) out = out.split(pair[direction]).join(pair[1 - direction])
    return out
  }
  if (Array.isArray(value)) return value.map((item) => swap(item, direction))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v, direction)]))
  }
  return value
}

/** Runs `fn` on the arguments with the process words real, and shows the result with them fixed. */
function fixed<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => unknown {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- swap maps JSON to JSON of the same shape
  return (...args) => swap(fn(...(swap(args, 0) as A)), 1)
}

// --- stubs: the callbacks of the TypeScript functions, named in the case input ----

type Block = Record<string, unknown>

const PARSE_STUBS: Record<string, (chunk: string) => Promise<Block[]>> = {
  paragraph: async (chunk) => [{ type: 'paragraph', content: chunk, children: [] }],
  lines: async (chunk) => chunk.split('\n').map((line) => ({ type: 'paragraph', content: line })),
  kids: async (chunk) => [
    {
      type: 'paragraph',
      content: chunk,
      children: [{ type: 'paragraph', content: 'kid', children: [] }]
    }
  ],
  none: async () => [],
  nullChildren: async (chunk) => [{ type: 'paragraph', content: chunk, children: null }]
}

function parseStub(name: string): (chunk: string) => Promise<Block[]> {
  const stub = PARSE_STUBS[name]
  if (!stub) throw new Error(`unknown parse stub: ${name}`)
  return stub
}

const RESOLVE_STUBS: Record<string, (ref: string) => string | undefined> = {
  prefix: (ref) => `memry-file://vault/${ref}`,
  none: () => undefined,
  empty: () => '',
  onlyPng: (ref) => (/\.png$/i.test(ref) ? `memry-file://png/${ref}` : undefined)
}

function resolveStub(name: string): (ref: string) => string | undefined {
  const stub = RESOLVE_STUBS[name]
  if (!stub) throw new Error(`unknown resolve stub: ${name}`)
  return stub
}

/** A block list with a marker as `{ $marker: true }`: the marker's level is not observable. */
function showBlocks(blocks: Block[]): unknown[] {
  return blocks.map((block) => (isBlockNestingMarker(block) ? { $marker: true } : block))
}

const noBlocks = async (): Promise<Block[]> => []

/** A marker block of `level`, made the only way the module makes one: by parsing a marker line. */
async function makeMarker(level: number): Promise<Block> {
  if (level > 0) {
    const [marker] = await parseMarkdownWithNestingMarkers(
      createBlockNestingMarker(level),
      noBlocks
    )
    return marker
  }
  const parsed = await parseMarkdownWithNestingMarkers(
    `${createBlockNestingMarker(1)}\nx\n${createBlockNestingMarker(0)}`,
    async () => [{ type: 'paragraph' }]
  )
  return parsed[2]
}

type SpecItem = { marker: number } | { block: Block }

const REPLACE_OPENS: Record<string, [string, string] | undefined> = {
  default: undefined,
  marked: ['~TEXT~', '~UNCLOSED~']
}

const REPLACERS: Record<string, (source: string, whole: boolean, goes: boolean) => string> = {
  tag: (source, whole, goes) => `[${whole ? 'W' : 'w'}${goes ? 'B' : 'b'}:${source}]`,
  empty: () => ''
}

export const FNS: Record<string, (...args: never[]) => unknown> = {
  'emptyLines.splitMarkdownPreservingBlanks': (markdown: string) =>
    splitMarkdownPreservingBlanks(markdown),
  'emptyLines.assembleMarkdownWithBlanks': (segments: MarkdownSegment[]) =>
    assembleMarkdownWithBlanks(segments),
  'emptyLines.splitByCodeFences': (markdown: string) => splitByCodeFences(markdown),
  'emptyLines.separateBlockImages': (markdown: string) => separateBlockImages(markdown),
  'emptyLines.extractWikiImageEmbedRefs': (markdown: string) => extractWikiImageEmbedRefs(markdown),
  'emptyLines.rewriteWikiImageEmbeds': (markdown: string, stub: string) =>
    rewriteWikiImageEmbeds(markdown, resolveStub(stub)),
  'emptyLines.fenceIndentedCodeBlocks': (markdown: string) => fenceIndentedCodeBlocks(markdown),
  'emptyLines.normalizeSerializedMarkdown': fixed((markdown: string) =>
    normalizeSerializedMarkdown(markdown)
  ),
  'emptyLines.escapeWikiLinkPipesInTableRows': (markdown: string) =>
    escapeWikiLinkPipesInTableRows(markdown),

  'htmlComments.encodeHtmlCommentToken': fixed((source: string) => encodeHtmlCommentToken(source)),
  'htmlComments.hasHtmlCommentToken': fixed((text: string) => hasHtmlCommentToken(text)),
  'htmlComments.decodeHtmlCommentTokens': fixed((text: string) => decodeHtmlCommentTokens(text)),
  'htmlComments.splitHtmlCommentTokens': fixed((text: string) => splitHtmlCommentTokens(text)),
  'htmlComments.maskHtmlComments': fixed((markdown: string) => maskHtmlComments(markdown)),

  'hardBreaks.maskHardBreaks': (markdown: string) => maskHardBreaks(markdown),
  'hardBreaks.unmaskHardBreaks': (text: string) => unmaskHardBreaks(text),
  'hardBreaks.restoreHardBreakSpelling': (text: string, breaks: string[]) =>
    restoreHardBreakSpelling(text, breaks),
  'hardBreaks.hasHardBreakToken': (text: string) => hasHardBreakToken(text),
  /** mask, then unmask each line of the result: what a prose round trip does. */
  'hardBreaks.maskThenUnmask': (markdown: string) => {
    const masked = maskHardBreaks(markdown)
    return {
      masked,
      prose: unmaskHardBreaks(masked.markdown),
      code: restoreHardBreakSpelling(masked.markdown, masked.breaks)
    }
  },

  'blockNesting.createBlockNestingMarker': (level: number) => createBlockNestingMarker(level),
  'blockNesting.splitMarkdownByBlockNestingMarkers': (markdown: string) =>
    splitMarkdownByBlockNestingMarkers(markdown),
  'blockNesting.parseMarkdownWithNestingMarkers': async (markdown: string, stub: string) =>
    showBlocks(await parseMarkdownWithNestingMarkers(markdown, parseStub(stub))),
  'blockNesting.parseAndFold': async (markdown: string, stub: string) =>
    foldBlockNestingMarkers(await parseMarkdownWithNestingMarkers(markdown, parseStub(stub))),
  'blockNesting.restoreBlockNesting': (blocks: Block[], levels: number[]) =>
    restoreBlockNesting(blocks, levels),
  'blockNesting.foldSpec': async (items: SpecItem[]) => {
    const blocks: Block[] = []
    for (const item of items)
      blocks.push('marker' in item ? await makeMarker(item.marker) : item.block)
    return foldBlockNestingMarkers(blocks)
  },

  'linkReferences.normalizeLinkReferenceLabel': (label: string) =>
    normalizeLinkReferenceLabel(label),
  'linkReferences.stripLinkReferenceDefinitions': (markdown: string) =>
    stripLinkReferenceDefinitions(markdown),
  'linkReferences.inlineLinkReferences': (markdown: string, usages: LinkReferenceUsage[]) =>
    inlineLinkReferences(markdown, usages),
  'linkReferences.restoreLinkReferences': (
    markdown: string,
    definitions: LinkReferenceDefinition[],
    usages: LinkReferenceUsage[]
  ) => restoreLinkReferences(markdown, definitions, usages),
  /** strip, inline the usages, restore: the pipeline's whole use of the module. */
  'linkReferences.stripInlineRestore': (markdown: string) => {
    const stripped = stripLinkReferenceDefinitions(markdown)
    const inlined = inlineLinkReferences(stripped.markdown, stripped.usages)
    return {
      stripped,
      inlined,
      restored: restoreLinkReferences(inlined, stripped.definitions, stripped.usages)
    }
  },

  /** mask, decode and split: what a comment does on its way through the parser. */
  'htmlComments.maskDecodeSplit': fixed((markdown: string) => {
    const masked = maskHtmlComments(markdown)
    return {
      masked,
      decoded: decodeHtmlCommentTokens(masked),
      parts: splitHtmlCommentTokens(masked),
      has: hasHtmlCommentToken(masked)
    }
  }),

  'markdownCode.blankMarkdownCode': (markdown: string) => blankMarkdownCode(markdown),
  'markdownCode.maskMarkdownCode': (markdown: string) => maskMarkdownCode(markdown),
  'markdownCode.stripMarkdownComments': (markdown: string) => stripMarkdownComments(markdown),
  'markdownCode.replaceMarkdownComments': (markdown: string, replacer: string, opens: string) => {
    const open = REPLACE_OPENS[opens]
    const replace = REPLACERS[replacer]
    if (!replace) throw new Error(`unknown replacer: ${replacer}`)
    return open
      ? replaceMarkdownComments(markdown, replace, open[0], open[1])
      : replaceMarkdownComments(markdown, replace)
  },

  'tokenMasking.maskInlineTokens': (markdown: string) => maskInlineTokens(markdown),
  'tokenMasking.maskRestore': (markdown: string) => {
    const masked = maskInlineTokens(markdown)
    return { masked, restored: restoreInlineTokens(masked.markdown, masked.tokens) }
  },
  'tokenMasking.restoreInlineTokens': (text: string, tokens: string[]) =>
    restoreInlineTokens(text, tokens),

  'linkDestinations.linkDestination': (href: string) => linkDestination(href),
  'linkDestinations.withLinkDestination': (href: string, address: string) =>
    withLinkDestination(href, address),
  'linkDestinations.maskLinkDestinations': fixed((markdown: string) =>
    maskLinkDestinations(markdown)
  ),
  'linkDestinations.maskRestore': fixed((markdown: string) => {
    const masked = maskLinkDestinations(markdown)
    return { masked, restored: restoreLinkDestinations(masked.markdown, masked.destinations) }
  }),
  'linkDestinations.restoreLinkDestinations': fixed((text: string, destinations: string[]) =>
    restoreLinkDestinations(text, destinations)
  ),

  'linkCodeSpans.linkCodeAsText': (html: string) => linkCodeAsText(html),
  'linkCodeSpans.codeSpanRanges': (text: string) => codeSpanRanges(text),

  'cellCodeSpaces.maskCellCodeSpaces': (markdown: string) => maskCellCodeSpaces(markdown),
  'cellCodeSpaces.maskRestore': (markdown: string) => {
    const masked = maskCellCodeSpaces(markdown)
    return { masked, restored: restoreCellCodeSpaces(masked.markdown, masked.spaces) }
  },
  'cellCodeSpaces.restoreCellCodeSpaces': (text: string, spaces: string[]) =>
    restoreCellCodeSpaces(text, spaces)
}

export function textCases(external: MarkdownSource[]): OracleCase[] {
  return buildTextCases(external, FIXED_WORD)
}
