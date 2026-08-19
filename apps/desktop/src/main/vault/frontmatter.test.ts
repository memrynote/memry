import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import matter from 'gray-matter'
import type { PropertyType } from '@memry/contracts/property-types'
import {
  parseNote,
  serializeNote,
  serializeParsedNote,
  validateNoteId,
  extractTitleFromPath,
  extractWikiLinks,
  extractTags,
  extractInlineTagsFromMarkdown,
  calculateWordCount,
  generateContentHash,
  extractProperties,
  resolvePropertyType,
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
  it('parseNote keeps user keys verbatim and normalizes tags/aliases', () => {
    const raw = `---
id: abc123def456
title: Sample Note
tags:
  - Work
  - Personal
aliases: alias-one
---

Hello world
`

    const parsed = parseNote(raw)
    expect(parsed.hadFrontmatter).toBe(true)
    // Body is the raw substring after the frontmatter block — never trimmed
    expect(parsed.content).toBe('\nHello world\n')
    expect(parsed.rawFrontmatterBlock).toBe(raw.slice(0, raw.length - parsed.content.length))
    expect(parsed.eol).toBe('\n')
    expect(parsed.hadTrailingNewline).toBe(true)
    // Legacy Memry keys are plain user properties, never interpreted
    expect(parsed.frontmatter.id).toBe('abc123def456')
    expect(parsed.frontmatter.title).toBe('Sample Note')
    expect(parsed.frontmatter.tags).toEqual(['Work', 'Personal'])
    expect(parsed.frontmatter.aliases).toEqual(['alias-one'])
    // In-memory identity is fresh, not read from the file
    expect(parsed.id).not.toBe('abc123def456')
    expect(parsed.id).toMatch(/^[0-9a-z]{12}$/)
  })

  it('parseNote generates in-memory defaults without touching frontmatter', () => {
    const raw = 'Just content'
    const parsed = parseNote(raw, 'notes/my-sample.md')
    expect(parsed.hadFrontmatter).toBe(false)
    expect(parsed.frontmatter).toEqual({})
    expect(parsed.id).toMatch(/^[0-9a-z]{12}$/)
    expect(parsed.title).toBe('my-sample')
    expect(parsed.created).toBe(FIXED_ISO)
    expect(parsed.modified).toBe(FIXED_ISO)
    expect(parsed.content).toBe('Just content')
  })

  it('parseNote derives created/modified from fs stats when provided', () => {
    const birthtime = new Date('2025-06-01T08:00:00.000Z')
    const mtime = new Date('2025-06-02T09:30:00.000Z')
    const parsed = parseNote('Body', 'notes/dated.md', { birthtime, mtime })
    expect(parsed.created).toBe('2025-06-01T08:00:00.000Z')
    expect(parsed.modified).toBe('2025-06-02T09:30:00.000Z')
  })

  it('parseNote reports no frontmatter error for parseable YAML', () => {
    const parsed = parseNote('---\ntitle: Fine\n---\n\nBody\n')
    expect(parsed.frontmatterError).toBeNull()
  })

  it('parseNote tolerates malformed YAML: body kept, metadata dropped', () => {
    const raw = `---
title: "unterminated
tags: [work, personal
---

Body survives
`
    const parsed = parseNote(raw, 'notes/Broken.md')

    expect(parsed.frontmatterError).toBeTruthy()
    expect(parsed.frontmatter).toEqual({})
    expect(parsed.hadFrontmatter).toBe(false)
    expect(parsed.content).toBe('\nBody survives\n')
    // Title still falls back to the filename, dates to the in-memory defaults
    expect(parsed.title).toBe('Broken')
  })

  it('parseNote keeps the malformed block verbatim for byte-preserving writeback', () => {
    const raw = `---
title: "unterminated
---

Body survives
`
    const parsed = parseNote(raw, 'notes/Broken.md')

    expect(parsed.rawFrontmatterBlock).toBe('---\ntitle: "unterminated\n---\n')
    expect(serializeParsedNote(parsed, parsed.content, { frontmatterEdited: false })).toBe(raw)
  })
})

describe('frontmatter serialization', () => {
  it('serializeNote writes only the given keys and never bumps modified', () => {
    const frontmatter: NoteFrontmatter = {
      tags: ['tag-one'],
      rating: 5
    }

    const output = serializeNote(frontmatter, 'Body text\n')
    const parsed = matter(output)

    expect(parsed.data).toEqual({ tags: ['tag-one'], rating: 5 })
    expect(parsed.data.modified).toBeUndefined()
    expect(parsed.content.trim()).toBe('Body text')
  })

  it('serializeNote returns bare content when no keys remain', () => {
    // New files end with a single trailing newline
    expect(serializeNote({}, 'Body text\n')).toBe('Body text\n')
    expect(serializeNote({ skipped: undefined }, 'Body text')).toBe('Body text\n')
  })
})

describe('frontmatter utilities', () => {
  it('validateNoteId proxies the note id validator', () => {
    expect(validateNoteId('abc123def456')).toBe(true)
    expect(validateNoteId('invalid-id')).toBe(false)
  })

  it('extractTitleFromPath returns the verbatim basename', () => {
    expect(extractTitleFromPath('/notes/my-note_file.md')).toBe('my-note_file')
    expect(extractTitleFromPath('notes/Meeting Notes.md')).toBe('Meeting Notes')
  })

  it('extractWikiLinks pulls link targets from content', () => {
    const links = extractWikiLinks('See [[First Link]] and [[Second|Alias]]')
    expect(links).toEqual(['First Link', 'Second'])
  })

  it('extractWikiLinks deduplicates repeated links', () => {
    const links = extractWikiLinks('[[Same Note]] and [[Other]] then [[Same Note]] again')
    expect(links).toEqual(['Same Note', 'Other'])
  })

  // A15: the whole `Note#Heading` string used to go in as a title, resolved to
  // nothing, and the note it named never listed the link as a backlink.
  it('extractWikiLinks indexes a heading link under its note', () => {
    const links = extractWikiLinks('See [[Meeting#Decisions]]')
    expect(links).toEqual(['Meeting'])
  })

  it('extractWikiLinks collapses heading links onto the note they share', () => {
    const links = extractWikiLinks('[[Meeting#Decisions]] and [[Meeting#Actions]] and [[Meeting]]')
    expect(links).toEqual(['Meeting'])
  })

  it('extractWikiLinks ignores a same-note heading link', () => {
    const links = extractWikiLinks('Jump to [[#Decisions]] and see [[Other]]')
    expect(links).toEqual(['Other'])
  })

  it('extractTags trims and preserves case', () => {
    const frontmatter: NoteFrontmatter = {
      id: 'abc123def456',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      tags: [' Work ', 'PERSONAL', '']
    }
    expect(extractTags(frontmatter)).toEqual(['Work', 'PERSONAL'])
  })

  it('extractTags deduplicates case-insensitively, first occurrence wins', () => {
    const frontmatter: NoteFrontmatter = {
      id: 'abc123def456',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      tags: ['Work', 'work', 'WORK', 'other']
    }
    expect(extractTags(frontmatter)).toEqual(['Work', 'other'])
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
      tags: ['tag-one'],
      aliases: ['other-name'],
      project: 'alpha',
      priority: 2
    }

    expect(extractProperties(frontmatter)).toEqual({ project: 'alpha', priority: 2 })
  })

  it('surfaces legacy Memry keys as plain user properties', () => {
    // Only tags/aliases are reserved — id/title/created/modified/emoji/localOnly
    // found in files are user properties, never interpreted
    const frontmatter: NoteFrontmatter = {
      id: 'abc123def456',
      title: 'Old Memry Note',
      created: FIXED_ISO,
      emoji: '🎉',
      localOnly: true,
      tags: ['kept-out']
    }

    expect(extractProperties(frontmatter)).toEqual({
      id: 'abc123def456',
      title: 'Old Memry Note',
      created: FIXED_ISO,
      emoji: '🎉',
      localOnly: true
    })
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

  it('infers relation for an all-URI array', () => {
    expect(inferPropertyType('father', ['memry://note/nte_1'])).toBe('relation')
    expect(inferPropertyType('attendees', ['memry://task/tsk_1', 'memry://event/evt_2'])).toBe(
      'relation'
    )
  })

  it('leaves non-relation arrays as text', () => {
    expect(inferPropertyType('tags', [])).toBe('text')
    expect(inferPropertyType('tags', ['a', 'b'])).toBe('text')
    expect(inferPropertyType('mixed', ['memry://note/nte_1', 'plain'])).toBe('text')
    expect(inferPropertyType('bad', ['memry://project/prj_1'])).toBe('text')
  })

  it('does not treat a bare URI string as relation', () => {
    expect(inferPropertyType('father', 'memry://note/nte_1')).toBe('text')
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

  it('createSnippet strips memry HTML comment markers', () => {
    const content =
      'first <!-- memry:block-nesting-level=1 --> second <!-- colors:{"textColor":"red"} --> third'
    const snippet = createSnippet(content, 200)
    expect(snippet).toBe('first second third')
    expect(snippet).not.toContain('<!--')
  })
})

describe('resolvePropertyType — the shared precedence ladder', () => {
  const infer = (name: string, value: unknown): PropertyType => inferPropertyType(name, value)

  it('lets the reserved project name beat a stale stored definition', () => {
    // A vault imported from Obsidian can carry { name: 'project', type: 'text' }.
    expect(resolvePropertyType('project', ['Website Redesign'], 'text', infer)).toBe('project')
  })

  it('lets a memry:// URI array beat a stored definition that says text', () => {
    // This is the rule that keeps a UI-created relation from being pinned to
    // `text` by its own empty first write. Without it the array is later
    // deserialized as a raw JSON string and round-tripped into the vault file.
    expect(resolvePropertyType('father', ['memry://note/nte_1'], 'text', infer)).toBe('relation')
  })

  it('falls back to the stored definition when neither rule applies', () => {
    expect(resolvePropertyType('stage', 'Draft', 'select', infer)).toBe('select')
  })

  it('infers only when there is no stored definition', () => {
    expect(resolvePropertyType('count', 3, undefined, infer)).toBe('number')
  })

  it('does not mistake a plain string array for a relation', () => {
    expect(resolvePropertyType('tags', ['a', 'b'], undefined, infer)).toBe('text')
  })

  it('does not treat an empty array as a relation', () => {
    // The empty default a freshly-added relation starts life with. It types as
    // text here, which is exactly why the structural rule above has to override
    // the stored definition once a real value arrives.
    expect(resolvePropertyType('father', [], undefined, infer)).toBe('text')
  })
})
