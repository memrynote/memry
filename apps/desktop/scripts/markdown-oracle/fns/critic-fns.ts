/**
 * The functions of `critic-markup/{parser,transforms}.ts`,
 * `writing-tools/markdown.ts` and `editor-schema/lift-images.ts` as the oracle
 * serves them. Maps and sets become sorted JSON objects and arrays, marks get
 * one key order, and `undefined` results become `null`.
 */
import { liftImagesOutOfTextBlocks } from '../../../../../packages/editor-schema/src/lift-images'
import {
  buildCommentPayload,
  criticMarkupCommentBodyHash,
  normalizeCriticMarkupCommentAttachments,
  normalizeCriticMarkupCommentFormatRanges,
  normalizeCriticMarkupCommentMentions,
  parseCriticMarkup,
  parseCriticMarkupCommentFormat,
  serializeCriticMarkup,
  type CriticMarkupMark,
  type ParsedCriticMarkup
} from '../../../../../packages/shared/src/critic-markup/parser'
import {
  acceptCriticMark,
  deleteCriticMark,
  rejectCriticMark,
  resolveCriticMark
} from '../../../../../packages/shared/src/critic-markup/transforms'
import {
  createSentinelAllocator,
  decodeWritingMarkers,
  encodeWritingBody,
  isWritingAlternativeId,
  isWritingFrontmatterValue,
  readWritingFrontmatter,
  stripWritingSentinels,
  toWritingFrontmatterValue,
  withoutWritingSentinels,
  writingFrontmatterOf,
  type WritingFrontmatter,
  type WritingMarker,
  type WritingSentinelMap
} from '../../../../../packages/shared/src/writing-tools/markdown'

type SentinelObject = Record<string, WritingMarker>

const MARK_KEYS = [
  'id',
  'kind',
  'visibleText',
  'originalText',
  'body',
  'metadata',
  'createdAt',
  'mentions',
  'attachments',
  'formatRanges',
  'start',
  'end'
] as const

function canonMark(mark: CriticMarkupMark): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of MARK_KEYS) if (mark[key] !== undefined) out[key] = mark[key]
  return out
}

function canonTransform(result: { plainText: string; marks: CriticMarkupMark[] }) {
  return { plainText: result.plainText, marks: result.marks.map(canonMark) }
}

function toMap(object: SentinelObject): WritingSentinelMap {
  return new Map(Object.entries(object))
}

function fromMap(map: WritingSentinelMap): SentinelObject {
  const out: SentinelObject = {}
  for (const key of [...map.keys()].toSorted()) {
    const marker = map.get(key)
    if (marker) out[key] = { kind: marker.kind, key: marker.key, open: marker.open }
  }
  return out
}

/** `undefined` is not JSON; the Rust side reads `null` as `None`. */
function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

export const CRITIC_FNS = {
  'critic.parseCriticMarkup': (markdown: string) => {
    const parsed = parseCriticMarkup(markdown)
    return { plainText: parsed.plainText, marks: parsed.marks.map(canonMark) }
  },
  'critic.serializeCriticMarkup': (plainText: string, marks: CriticMarkupMark[]) =>
    serializeCriticMarkup(plainText, marks),
  'critic.buildCommentPayload': (mark: CriticMarkupMark) => buildCommentPayload(mark),
  'critic.normalizeMentions': (value: unknown) =>
    orNull(normalizeCriticMarkupCommentMentions(value)),
  'critic.normalizeAttachments': (value: unknown) =>
    orNull(normalizeCriticMarkupCommentAttachments(value)),
  'critic.normalizeFormatRanges': (value: unknown, bodyLength: number) =>
    orNull(normalizeCriticMarkupCommentFormatRanges(value, bodyLength)),
  'critic.parseCommentFormat': (encoded: string | null, body: string) =>
    orNull(parseCriticMarkupCommentFormat(encoded ?? undefined, body)),
  'critic.bodyHash': (body: string) => criticMarkupCommentBodyHash(body),
  'critic.acceptCriticMark': (plainText: string, marks: CriticMarkupMark[], id: string) =>
    canonTransform(acceptCriticMark(plainText, marks, id)),
  'critic.rejectCriticMark': (plainText: string, marks: CriticMarkupMark[], id: string) =>
    canonTransform(rejectCriticMark(plainText, marks, id)),
  'critic.resolveCriticMark': (plainText: string, marks: CriticMarkupMark[], id: string) =>
    canonTransform(resolveCriticMark(plainText, marks, id)),
  'critic.deleteCriticMark': (plainText: string, marks: CriticMarkupMark[], id: string) =>
    canonTransform(deleteCriticMark(plainText, marks, id)),

  'writing.decodeWritingMarkers': (markdown: string) => {
    const decoded = decodeWritingMarkers(markdown)
    return { text: decoded.text, sentinels: fromMap(decoded.sentinels) }
  },
  'writing.stripWritingSentinels': (text: string, sentinels: SentinelObject) =>
    stripWritingSentinels(text, toMap(sentinels)),
  'writing.withoutWritingSentinels': (parsed: ParsedCriticMarkup, sentinels: SentinelObject) => {
    const out = withoutWritingSentinels(parsed, toMap(sentinels))
    return { plainText: out.plainText, marks: out.marks.map(canonMark) }
  },
  'writing.encodeWritingBody': (
    text: string,
    sentinels: SentinelObject,
    marks: CriticMarkupMark[]
  ) => encodeWritingBody(text, toMap(sentinels), marks),
  'writing.createSentinelAllocator': (taken: string, count: number) => {
    const allocate = createSentinelAllocator(taken)
    return Array.from({ length: count }, () => allocate())
  },
  'writing.isWritingAlternativeId': (value: string) => isWritingAlternativeId(value),
  'writing.readWritingFrontmatter': (value: unknown) => readWritingFrontmatter(value),
  'writing.writingFrontmatterOf': (frontmatter: Record<string, unknown> | null) =>
    writingFrontmatterOf(frontmatter),
  'writing.isWritingFrontmatterValue': (value: unknown) => isWritingFrontmatterValue(value),
  'writing.toWritingFrontmatterValue': (writing: WritingFrontmatter) =>
    orNull(toWritingFrontmatterValue(writing)),

  'liftImages.liftImagesOutOfTextBlocks': (html: string) => liftImagesOutOfTextBlocks(html),
  /** BlockNote's HTML for the markdown, and the lift of it. The Rust test lifts the `html` it reads back. */
  'liftImages.liftFromMarkdown': async (markdown: string) => {
    // Loads only under Vitest; the case generator imports this module in plain Node.
    const { markdownToHTML } = await import('@blocknote/core')
    const html = markdownToHTML(markdown)
    return { html, lifted: liftImagesOutOfTextBlocks(html) }
  }
}
