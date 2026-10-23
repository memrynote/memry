/**
 * Pure fold engine: Markdown -> sections/chunks, hashing, local fallback,
 * prompt + response schema, and assembly of the `FoldLayers` snapshot.
 * No I/O. The service (fold-service.ts) owns queue, cache and model calls.
 *
 * The layered-summary idea follows github.com/chenxiachan/textfold
 * (Apache-2.0); the code here is original.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  FOLD_MIN_WORDS,
  type FoldLayers,
  type FoldLevel,
  type FoldParagraph,
  type FoldSection
} from '@memry/contracts/note-fold'

/** ~tokens per chunk before a long section is split at a paragraph boundary. */
export const CHUNK_TOKEN_BUDGET = 600
/** CJK counts characters, not words; this is the foldable threshold in that unit. */
export const CJK_MIN_UNITS = FOLD_MIN_WORDS * 2

const CJK_LANGUAGES = new Set(['zh', 'ja', 'ko'])

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

// ---------------------------------------------------------------------------
// Language and segmentation
// ---------------------------------------------------------------------------

/** Script-based tag: enough to pick a segmenter and word budget, not a locale. */
export function detectLanguage(text: string): string {
  let han = 0
  let kana = 0
  let hangul = 0
  let cyrillic = 0
  let arabic = 0
  let letters = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c >= 0x3040 && c <= 0x30ff) kana++
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) han++
    else if (c >= 0xac00 && c <= 0xd7af) hangul++
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic++
    else if (c >= 0x0600 && c <= 0x06ff) arabic++
    else if (/\p{L}/u.test(ch)) letters++
  }
  const total = han + kana + hangul + cyrillic + arabic + letters
  if (total === 0) return 'und'
  if (kana / total > 0.1) return 'ja'
  if (hangul / total > 0.3) return 'ko'
  if (han / total > 0.3) return 'zh'
  if (cyrillic / total > 0.5) return 'ru'
  if (arabic / total > 0.5) return 'ar'
  return 'en'
}

export const isCjk = (language: string): boolean => CJK_LANGUAGES.has(language)

const segmenterCache = new Map<string, Intl.Segmenter>()
function segmenter(language: string, granularity: 'sentence' | 'word'): Intl.Segmenter {
  const key = `${language}:${granularity}`
  let seg = segmenterCache.get(key)
  if (!seg) {
    seg = new Intl.Segmenter(language === 'und' ? 'en' : language, { granularity })
    segmenterCache.set(key, seg)
  }
  return seg
}

export function splitSentences(text: string, language: string): string[] {
  const out: string[] = []
  for (const { segment } of segmenter(language, 'sentence').segment(text)) {
    const s = segment.trim()
    if (s) out.push(s)
  }
  return out
}

/** Words for Latin-like scripts; non-space, non-punctuation characters for CJK. */
export function countWords(text: string, language: string): number {
  if (isCjk(language)) return (text.match(/[^\s\p{P}\p{S}]/gu) ?? []).length
  let n = 0
  for (const seg of segmenter(language, 'word').segment(text)) if (seg.isWordLike) n++
  return n
}

export function estimateTokens(text: string, language: string): number {
  return isCjk(language) ? countWords(text, language) : Math.ceil(countWords(text, language) * 1.4)
}

export function isFoldable(text: string, language: string): boolean {
  return isCjk(language)
    ? countWords(text, language) > CJK_MIN_UNITS
    : countWords(text, language) > FOLD_MIN_WORDS
}

// ---------------------------------------------------------------------------
// Markdown -> sections
// ---------------------------------------------------------------------------

export interface ParsedParagraph {
  hash: string
  text: string
  sentences: string[]
}

export interface ParsedChunk {
  /** Hash of heading + paragraph hashes; the cache key (with language + model). */
  hash: string
  heading: string | null
  paragraphs: ParsedParagraph[]
}

export interface ParsedSection {
  heading: string | null
  chunks: ParsedChunk[]
}

const stripInline = (line: string): string =>
  line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

interface RawSection {
  heading: string | null
  paragraphs: string[]
}

/**
 * Splits a Markdown body into sections of plain paragraphs. Code, tables,
 * images, callouts and HTML blocks are skipped: folded views are plain text.
 */
export function parseSections(markdown: string): RawSection[] {
  const body = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const sections: RawSection[] = []
  let current: RawSection = { heading: null, paragraphs: [] }
  let buffer: string[] = []
  let fence: string | null = null
  let skipBlock = false

  const flush = (): void => {
    if (buffer.length > 0) {
      const text = stripInline(buffer.join(' '))
      if (text) current.paragraphs.push(text)
    }
    buffer = []
    skipBlock = false
  }
  const startSection = (heading: string): void => {
    flush()
    if (current.heading !== null || current.paragraphs.length > 0) sections.push(current)
    current = { heading, paragraphs: [] }
  }

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      if (fenceMatch && line.trim().startsWith(fence)) fence = null
      continue
    }
    if (fenceMatch) {
      flush()
      fence = fenceMatch[1]
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      startSection(stripInline(heading[1]))
      continue
    }
    if (/^\s*\|/.test(line) || /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) {
      flush()
      continue
    }
    if (/^\s*>\s*\[!/.test(line)) {
      flush()
      skipBlock = true
      continue
    }
    if (skipBlock) continue
    buffer.push(
      line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/^\s*>\s?/, '')
    )
  }
  flush()
  if (current.heading !== null || current.paragraphs.length > 0) sections.push(current)
  return sections
}

/** Heading + paragraphs, split at paragraph boundaries past the token budget. */
export function buildSections(markdown: string, language: string): ParsedSection[] {
  return parseSections(markdown)
    .map((raw): ParsedSection => {
      const paragraphs = raw.paragraphs.map((text): ParsedParagraph => ({
        hash: sha256(text.normalize('NFC')),
        text,
        sentences: splitSentences(text, language)
      }))
      const groups: ParsedParagraph[][] = []
      let group: ParsedParagraph[] = []
      let tokens = 0
      for (const p of paragraphs) {
        const t = estimateTokens(p.text, language)
        if (group.length > 0 && tokens + t > CHUNK_TOKEN_BUDGET) {
          groups.push(group)
          group = []
          tokens = 0
        }
        group.push(p)
        tokens += t
      }
      if (group.length > 0) groups.push(group)
      return {
        heading: raw.heading,
        chunks: groups.map((g, i) => ({
          hash: sha256(
            [i === 0 ? (raw.heading ?? '') : '', ...g.map((p) => p.hash)].join('\u0000')
          ),
          heading: i === 0 ? raw.heading : null,
          paragraphs: g
        }))
      }
    })
    .filter((s) => s.chunks.length > 0)
}

// ---------------------------------------------------------------------------
// Model contract: prompt + response schema
// ---------------------------------------------------------------------------

export interface ChunkParagraphAi {
  /** Source sentence indices, in order, that make the Brief line. */
  brief: number[]
  key: { takeaway: string; reason: string }
  takeaway: string
  topic: string
  /** Source sentence indices the AI lines rest on. */
  evidence: number[]
}

export interface ChunkAi {
  sectionTakeaway: string
  paragraphs: ChunkParagraphAi[]
}

const idx = z.number().int().nonnegative()
const rawChunkAiSchema = z.object({
  sectionTakeaway: z.string().trim().min(1),
  paragraphs: z.array(
    z.object({
      brief: z.array(idx).min(1),
      key: z.object({ takeaway: z.string().trim().min(1), reason: z.string().trim().min(1) }),
      takeaway: z.string().trim().min(1),
      topic: z.string().trim().min(1),
      evidence: z.array(idx)
    })
  )
})

/** Zod schema for one chunk's reply: shape, paragraph count and sentence indices. */
export function chunkAiSchema(chunk: ParsedChunk): z.ZodType<ChunkAi> {
  return rawChunkAiSchema.superRefine((value, ctx) => {
    if (value.paragraphs.length !== chunk.paragraphs.length) {
      ctx.addIssue({
        code: 'custom',
        message: `expected ${chunk.paragraphs.length} paragraphs, got ${value.paragraphs.length}`
      })
      return
    }
    value.paragraphs.forEach((p, i) => {
      const count = chunk.paragraphs[i].sentences.length
      if ([...p.brief, ...p.evidence].some((n) => n >= count)) {
        ctx.addIssue({ code: 'custom', message: `paragraph ${i}: sentence index out of range` })
      }
    })
  }) as z.ZodType<ChunkAi>
}

export function buildChunkPrompt(chunk: ParsedChunk, language: string): string {
  const lines = [
    'You summarize one section of a note at several levels of detail.',
    `Write every summary line in the note's own language (${language}). Never translate.`,
    'Reply with ONLY one JSON object, no prose, no code fence, shaped exactly:',
    '{"sectionTakeaway": string, "paragraphs": [{"brief": number[], "key": {"takeaway": string, "reason": string}, "takeaway": string, "topic": string, "evidence": number[]}]}',
    'Rules:',
    '- "paragraphs" has exactly one entry per source paragraph, in order.',
    '- "brief": 0-based indices of the source sentences that best carry the paragraph; they are shown verbatim.',
    '- "key": takeaway = the claim in one sentence; reason = why it holds or matters, one sentence.',
    '- "takeaway": one short line. "topic": 2-5 words naming the paragraph.',
    '- "sectionTakeaway": one sentence for the whole section.',
    '- "evidence": 0-based indices of the sentences your lines rest on.',
    '- Use only what the text says. No new facts.',
    '',
    `Section heading: ${chunk.heading ?? '(none)'}`,
    ''
  ]
  chunk.paragraphs.forEach((p, i) => {
    lines.push(`Paragraph ${i}:`)
    p.sentences.forEach((s, j) => lines.push(`  [${j}] ${s}`))
  })
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Local fallback
// ---------------------------------------------------------------------------

/** First or most claim-like sentence. Deterministic, language-neutral. */
export function localBriefIdx(sentences: string[], language: string): number[] {
  if (sentences.length === 0) return []
  let best = 0
  let bestScore = -Infinity
  sentences.forEach((s, i) => {
    const words = countWords(s, language)
    const lo = isCjk(language) ? 8 : 6
    const hi = isCjk(language) ? 60 : 30
    const score =
      (i === 0 ? 2 : 0) +
      (/[?？]\s*$/.test(s) ? -2 : 0) +
      (words >= lo && words <= hi ? 1 : 0) +
      (/\d/.test(s) ? 0.5 : 0)
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  })
  return [best]
}

export function truncateUnits(text: string, language: string, units: number): string {
  const t = text.trim()
  if (isCjk(language)) {
    const chars = [...t]
    return chars.length <= units * 2 ? t : `${chars.slice(0, units * 2).join('')}…`
  }
  const words = t.split(/\s+/)
  return words.length <= units ? t : `${words.slice(0, units).join(' ')}…`
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export type ChunkLookup = (chunk: ParsedChunk) => ChunkAi | undefined

function buildParagraph(
  p: ParsedParagraph,
  ai: ChunkParagraphAi | undefined,
  lang: string
): FoldParagraph {
  const first = p.sentences[0] ?? p.text
  return {
    hash: p.hash,
    text: p.text,
    sentences: p.sentences,
    briefIdx: ai ? ai.brief : localBriefIdx(p.sentences, lang),
    key: ai ? ai.key : null,
    takeaway: ai ? ai.takeaway : truncateUnits(first, lang, 12),
    topic: ai ? ai.topic : truncateUnits(first, lang, 4),
    evidence: ai ? ai.evidence : []
  }
}

/** Words a level shows. Full is the whole text; the others sum their visible lines. */
export function levelWords(sections: FoldSection[], level: FoldLevel, language: string): number {
  const w = (t: string | null): number => (t ? countWords(t, language) : 0)
  let total = 0
  for (const s of sections) {
    if (level === 'topic') total += w(s.heading) + w(s.takeaway)
    for (const p of s.paragraphs) {
      if (level === 'brief') total += p.briefIdx.reduce((n, i) => n + w(p.sentences[i] ?? ''), 0)
      else if (level === 'key') total += w(p.key?.takeaway ?? null) + w(p.key?.reason ?? null)
      else if (level === 'takeaway') total += w(p.takeaway)
      else if (level === 'topic') total += w(p.topic)
      else total += w(p.text)
    }
  }
  return total
}

export interface AssembleInput {
  noteId: string
  source: string
  language: string
  sections: ParsedSection[]
  lookup: ChunkLookup
}

export interface Assembled {
  layers: Omit<FoldLayers, 'status' | 'agent'>
  /** Chunks the model has not written for this text yet. */
  missing: ParsedChunk[]
}

export function assemble(input: AssembleInput): Assembled {
  const { language } = input
  const missing: ParsedChunk[] = []
  const sections: FoldSection[] = input.sections.map((section) => {
    const paragraphs: FoldParagraph[] = []
    const takeaways: string[] = []
    for (const chunk of section.chunks) {
      const ai = input.lookup(chunk)
      if (!ai) missing.push(chunk)
      chunk.paragraphs.forEach((p, i) =>
        paragraphs.push(buildParagraph(p, ai?.paragraphs[i], language))
      )
      if (ai) takeaways.push(ai.sectionTakeaway)
    }
    const fallback = paragraphs[0] ? (paragraphs[0].takeaway ?? null) : null
    return {
      hash: sha256([section.heading ?? '', ...section.chunks.map((c) => c.hash)].join('\u0000')),
      heading: section.heading,
      takeaway: takeaways.length === section.chunks.length ? takeaways.join(' ') : fallback,
      paragraphs
    }
  })

  const totalWords = countWords(input.source, language)
  const aiLevels: FoldLevel[] =
    missing.length === 0 && sections.length > 0 ? ['key', 'takeaway', 'topic'] : []
  const levels: FoldLevel[] = ['full', 'brief', 'key', 'takeaway', 'topic']
  const wordsByLevel = Object.fromEntries(
    levels.map((l) => [l, l === 'full' ? totalWords : levelWords(sections, l, language)])
  ) as FoldLayers['wordsByLevel']

  return {
    layers: {
      noteId: input.noteId,
      sourceHash: sha256(input.source),
      language,
      totalWords,
      wordsByLevel,
      sections,
      ready: aiLevels
    },
    missing
  }
}
