import { describe, expect, it } from 'vitest'
import {
  createHashTagInlineContent,
  extractInlineTags,
  HashTag,
  normalizeHashTags
} from './hash-tag'

describe('hash tag inline content', () => {
  it('creates, renders, parses, and serializes hash tag inline content', () => {
    expect(createHashTagInlineContent('work', 'blue')).toEqual({
      type: 'hashTag',
      props: { tag: 'work', color: 'blue', icon: '' }
    })

    const render = (HashTag as any).implementation.render({
      props: { tag: 'work', color: 'blue' }
    })
    expect(render.dom.textContent).toBe('#work')
    expect(render.dom.getAttribute('data-hash-tag')).toBe('work')

    const element = document.createElement('span')
    element.setAttribute('data-hash-tag', ' personal ')
    element.setAttribute('data-hash-tag-color', ' green ')
    expect((HashTag as any).implementation.parse(element)).toEqual({
      tag: 'personal',
      color: 'green',
      icon: ''
    })

    const external = (HashTag as any).implementation.toExternalHTML({
      props: { tag: 'work' }
    })
    expect(external.dom.textContent).toBe('#work')
  })

  it('normalizes matching text tags but leaves unknown, embedded, and code tags alone', () => {
    const result = normalizeHashTags(
      [
        { id: 'a', type: 'paragraph', content: 'Start #Work and email#a' },
        { id: 'b', type: 'codeBlock', content: '#work' },
        {
          id: 'c',
          type: 'paragraph',
          content: [{ type: 'text', text: 'Nested #Personal', styles: { bold: true } }]
        }
      ] as any,
      new Set(['work', 'personal']),
      new Map([
        ['work', 'blue'],
        ['personal', 'green']
      ])
    )

    expect(result.didChange).toBe(true)
    expect((result.blocks[0] as any).content).toEqual([
      'Start ',
      { type: 'hashTag', props: { tag: 'Work', color: 'blue', icon: '' } },
      ' and email#a'
    ])
    expect((result.blocks[1] as any).content).toBe('#work')
    expect((result.blocks[2] as any).content).toEqual([
      { type: 'text', text: 'Nested ', styles: { bold: true } },
      { type: 'hashTag', props: { tag: 'Personal', color: 'green', icon: '' } }
    ])
  })

  it('threads a per-tag icon from the icon map into hash tag props and renders it', () => {
    const result = normalizeHashTags(
      [{ id: 'a', type: 'paragraph', content: 'Read #books today' }] as any,
      new Set(['books']),
      new Map([['books', 'blue']]),
      new Map([['books', '📚']])
    )

    expect((result.blocks[0] as any).content).toEqual([
      'Read ',
      { type: 'hashTag', props: { tag: 'books', color: 'blue', icon: '📚' } },
      ' today'
    ])

    // The chosen emoji renders ahead of the "#books" label in the chip.
    const render = (HashTag as any).implementation.render({
      props: { tag: 'books', color: 'blue', icon: '📚' }
    })
    expect(render.dom.textContent).toBe('📚#books')
    expect(render.dom.getAttribute('data-hash-tag-icon')).toBe('📚')
  })

  it('extracts inline tag content and text tags recursively', () => {
    const tags = extractInlineTags([
      {
        id: 'a',
        type: 'paragraph',
        content: [
          { type: 'hashTag', props: { tag: 'Work' } },
          { type: 'text', text: ' #Personal email#a' }
        ],
        children: [{ id: 'b', type: 'paragraph', content: ['Child #Nested'] }]
      },
      { id: 'code', type: 'codeBlock', content: '#ignored' }
    ] as any)

    expect(tags.sort()).toEqual(['Nested', 'Personal', 'Work'])
  })
})
