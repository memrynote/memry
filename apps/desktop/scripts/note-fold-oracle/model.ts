/**
 * `note-fold-model.json`: the model levels of the fold (Key, Takeaway, Topic),
 * for each folding document of `doc-cases.ts`:
 * - `local`: `assemble` with no model lines (the fallback lines and their word maps);
 * - `written`: `assemble` with the lines of `fakeReply` for every chunk but each
 *   third one, which stays missing;
 * - `prompts`: `buildChunkPrompt` of each chunk.
 * `replies` runs `chunkAiSchema(chunk).safeParse` over hand-made model replies.
 * A case's markdown is the one of the same name in `note-fold.json`.
 * Checked by `crates/memry-desktop/tests/note_fold_model_vectors.rs`.
 */
import {
  assemble,
  buildChunkPrompt,
  buildSections,
  chunkAiSchema,
  detectLanguage,
  isFoldable,
  type ChunkAi,
  type ParsedChunk,
  type ParsedSection
} from '../../src/main/note-fold/engine'
import type { FoldLayers } from '@memry/contracts/note-fold'

import { expandInlineTokens, withoutInlineTokens } from '../../src/main/note-fold/engine-tokens'

import { NOTE_FOLD_CASES } from './doc-cases'

/** Model lines made from the chunk's own sentences, so most of their words map to the source. */
export function fakeReply(chunk: ParsedChunk): ChunkAi {
  return {
    sectionTakeaway: `${chunk.heading ?? 'Untitled'}: ${chunk.paragraphs.length} paragraphs`,
    paragraphs: chunk.paragraphs.map((p) => {
      const n = p.sentences.length
      const first = p.sentences[0] ?? p.text
      const last = p.sentences[n - 1] ?? p.text
      const words = first.split(/\s+/)
      return {
        brief: n > 1 ? [n - 1, 0] : [0],
        key: { takeaway: first, reason: `Because ${last}` },
        takeaway: first.toUpperCase(),
        topic: words.slice(0, 3).toReversed().join(' '),
        evidence: n > 1 ? [0, n - 1] : [0]
      }
    })
  }
}

function prepare(markdown: string): {
  language: string
  source: string
  sections: ParsedSection[]
} {
  const language = detectLanguage(withoutInlineTokens(markdown))
  const source = expandInlineTokens(markdown, language)
  const sections = isFoldable(source, language) ? buildSections(source, language) : []
  return { language, source, sections }
}

/** What the model levels add to a snapshot; the rest is in `note-fold.json`. */
function modelFields(layers: Omit<FoldLayers, 'status' | 'agent'>): Record<string, unknown> {
  return {
    wordsByLevel: layers.wordsByLevel,
    ready: layers.ready,
    sections: layers.sections.map((s) => ({
      takeaway: s.takeaway,
      paragraphs: s.paragraphs.map((p) => ({
        briefIdx: p.briefIdx,
        key: p.key,
        takeaway: p.takeaway,
        topic: p.topic,
        evidence: p.evidence,
        // `<src>|<text>` per token (`src` empty when the word is not in the source), to keep the file small.
        morph: Object.fromEntries(
          Object.entries(p.morph).map(([line, tokens]) => [
            line,
            tokens?.map((t) => `${t.src ?? ''}|${t.text}`) ?? null
          ])
        )
      }))
    }))
  }
}

function foldCase(markdown: string): Record<string, unknown> {
  const { language, source, sections } = prepare(markdown)
  const chunks = sections.flatMap((s) => s.chunks)
  const local = assemble({ noteId: 'note', source, language, sections, lookup: () => undefined })
  const written = assemble({
    noteId: 'note',
    source,
    language,
    sections,
    lookup: (chunk) => (chunks.indexOf(chunk) % 3 === 1 ? undefined : fakeReply(chunk))
  })
  return {
    local: modelFields(local.layers),
    written: { ...modelFields(written.layers), missing: written.missing.map((c) => c.hash) },
    prompts: chunks.map((chunk) => buildChunkPrompt(chunk, language))
  }
}

/** The document whose first chunk the replies answer: four paragraphs, no heading. */
const REPLY_DOC = 'en-paragraphs'

const REPLY_CASES: Array<{ name: string; reply: (good: ChunkAi) => unknown }> = [
  { name: 'valid', reply: (good) => good },
  {
    name: 'trimmed-and-extra-keys',
    reply: (good) => ({
      ...good,
      extra: true,
      sectionTakeaway: `  ${good.sectionTakeaway}\n`,
      paragraphs: good.paragraphs.map((p) => ({
        ...p,
        note: 'x',
        topic: `\u00a0${p.topic}\t`,
        key: { ...p.key, reason: ` ${p.key.reason} `, more: 1 }
      }))
    })
  },
  { name: 'blank-section-takeaway', reply: (good) => ({ ...good, sectionTakeaway: ' \n ' }) },
  { name: 'missing-paragraphs', reply: (good) => ({ sectionTakeaway: good.sectionTakeaway }) },
  {
    name: 'one-paragraph-short',
    reply: (good) => ({ ...good, paragraphs: good.paragraphs.slice(1) })
  },
  {
    name: 'empty-brief',
    reply: (good) => ({ ...good, paragraphs: good.paragraphs.map((p) => ({ ...p, brief: [] })) })
  },
  {
    name: 'empty-evidence',
    reply: (good) => ({ ...good, paragraphs: good.paragraphs.map((p) => ({ ...p, evidence: [] })) })
  },
  {
    name: 'brief-out-of-range',
    reply: (good) => ({ ...good, paragraphs: good.paragraphs.map((p) => ({ ...p, brief: [99] })) })
  },
  {
    name: 'evidence-out-of-range',
    reply: (good) => ({
      ...good,
      paragraphs: good.paragraphs.map((p, i) => (i === 0 ? { ...p, evidence: [5000000000] } : p))
    })
  },
  {
    name: 'fractional-index',
    reply: (good) => ({ ...good, paragraphs: good.paragraphs.map((p) => ({ ...p, brief: [0.5] })) })
  },
  {
    name: 'negative-index',
    reply: (good) => ({
      ...good,
      paragraphs: good.paragraphs.map((p) => ({ ...p, evidence: [-1] }))
    })
  },
  {
    name: 'string-index',
    reply: (good) => ({ ...good, paragraphs: good.paragraphs.map((p) => ({ ...p, brief: ['0'] })) })
  },
  {
    name: 'null-key',
    reply: (good) => ({ ...good, paragraphs: good.paragraphs.map((p) => ({ ...p, key: null })) })
  },
  {
    name: 'missing-topic',
    reply: (good) => ({
      ...good,
      paragraphs: good.paragraphs.map(({ topic: _topic, ...p }) => p)
    })
  },
  { name: 'not-an-object', reply: () => [1, 2] }
]

function replies(): Array<Record<string, unknown>> {
  const doc = NOTE_FOLD_CASES.find((c) => c.name === REPLY_DOC)
  if (!doc) throw new Error(`no document ${REPLY_DOC}`)
  const chunk = prepare(doc.markdown).sections.flatMap((s) => s.chunks)[0]
  return REPLY_CASES.map(({ name, reply: make }) => {
    const reply = make(fakeReply(chunk))
    const parsed = chunkAiSchema(chunk).safeParse(reply)
    return { name, reply, accepted: parsed.success, value: parsed.success ? parsed.data : null }
  })
}

export function buildModel(): Record<string, unknown> {
  return {
    replyDocument: REPLY_DOC,
    replies: replies(),
    cases: NOTE_FOLD_CASES.filter((c) => prepare(c.markdown).sections.length > 0).map((c) => ({
      name: c.name,
      expected: foldCase(c.markdown)
    }))
  }
}
