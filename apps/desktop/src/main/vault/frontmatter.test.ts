import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import matter from 'gray-matter'
import {
  parseNote,
  serializeNote,
  createFrontmatter,
  ensureFrontmatter,
  validateNoteId,
  extractTitleFromPath,
  extractWikiLinks,
  extractTags,
  extractInlineTagsFromMarkdown,
  calculateWordCount,
  generateContentHash,
  extractProperties,
  inferPropertyType,
  serializePropertyValue,
  deserializePropertyValue,
  createSnippet,
  type NoteFrontmatter
} from './frontmatter'

const FIXED_ISO = '2026-01-15T12:00:00.000Z'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(FIXED_ISO))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('frontmatter parsing', () => {
  it('parseNote extracts YAML frontmatter and normalizes fields', () => {
    const raw = `---
id: abc123def456
title: Sample Note
created: 2026-01-01T00:00:00.000Z
modified: 2026-01-02T00:00:00.000Z
tags:
  - Work
  - Personal
aliases: alias-one
---

Hello world
`

    const parsed = parseNote(raw)
    expect(parsed.hadFrontmatter).toBe(true)
    expect(parsed.wasModified).toBe(true)
    expect(parsed.content).toBe('Hello world')
    expect(parsed.frontmatter.id).toBe('abc123def456')
    expect(parsed.frontmatter.tags).toEqual(['Work', 'Personal'])
    expect(parsed.frontmatter.aliases).toEqual(['alias-one'])
  })

  it('parseNote handles content without frontmatter', () => {
    const raw = 'Just content'
    const parsed = parseNote(raw, 'notes/my-sample.md')
    expect(parsed.hadFrontmatter).toBe(false)
    expect(parsed.wasModified).toBe(true)
    expect(parsed.frontmatter.created).toBe(FIXED_ISO)
    expect(parsed.frontmatter.modified).toBe(FIXED_ISO)
    expect(parsed.frontmatter.title).toBe('My Sample')
    expect(parsed.frontmatter.id).toMatch(/^[0-9a-z]{12}$/)
    expect(parsed.content).toBe('Just content')
  })
})

describe('frontmatter serialization', () => {
  it('serializeNote updates modified and preserves trimmed content', () => {
    const frontmatter: NoteFrontmatter = {
      id: 'abc123def456',
      title: 'Serialized Note',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-02T00:00:00.000Z'
    }

    const output = serializeNote(frontmatter, 'Body text\n')
    const parsed = matter(output)

    expect(parsed.data.modified).toBe(FIXED_ISO)
    expect(parsed.content).toBe('Body text')
  })

  it('createFrontmatter generates defaults for new notes', () => {
    const frontmatter = createFrontmatter('New Note', ['tag-one'])
    expect(frontmatter.title).toBe('New Note')
    expect(frontmatter.tags).toEqual(['tag-one'])
    expect(frontmatter.created).toBe(FIXED_ISO)
    expect(frontmatter.modified).toBe(FIXED_ISO)
    expect(validateNoteId(frontmatter.id)).toBe(true)
  })
})

describe('frontmatter utilities', () => {
  it('ensureFrontmatter adds missing frontmatter', () => {
    const raw = 'Plain content'
    const updated = ensureFrontmatter(raw, '/notes/new-note.md')
    const parsed = matter(updated)

    expect(parsed.content).toBe('Plain content')
    expect(parsed.data.title).toBe('New Note')
    expect(parsed.data.created).toBe(FIXED_ISO)
    expect(parsed.data.modified).toBe(FIXED_ISO)
    expect(parsed.data.id).toMatch(/^[0-9a-z]{12}$/)
  })

  it('ensureFrontmatter returns untouched content when complete', () => {
    const raw = matter.stringify('Body', {
      id: 'abc123def456',
      title: 'Existing',
      created: FIXED_ISO,
      modified: FIXED_ISO
    })
    expect(ensureFrontmatter(raw, '/notes/existing.md')).toBe(raw)
  })

  it('validateNoteId proxies the note id validator', () => {
    expect(validateNoteId('abc123def456')).toBe(true)
    expect(validateNoteId('invalid-id')).toBe(false)
  })

  it('extractTitleFromPath converts filenames to titles', () => {
    expect(extractTitleFromPath('/notes/my-note_file.md')).toBe('My Note File')
  })

  it('extractWikiLinks pulls link targets from content', () => {
    const links = extractWikiLinks('See [[First Link]] and [[Second|Alias]]')
    expect(links).toEqual(['First Link', 'Second'])
  })

  it('extractWikiLinks deduplicates repeated links', () => {
    const links = extractWikiLinks('[[Same Note]] and [[Other]] then [[Same Note]] again')
    expect(links).toEqual(['Same Note', 'Other'])
  })

  it('extractTags normalizes frontmatter tags', () => {
    const frontmatter: NoteFrontmatter = {
      id: 'abc123def456',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      tags: [' Work ', 'PERSONAL', '']
    }
    expect(extractTags(frontmatter)).toEqual(['work', 'personal'])
  })

  it('calculateWordCount ignores code blocks and inline code', () => {
    const content = `
Here is some text with \`inline code\` and more words.

\`\`\`
const value = 1
\`\`\`

Another line with words.
`
    expect(calculateWordCount(content)).toBe(12)
  })

  it('generateContentHash returns a stable djb2 hash', () => {
    expect(generateContentHash('Hello world')).toBe('33c13465')
  })
})

describe('properties helpers', () => {
  it('extractProperties prefers explicit properties object', () => {
    const frontmatter: NoteFrontmatter = {
      id: 'abc123def456',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      properties: { rating: 5, owner: 'alex' }
    }

    expect(extractProperties(frontmatter)).toEqual({ rating: 5, owner: 'alex' })
  })

  it('extractProperties falls back to non-reserved keys', () => {
    const frontmatter: NoteFrontmatter = {
      id: 'abc123def456',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      tags: ['tag-one'],
      project: 'alpha',
      priority: 2
    }

    expect(extractProperties(frontmatter)).toEqual({ project: 'alpha', priority: 2 })
  })

  it('excludes emoji from extracted properties (regression: emoji leak on sync)', () => {
    const frontmatter: NoteFrontmatter = {
      id: 'abc123def456',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      emoji: '🎉'
    }

    expect(extractProperties(frontmatter)).toEqual({})
  })

  it('excludes emoji but keeps custom keys in fallback extraction', () => {
    const frontmatter: NoteFrontmatter = {
      id: 'abc123def456',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      emoji: '📝',
      customField: 'val'
    }

    const result = extractProperties(frontmatter)
    expect(result).toEqual({ customField: 'val' })
    expect(result).not.toHaveProperty('emoji')
  })

  it('inferPropertyType detects common property types', () => {
    expect(inferPropertyType('done', true)).toBe('checkbox')
    expect(inferPropertyType('score', 4)).toBe('number')
    expect(inferPropertyType('count', 10)).toBe('number')
    // Arrays are no longer supported, fallback to text
    expect(inferPropertyType('labels', ['a', 'b'])).toBe('text')
    expect(inferPropertyType('published', '2026-01-15')).toBe('date')
    expect(inferPropertyType('site', 'https://example.com')).toBe('url')
    expect(inferPropertyType('title', 'Hello')).toBe('text')
    expect(inferPropertyType('misc', { value: 1 })).toBe('text')
  })

  it('serializes and deserializes property values', () => {
    expect(serializePropertyValue(null)).toBeNull()
    expect(serializePropertyValue('text')).toBe('text')
    expect(serializePropertyValue(5)).toBe('5')
    expect(serializePropertyValue(false)).toBe('false')
    expect(serializePropertyValue(['a', 'b'])).toBe('["a","b"]')
    expect(serializePropertyValue({ key: 'value' })).toBe('{"key":"value"}')

    expect(deserializePropertyValue('5', 'number')).toBe(5)
    expect(deserializePropertyValue('true', 'checkbox')).toBe(true)
    expect(deserializePropertyValue('hello', 'text')).toBe('hello')
    expect(deserializePropertyValue(null, 'text')).toBeNull()
  })
})

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

  it('normalizes to lowercase', () => {
    expect(extractInlineTagsFromMarkdown('#Work #URGENT')).toEqual(['work', 'urgent'])
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

describe('snippet helpers', () => {
  it('createSnippet strips markdown and truncates to length', () => {
    const content = `
# Heading
This is **bold** and _italic_ text with a [link](https://example.com) and [[Wiki|Display]].
![Alt](image.png)
More text here to ensure the snippet is long enough.
`
    const snippet = createSnippet(content, 50)
    expect(snippet.endsWith('...')).toBe(true)
    expect(snippet).not.toContain('#')
    expect(snippet).not.toContain('[')
    expect(snippet).not.toContain('![')
  })

  it('createSnippet returns full cleaned content when shorter than max', () => {
    expect(createSnippet('Simple note text.', 200)).toBe('Simple note text.')
  })
})
