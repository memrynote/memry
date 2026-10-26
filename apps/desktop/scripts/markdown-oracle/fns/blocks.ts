/**
 * Layer `blocks` of stage 4 (#3522): function-level oracle cases for the
 * editor-schema block layers (callout types, `blocks/markdown.ts`, quote,
 * columns) and `@memry/shared/youtube`. `FNS` maps a name to the TypeScript
 * function the Rust port must reproduce (arguments and result are JSON);
 * `blocksCases` lists the cases of `layer-blocks.json`. Inputs only: the
 * expected output is whatever the TypeScript code returns.
 *
 * The callout registry is module state in TypeScript; every function that
 * reads it takes the custom type names as an argument and sets the registry
 * around the call. The async parse/serialize callbacks are the stubs of
 * `blocks-stubs.ts`, named in the case input.
 */
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'
import {
  CALLOUT_TYPE_NAME_REGEX,
  getCalloutTypeDefinitions,
  isBuiltInCalloutType,
  isCalloutTypeName,
  sanitizeCalloutTypeDefinitions,
  setCalloutTypeDefinitions
} from '../../../../../packages/editor-schema/src/blocks/callout-types'
import {
  BOOKMARK_LINE_REGEX,
  FILE_BLOCK_LINE_REGEX,
  calloutMarker,
  fileBlockCommentData,
  parseFileBlockMarker,
  parseWhiteboardLine,
  parseYoutubeEmbedLine,
  readCalloutRun,
  readMathRun,
  resolveCalloutRun,
  restoreDetailsMarkup,
  serializeBookmark,
  serializeCalloutBlock,
  serializeFileBlock,
  serializeMathBlock,
  serializeToggleBlock,
  serializeWhiteboard,
  serializeYoutubeEmbed,
  splitMarkdownByToggles,
  whiteboardUrl,
  type CalloutRun,
  type FileBlockProps,
  type ParsedBlockShape
} from '../../../../../packages/editor-schema/src/blocks/markdown'
import {
  itemHoldsNonList,
  readStructuredQuoteRun,
  resolveQuoteRun,
  serializeQuoteBlock,
  type QuoteRun
} from '../../../../../packages/editor-schema/src/blocks/quote'
import {
  buildColumnListBlock,
  columnRegionIdFor,
  columnSettingsFor,
  columnWidthsFromSettings,
  serializeColumnListBlock,
  serializeColumnRegion,
  splitMarkdownByColumnRegions,
  type ColumnRegionSegment
} from '../../../../../packages/editor-schema/src/blocks/columns'
import {
  extractYouTubeVideoId,
  getYouTubeThumbnailUrl
} from '../../../../../packages/shared/src/youtube'
import { makeStub, type StubSpec } from './blocks-stubs'
import { Builder } from './blocks-builder'
import { calloutQuoteMathCases } from './blocks-cases'
import { columnCases } from './blocks-cases-columns'
import { toggleFileEmbedCases } from './blocks-cases-toggle-file'

/** Run `fn` with exactly these custom callout type names defined. */
function withCustom<T>(names: string[], fn: () => T): T {
  setCalloutTypeDefinitions(
    names.map((name) => ({ name, label: name, color: '#000000', icon: 'x' }))
  )
  try {
    return fn()
  } finally {
    setCalloutTypeDefinitions([])
  }
}

async function withCustomAsync<T>(names: string[], fn: () => Promise<T>): Promise<T> {
  setCalloutTypeDefinitions(
    names.map((name) => ({ name, label: name, color: '#000000', icon: 'x' }))
  )
  try {
    return await fn()
  } finally {
    setCalloutTypeDefinitions([])
  }
}

function resolveCallout(run: CalloutRun, custom: string[], spec: StubSpec) {
  const stub = makeStub(spec)
  return withCustomAsync(custom, () => resolveCalloutRun(run, stub.parse, stub.serialize))
}

async function readAndResolveCallout(
  lines: string[],
  start: number,
  atStart: boolean,
  custom: string[],
  spec: StubSpec
) {
  const run = withCustom(custom, () => readCalloutRun(lines, start, atStart))
  if (!run) return null
  return resolveCallout(run, custom, spec)
}

function resolveQuote(run: QuoteRun, spec: StubSpec) {
  const stub = makeStub(spec)
  return resolveQuoteRun(run, stub.parse, stub.serialize)
}

async function readAndResolveQuote(lines: string[], start: number, spec: StubSpec) {
  const run = readStructuredQuoteRun(lines, start)
  return run ? resolveQuote(run, spec) : null
}

/** Every reader at every line of a whole document, the way the pipeline walks it. */
async function scanAll(markdown: string, custom: string[]) {
  const lines = markdown.split('\n')
  const spec: StubSpec = { kind: 'mini' }
  const callouts: unknown[] = []
  const quotes: unknown[] = []
  const math: unknown[] = []
  const markers: unknown[] = []
  for (let i = 0; i < lines.length; i++) {
    const atStart = i === 0 || lines[i - 1].trim() === ''
    const callout = withCustom(custom, () => readCalloutRun(lines, i, atStart))
    if (callout) {
      callouts.push({ i, run: callout, resolved: await resolveCallout(callout, custom, spec) })
    }
    const quote = readStructuredQuoteRun(lines, i)
    if (quote) quotes.push({ i, run: quote, resolved: await resolveQuote(quote, spec) })
    const run = readMathRun(lines, i, atStart)
    if (run) math.push({ i, run })
    const trimmed = lines[i].trim()
    if (FILE_BLOCK_LINE_REGEX.test(trimmed)) {
      markers.push({ i, kind: 'file', props: parseFileBlockMarker(trimmed) })
    }
    const bookmark = lines[i].match(BOOKMARK_LINE_REGEX)
    if (bookmark) markers.push({ i, kind: 'bookmark', url: bookmark[1] })
    const youtube = parseYoutubeEmbedLine(lines[i])
    if (youtube) markers.push({ i, kind: 'youtube', ...youtube })
    const canvas = parseWhiteboardLine(lines[i])
    if (canvas) markers.push({ i, kind: 'whiteboard', canvasId: canvas })
  }
  return { callouts, quotes, math, markers }
}

function counterIds(): () => string {
  let n = 0
  return () => `id-${++n}`
}

const EMPTY_PARAGRAPH = () => ({ type: 'paragraph', props: {}, content: [], children: [] })

function buildColumns(segment: ColumnRegionSegment, spec: StubSpec, ids: boolean) {
  const stub = makeStub(spec)
  return buildColumnListBlock<unknown>(
    segment,
    (markdown) => stub.parse(markdown),
    EMPTY_PARAGRAPH,
    ids ? counterIds() : undefined
  )
}

function serializeColumns(block: Parameters<typeof serializeColumnListBlock>[0], spec: StubSpec) {
  const stub = makeStub(spec)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stub serializes the blocks the column holds
  return serializeColumnListBlock<ParsedBlockShape>(block, (blocks) => stub.serialize(blocks))
}

export const FNS: Record<string, (...args: never[]) => unknown> = {
  'calloutTypes.sanitize': (raw: unknown) => sanitizeCalloutTypeDefinitions(raw),
  'calloutTypes.isName': (name: string, custom: string[]) =>
    withCustom(custom, () => isCalloutTypeName(name)),
  'calloutTypes.isBuiltIn': (name: string) => isBuiltInCalloutType(name),
  'calloutTypes.isNameSyntax': (name: string) => CALLOUT_TYPE_NAME_REGEX.test(name),
  'calloutTypes.definitions': (definitions: Parameters<typeof setCalloutTypeDefinitions>[0]) => {
    setCalloutTypeDefinitions(definitions)
    try {
      return getCalloutTypeDefinitions()
    } finally {
      setCalloutTypeDefinitions([])
    }
  },

  'callout.marker': (type: string, fold: string | null) => calloutMarker(type, fold ?? undefined),
  'callout.serialize': (type: string, content: string, fold: string | null) =>
    serializeCalloutBlock(type, content, fold ?? undefined),
  'callout.read': (lines: string[], start: number, atStart: boolean, custom: string[]) =>
    withCustom(custom, () => readCalloutRun(lines, start, atStart)),
  'callout.resolve': resolveCallout,
  'callout.readAndResolve': readAndResolveCallout,

  'quote.serialize': (inner: string) => serializeQuoteBlock(inner),
  'quote.read': (lines: string[], start: number) => readStructuredQuoteRun(lines, start),
  'quote.resolve': resolveQuote,
  'quote.readAndResolve': readAndResolveQuote,
  'quote.itemHoldsNonList': (block: ParsedBlockShape) => itemHoldsNonList(block),

  'math.serialize': (latex: string) => serializeMathBlock(latex),
  'math.read': (lines: string[], start: number, atStart: boolean) =>
    readMathRun(lines, start, atStart),

  'toggle.serialize': (summary: string, body: string, colorsMarker: string | null, open: boolean) =>
    serializeToggleBlock(summary, body, colorsMarker, open),
  'toggle.split': (markdown: string) => splitMarkdownByToggles(markdown),
  'toggle.restore': (text: string) => restoreDetailsMarkup(text),

  'file.parse': (marker: string) => parseFileBlockMarker(marker),
  'file.isLine': (line: string) => FILE_BLOCK_LINE_REGEX.test(line),
  'file.serialize': (props: FileBlockProps) => serializeFileBlock(props),
  'file.commentData': (props: FileBlockProps) => fileBlockCommentData(props),

  'embeds.bookmarkUrl': (line: string) => line.match(BOOKMARK_LINE_REGEX)?.[1] ?? null,
  'embeds.parseYoutube': (line: string) => parseYoutubeEmbedLine(line),
  'embeds.parseWhiteboard': (line: string) => parseWhiteboardLine(line),
  'embeds.serializeYoutube': (url: string, alt: string | null) =>
    serializeYoutubeEmbed(url, alt ?? undefined),
  'embeds.serializeBookmark': (url: string) => serializeBookmark(url),
  'embeds.serializeWhiteboard': (id: string) => serializeWhiteboard(id),
  'embeds.whiteboardUrl': (id: string) => whiteboardUrl(id),

  'youtube.extractId': (url: string) => extractYouTubeVideoId(url),
  'youtube.thumbnail': (id: string) => getYouTubeThumbnailUrl(id),

  'columns.split': (markdown: string) => splitMarkdownByColumnRegions(markdown),
  'columns.widths': (settings: string, count: number) => columnWidthsFromSettings(settings, count),
  'columns.settingsFor': (settings: string, widths: number[]) =>
    columnSettingsFor(settings, widths),
  'columns.regionIdFor': (regionId: string, blockId: string | null) =>
    columnRegionIdFor(regionId, blockId ?? undefined),
  'columns.serializeRegion': (regionId: string, settings: string, bodies: string[]) =>
    serializeColumnRegion(regionId, settings, bodies),
  'columns.build': buildColumns,
  'columns.serializeList': serializeColumns,

  'scan.all': scanAll
}

export function blocksCases(external: MarkdownSource[]): OracleCase[] {
  const builder = new Builder()
  calloutQuoteMathCases(builder)
  toggleFileEmbedCases(builder)
  columnCases(builder)
  const cases = builder.cases
  external.forEach((source, index) => {
    const slug = `src-${String(index).padStart(4, '0')}`
    cases.push(
      {
        id: `scan/fn/${slug}`,
        op: 'fn',
        input: { fn: 'scan.all', args: [source.markdown, ['danger']] }
      },
      {
        id: `toggles/fn/split-${slug}`,
        op: 'fn',
        input: { fn: 'toggle.split', args: [source.markdown] }
      },
      {
        id: `columns/fn/split-${slug}`,
        op: 'fn',
        input: { fn: 'columns.split', args: [source.markdown] }
      }
    )
  })
  return cases
}
