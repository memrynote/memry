import { describe, expect, it } from 'vitest'
import {
  extractInlineTagsFromMarkdown,
  findInlineTags,
  isInlineTagName,
  isInlineTagPrefix,
  renamedTag,
  rewriteInlineTagsInMarkdown
} from './inline-tags'
import { INLINE_TAG_RENAME_CASES } from './inline-tag-rename-cases'
import { foldTag } from './tag-fold'

describe('extractInlineTagsFromMarkdown', () => {
  it('extracts a single tag', () => {
    expect(extractInlineTagsFromMarkdown('Hello #world')).toEqual(['world'])
  })

  it('extracts multiple tags', () => {
    expect(extractInlineTagsFromMarkdown('#foo and #bar')).toEqual(['foo', 'bar'])
  })

  it('deduplicates repeated tags', () => {
    expect(extractInlineTagsFromMarkdown('#foo then #foo again')).toEqual(['foo'])
  })

  it('preserves case as typed', () => {
    expect(extractInlineTagsFromMarkdown('#Work #URGENT')).toEqual(['Work', 'URGENT'])
  })

  it('deduplicates case variants, first occurrence wins', () => {
    expect(extractInlineTagsFromMarkdown('#Work then #work again')).toEqual(['Work'])
  })

  it('skips tags inside fenced code blocks', () => {
    const content = 'before #real\n```\n#fake\n```\nafter #also-real'
    expect(extractInlineTagsFromMarkdown(content)).toEqual(['real', 'also-real'])
  })

  it('skips tags inside inline code', () => {
    expect(extractInlineTagsFromMarkdown('use `#hidden` but #visible')).toEqual(['visible'])
  })

  it('requires whitespace or start-of-string before #', () => {
    expect(extractInlineTagsFromMarkdown('email@user#tag')).toEqual([])
  })

  it('matches tag after newline', () => {
    expect(extractInlineTagsFromMarkdown('line one\n#tag')).toEqual(['tag'])
  })

  it('rejects tags starting with a digit', () => {
    expect(extractInlineTagsFromMarkdown('#123 #456abc')).toEqual([])
  })

  it('allows hyphens and underscores', () => {
    expect(extractInlineTagsFromMarkdown('#my-tag #my_tag')).toEqual(['my-tag', 'my_tag'])
  })

  it('returns empty array for empty string', () => {
    expect(extractInlineTagsFromMarkdown('')).toEqual([])
  })

  it('handles tag at very start of content', () => {
    expect(extractInlineTagsFromMarkdown('#first word')).toEqual(['first'])
  })

  it('extracts hierarchical tags with slashes', () => {
    expect(extractInlineTagsFromMarkdown('#movies/oscar and #movies/grammy')).toEqual([
      'movies/oscar',
      'movies/grammy'
    ])
  })

  it('extracts deeply nested hierarchical tags', () => {
    expect(extractInlineTagsFromMarkdown('#a/b/c/d')).toEqual(['a/b/c/d'])
  })

  it('does not capture trailing slash', () => {
    expect(extractInlineTagsFromMarkdown('#movies/ rest')).toEqual(['movies'])
  })
})

describe('rewriteInlineTagsInMarkdown', () => {
  const rename = [{ from: 'person', to: 'people' }]

  it('renames the tag and its children, whole tags only', () => {
    expect(
      rewriteInlineTagsInMarkdown('#person met #Person/VIP and #personal #person-x', rename)
    ).toBe('#people met #people/VIP and #personal #person-x')
  })

  it('leaves code, mid-word hashes and other tags as written', () => {
    const content = 'a#person `#person` #work\n```\n#person\n```\n#person'
    expect(rewriteInlineTagsInMarkdown(content, rename)).toBe(
      'a#person `#person` #work\n```\n#person\n```\n#people'
    )
  })

  it('agrees with the extractor on what it renamed', () => {
    const content = 'x `code`#person y #person/a/b'
    const rewritten = rewriteInlineTagsInMarkdown(content, rename)
    expect(extractInlineTagsFromMarkdown(rewritten)).toEqual(['people', 'people/a/b'])
  })
})

describe('rewriteInlineTagsInMarkdown shared cases', () => {
  for (const c of INLINE_TAG_RENAME_CASES) {
    it(c.name, () => {
      const markdown = c.pieces.map((p) => (p.code ? `\`${p.text}\`` : p.text)).join('')
      const rewritten = rewriteInlineTagsInMarkdown(markdown, c.renames)
      expect(rewritten.replace(/`/g, '')).toBe(c.expected)
    })
  }
})

describe('foldTag', () => {
  it('lowercases ASCII only, as SQLite NOCASE and the Rust core do', () => {
    expect(foldTag('WorK/Deep')).toBe('work/deep')
    expect(foldTag('İş')).toBe('İş')
    expect(foldTag('Ünal')).toBe('Ünal')
    expect(foldTag('ŞEHİR')).toBe('Şehİr')
    expect(foldTag('Şehir/ALT')).toBe('Şehir/alt')
  })
})

describe('renamedTag', () => {
  it('keeps a non-ASCII child suffix whole', () => {
    expect(renamedTag('İş/alt', [{ from: 'İş', to: 'Work' }])).toBe('Work/alt')
    expect(renamedTag('ÜNAL/Ekip', [{ from: 'ÜNAL', to: 'team' }])).toBe('team/Ekip')
  })

  it('treats spellings that differ beyond ASCII case as different tags', () => {
    expect(renamedTag('ünal', [{ from: 'Ünal', to: 'x' }])).toBeNull()
    expect(renamedTag('iş/alt', [{ from: 'İş', to: 'x' }])).toBeNull()
  })
})

describe('isInlineTagName', () => {
  it('accepts what the inline grammar reads back whole', () => {
    expect(isInlineTagName('people/VIP')).toBe(true)
    expect(isInlineTagName('my project')).toBe(false)
    expect(isInlineTagName('2024')).toBe(false)
    expect(isInlineTagName('iş')).toBe(false)
    expect(isInlineTagName('a/')).toBe(false)
  })
})

describe('findInlineTags', () => {
  it('reads a tag only when a letter follows the #', () => {
    expect(findInlineTags('#2024 #a2024 #_x #-x #a/2024')).toEqual([
      { index: 6, tag: 'a2024' },
      { index: 21, tag: 'a/2024' }
    ])
  })

  it('reads the preceding character from before the text', () => {
    expect(findInlineTags('#work', 'x')).toEqual([])
    expect(findInlineTags('#work', ' ')).toEqual([{ index: 0, tag: 'work' }])
  })
})

describe('isInlineTagPrefix', () => {
  it('accepts a name being typed, including an open child segment', () => {
    expect(isInlineTagPrefix('a')).toBe(true)
    expect(isInlineTagPrefix('a/')).toBe(true)
    expect(isInlineTagPrefix('a/2')).toBe(true)
  })

  it('rejects what can never become a tag by appending', () => {
    expect(isInlineTagPrefix('')).toBe(false)
    expect(isInlineTagPrefix('2')).toBe(false)
    expect(isInlineTagPrefix('a//')).toBe(false)
    expect(isInlineTagPrefix('a/-')).toBe(false)
  })
})
