import { describe, expect, it } from 'vitest'

import { FOLD_MIN_WORDS } from '@memry/contracts/note-fold'

import { assemble, buildSections, detectLanguage, isFoldable } from './engine'

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
})
