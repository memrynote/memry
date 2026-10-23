import { describe, expect, it } from 'vitest'

import { FOLD_MIN_WORDS } from '@memry/contracts/note-fold'

import { FoldLayersSchema } from '@memry/contracts/note-fold'

import { assemble, buildSections, chunkAiSchema, detectLanguage, isFoldable } from './engine'

const sentence = (n: number): string => `Sentence number ${n} talks about topic ${n} in detail.`
const para = (start: number, count = 4): string =>
  Array.from({ length: count }, (_, i) => sentence(start + i)).join(' ')

describe('fold engine', () => {
  it('splits headings into sections and skips code, tables and images', () => {
    const md = [
      '---',
      'tags: [a]',
      '---',
      'Intro paragraph one. Second sentence here.',
      '',
      '## Part',
      '```js',
      'const hidden = 1',
      '```',
      '| a | b |',
      '![img](x.png)',
      'Body of the part with a [link](http://x) and **bold**.'
    ].join('\n')
    const sections = buildSections(md, 'en')
    expect(sections.map((s) => s.heading)).toEqual([null, 'Part'])
    const texts = sections.flatMap((s) => s.chunks.flatMap((c) => c.paragraphs.map((p) => p.text)))
    expect(texts).toEqual([
      'Intro paragraph one. Second sentence here.',
      'Body of the part with a link and bold.'
    ])
  })

  it('splits a long headingless section at paragraph boundaries and keeps one section', () => {
    const md = Array.from({ length: 12 }, (_, i) => para(i * 4, 6)).join('\n\n')
    const sections = buildSections(md, 'en')
    expect(sections).toHaveLength(1)
    expect(sections[0].chunks.length).toBeGreaterThan(1)
  })

  it('keeps a chunk hash stable when another section is edited', () => {
    const a = buildSections(`## A\n${para(0)}\n\n## B\n${para(10)}`, 'en')
    const b = buildSections(`## A\n${para(0)}\n\n## B\nChanged text entirely.`, 'en')
    expect(b[0].chunks[0].hash).toBe(a[0].chunks[0].hash)
    expect(b[1].chunks[0].hash).not.toBe(a[1].chunks[0].hash)
  })

  it('applies a CJK word budget and detects the script', () => {
    const zh = '这是一个很长的句子，用来测试中文的字数预算。'.repeat(20)
    expect(detectLanguage(zh)).toBe('zh')
    expect(isFoldable(zh, 'zh')).toBe(true)
    expect(isFoldable('这是很短的文字。', 'zh')).toBe(false)
    expect(isFoldable('word '.repeat(FOLD_MIN_WORDS), 'en')).toBe(false)
    expect(isFoldable('word '.repeat(FOLD_MIN_WORDS + 1), 'en')).toBe(true)
  })

  it('renders the local fallback with no model output', () => {
    const md = `## A\n${para(0)}\n\n${para(10)}`
    const sections = buildSections(md, 'en')
    const { layers, missing } = assemble({
      noteId: 'n',
      source: md,
      language: 'en',
      sections,
      lookup: () => undefined
    })
    expect(missing).toHaveLength(1)
    expect(layers.ready).toEqual([])
    const p = layers.sections[0].paragraphs[0]
    expect(p.key).toBeNull()
    expect(p.briefIdx).toHaveLength(1)
    expect(p.takeaway && p.topic).toBeTruthy()
    expect(layers.wordsByLevel.brief).toBeGreaterThan(0)
    expect(layers.wordsByLevel.brief).toBeLessThan(layers.wordsByLevel.full)
  })

  describe('inline Markdown', () => {
    const build = (md: string) => buildSections(md, 'en')[0].chunks[0].paragraphs[0]

    it('keeps formatting per sentence while the plain text stays unchanged', () => {
      const p = build(
        'Start with **bold words** here. Then `code()` and *italic* and [a link](http://x). See [[Note|alias]] now.'
      )
      expect(p.sentences).toEqual([
        'Start with bold words here.',
        'Then code() and italic and a link.',
        'See alias now.'
      ])
      expect(p.sentencesMd).toEqual([
        'Start with **bold words** here.',
        'Then `code()` and *italic* and [a link](http://x).',
        'See [[Note|alias]] now.'
      ])
    })

    it('closes a span that crosses a sentence boundary and drops images', () => {
      const p = build('**One thing. Another thing.** Plain ![pic](x.png) tail.')
      expect(p.sentencesMd[0]).toBe('**One thing.**')
      expect(p.sentencesMd[1]).toBe('**Another thing.**')
      expect(p.sentencesMd[2]).toBe('Plain tail.')
      expect(p.sentencesMd).toHaveLength(p.sentences.length)
    })

    it('does not change the plain text, so chunk hashes stay stable', () => {
      const a = build('Same **text** here. And more.')
      const b = build('Same text here. And more.')
      expect(a.hash).toBe(b.hash)
    })
  })

  describe('skipped blocks', () => {
    it('records each non-prose block after the paragraph it follows and never makes it a paragraph', () => {
      const md = [
        '![[embedded note]]',
        '',
        'First paragraph.',
        '```js',
        'const a = 1',
        '```',
        '```',
        'second',
        '```',
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '![img](x.png)',
        '![img](y.png)',
        '',
        '> [!note] Callout',
        '> secret body',
        '',
        '<div>',
        '',
        'Second paragraph.'
      ].join('\n')
      const [section] = buildSections(md, 'en')
      expect(section.chunks.flatMap((c) => c.paragraphs.map((p) => p.text))).toEqual([
        'First paragraph.',
        'Second paragraph.'
      ])
      expect(section.skipped).toEqual([
        { afterParagraph: -1, kind: 'embed', count: 1 },
        { afterParagraph: 0, kind: 'code', count: 2 },
        { afterParagraph: 0, kind: 'table', count: 1 },
        { afterParagraph: 0, kind: 'image', count: 2 },
        { afterParagraph: 0, kind: 'callout', count: 1 },
        { afterParagraph: 0, kind: 'other', count: 1 }
      ])
    })

    it('never puts skipped content in the model prompt text', () => {
      const [section] = buildSections('Prose line.\n```\nSECRET\n```\n| SECRET |', 'en')
      const all = section.chunks.flatMap((c) => c.paragraphs.map((p) => p.text)).join(' ')
      expect(all).not.toContain('SECRET')
    })
  })

  describe('morph token maps', () => {
    const md = `## A\n${[
      'The quick brown fox jumps over the lazy dog near the river bank.',
      'Foxes are fast animals that hunt at dusk.'
    ].join(' ')}`
    const ai = {
      sectionTakeaway: 'Foxes.',
      paragraphs: [
        {
          brief: [0],
          key: { takeaway: 'A quick fox jumps over a dog.', reason: 'Because foxes are fast.' },
          takeaway: 'Quick fox, lazy dog',
          topic: 'Fox and dog',
          evidence: [0]
        }
      ]
    }

    it('maps AI-line words onto source token indices and reproduces the line text', () => {
      const sections = buildSections(md, 'en')
      const { layers } = assemble({
        noteId: 'n',
        source: md,
        language: 'en',
        sections,
        lookup: () => ai
      })
      const p = layers.sections[0].paragraphs[0]
      expect(p.srcTokens.join('')).toBe(p.text)
      const line = p.morph.keyTakeaway!
      expect(line.map((t) => t.text).join('')).toBe('A quick fox jumps over a dog.')
      const mapped = line.filter((t) => t.src !== null)
      expect(mapped.map((t) => t.text)).toEqual(['quick', 'fox', 'jumps', 'over', 'dog'])
      for (const t of mapped) expect(p.srcTokens[t.src!].toLowerCase()).toBe(t.text.toLowerCase())
      const srcs = mapped.map((t) => t.src!)
      expect(srcs).toEqual([...srcs].sort((a, b) => a - b))
      expect(line.find((t) => t.text === ' ')!.src).toBeNull()
      // 'foxes' matches the source's 'Foxes' (case and plural folded)
      expect(p.morph.keyReason!.find((t) => t.text === 'foxes')?.src).not.toBeNull()
      expect(p.morph.keyReason!.find((t) => t.text === 'Because')?.src).toBeNull()
    })

    it('marks where each sentence starts in the source tokens', () => {
      const sections = buildSections(md, 'en')
      const { layers } = assemble({
        noteId: 'n',
        source: md,
        language: 'en',
        sections,
        lookup: () => ai
      })
      const p = layers.sections[0].paragraphs[0]
      expect(p.srcSentenceStart).toHaveLength(p.sentences.length)
      expect(p.srcSentenceStart[0]).toBe(0)
      expect(p.srcTokens[p.srcSentenceStart[1]]).toBe('Foxes')
    })

    it('leaves key lines null without model output but still maps the local lines', () => {
      const sections = buildSections(md, 'en')
      const { layers } = assemble({
        noteId: 'n',
        source: md,
        language: 'en',
        sections,
        lookup: () => undefined
      })
      const p = layers.sections[0].paragraphs[0]
      expect(p.morph.keyTakeaway).toBeNull()
      expect(p.morph.keyReason).toBeNull()
      expect(p.morph.takeaway!.some((t) => t.src !== null)).toBe(true)
    })

    it('segments by the note language', () => {
      const zh = '今天天气很好我们去公园散步。'.repeat(2)
      const [section] = buildSections(zh, 'zh')
      const { layers } = assemble({
        noteId: 'n',
        source: zh,
        language: 'zh',
        sections: [section],
        lookup: () => undefined
      })
      const p = layers.sections[0].paragraphs[0]
      expect(p.srcTokens.length).toBeGreaterThan(1)
      expect(p.srcTokens.join('')).toBe(p.text)
    })
  })

  describe('cache compatibility', () => {
    it('assembles an old-shape cached payload (no morph or markdown fields) into a valid snapshot', () => {
      const md = `## A\n${para(0, 5)}`
      const sections = buildSections(md, 'en')
      const chunk = sections[0].chunks[0]
      const oldPayload = JSON.stringify({
        sectionTakeaway: 'Old.',
        paragraphs: [
          {
            brief: [0],
            key: { takeaway: 'Sentence number 0 talks.', reason: 'It does.' },
            takeaway: 'Talks',
            topic: 'Topic zero',
            evidence: [0]
          }
        ]
      })
      const parsed = chunkAiSchema(chunk).parse(JSON.parse(oldPayload))
      const { layers, missing } = assemble({
        noteId: 'n',
        source: md,
        language: 'en',
        sections,
        lookup: () => parsed
      })
      expect(missing).toHaveLength(0)
      expect(layers.ready).toEqual(['key', 'takeaway', 'topic'])
      const full = { ...layers, status: 'ready' as const, agent: 'x' }
      expect(FoldLayersSchema.safeParse(full).success).toBe(true)
    })
  })
})
