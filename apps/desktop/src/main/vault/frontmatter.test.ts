import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import matter from 'gray-matter'
import { COVER_FRONTMATTER_KEY } from '@memry/shared/cover-image'
import {
  parseNote,
  serializeNote,
  serializeParsedNote,
  serializeUpdatedNote,
  validateNoteId,
  extractTitleFromPath,
  extractTags,
  applyHeaderTagEdit,
  calculateWordCount,
  generateContentHash,
  extractProperties,
  normalizePropertiesToRoot,
  replacePropertiesOnRoot,
  writePropertiesToRoot,
  serializePropertyValue,
  deserializePropertyValue,
  createSnippet,
  cleanCachedSnippet,
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

  it('serializes legacy nested properties at the root', () => {
    const output = serializeNote(
      { status: 'active', properties: { status: 'idea', owner: 'Kaan' } },
      'Body text'
    )

    expect(output).toMatch(/^status: active$/m)
    expect(output).toMatch(/^owner: Kaan$/m)
    expect(output).not.toMatch(/^properties:/m)
  })
})

describe('the separator between frontmatter and body (BBF-77)', () => {
  // The editor hands back a body with no leading blank line, whatever the file had.
  const cases = [
    ['LF blank line', '---\nkind: x\n---\n\nbody\n', '---\nkind: x\n---\n\nbody!\n'],
    [
      'CRLF blank line',
      '---\r\nkind: x\r\n---\r\n\r\nbody\r\n',
      '---\r\nkind: x\r\n---\r\n\r\nbody!\r\n'
    ],
    ['no blank line', '---\nkind: x\n---\nbody\n', '---\nkind: x\n---\nbody!\n']
  ] as const

  it.each(cases)('%s survives a body edit', (_name, raw, expected) => {
    const parsed = parseNote(raw, '/vault/Note.md')
    expect(serializeParsedNote(parsed, 'body!\n', { frontmatterEdited: false })).toBe(expected)
  })

  it.each(cases)('%s survives a frontmatter edit with a body edit', (_name, raw, expected) => {
    const parsed = parseNote(raw, '/vault/Note.md')
    const out = serializeUpdatedNote(parsed, { kind: 'z' }, 'body!\n', { frontmatterEdited: true })
    expect(out).toBe(expected.replace('kind: x', 'kind: z'))
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
  it('merges nested properties with root properties, keeping root conflicts', () => {
    const frontmatter: NoteFrontmatter = {
      status: 'active',
      properties: { rating: 5, owner: 'alex', status: 'idea' }
    }

    expect(extractProperties(frontmatter)).toEqual({
      rating: 5,
      owner: 'alex',
      status: 'active'
    })
  })

  it('normalizes nested properties into root keys without losing root values', () => {
    const result = normalizePropertiesToRoot({
      tags: ['mobile'],
      status: 'active',
      properties: { status: 'idea', owner: 'Kaan' }
    })

    expect(result).toEqual({
      frontmatter: { tags: ['mobile'], status: 'active', owner: 'Kaan' },
      changed: true,
      conflicts: ['status']
    })
  })

  it('does not promote reserved nested keys into user properties', () => {
    const result = normalizePropertiesToRoot({
      properties: { tags: ['legacy-tag'], aliases: ['legacy-alias'], owner: 'Kaan' }
    })

    expect(result.frontmatter).toEqual({ owner: 'Kaan' })
    expect(extractProperties({ properties: { tags: ['legacy-tag'], owner: 'Kaan' } })).toEqual({
      owner: 'Kaan'
    })
  })

  it('writes a property record at the root and preserves metadata keys', () => {
    expect(
      writePropertiesToRoot(
        { tags: ['mobile'], aliases: ['Launch'] },
        { status: 'active', owner: 'Kaan' }
      )
    ).toEqual({
      tags: ['mobile'],
      aliases: ['Launch'],
      status: 'active',
      owner: 'Kaan'
    })
  })

  it('replaces root properties without bringing back the nested envelope', () => {
    expect(
      replacePropertiesOnRoot(
        { tags: ['mobile'], status: 'old', properties: { owner: 'old' } },
        { status: 'active' }
      )
    ).toEqual({ tags: ['mobile'], status: 'active' })
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

describe('applyHeaderTagEdit', () => {
  it.each([
    {
      rule: 'removes a tag whatever its case and padding',
      current: ['Old', 'keep'],
      edit: { remove: [' OLD '] },
      next: ['keep']
    },
    {
      rule: 'renames a tag where it stands',
      current: ['a', 'old', 'b'],
      edit: { rename: [{ from: 'OLD', to: 'new' }] },
      next: ['a', 'new', 'b']
    },
    {
      rule: 'renaming onto a tag the list holds leaves one copy, where the source stood',
      current: ['source', 'other', 'target'],
      edit: { rename: [{ from: 'source', to: 'target' }] },
      next: ['target', 'other']
    },
    {
      rule: 'renaming a tag the list lacks adds nothing',
      current: ['a'],
      edit: { rename: [{ from: 'inline-only', to: 'b' }] },
      next: ['a']
    },
    {
      rule: 'adds only what the list lacks, keeping the spelling it holds',
      current: ['Work'],
      edit: { add: ['work', 'Focus'] },
      next: ['Work', 'Focus']
    }
  ])('$rule', ({ current, edit, next }) => {
    expect(applyHeaderTagEdit(current, edit)).toEqual(next)
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

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n']
  ])('createSnippet strips Obsidian comments on a %s note', (_label, eol) => {
    const content = [
      'Tail text %% [[Topic]] secret %% end of line.',
      '',
      '%%',
      'block [[Other]] secret',
      '%%',
      '',
      'Sale 50%% off.',
      '',
      '`%% code %%` stays.'
    ].join(eol)
    expect(createSnippet(content)).toBe('Tail text end of line. Sale 50%% off. `%% code %%` stays.')
  })
})

describe('createSnippet wiki links (issue #1556)', () => {
  it('reads a heading link as its note half', () => {
    expect(createSnippet('see [[Sprint Notes#Retro]] today')).toBe('see Sprint Notes today')
  })

  it('reads an aliased link as its alias, not alias-welded-to-target', () => {
    expect(createSnippet('see [[Sprint Notes|retro]] today')).toBe('see retro today')
  })
})

describe('createSnippet inline color spans (issue #2566)', () => {
  it('drops color, background and underline span tags and keeps their text', () => {
    const content =
      'a <span style="color:red">red</span> and ' +
      '<span style="background-color:yellow"><span style="text-decoration:underline">key</span></span> term'
    expect(createSnippet(content)).toBe('a red and key term')
  })

  it('strips span tags around emphasis and wiki links', () => {
    expect(createSnippet('<span style="color:blue">**bold** [[Note|n]]</span>!')).toBe('bold n!')
  })
})

// #2554: snippets cached before the #2566 fix keep raw span tags until the
// note is edited, so the tab hover preview showed them.
describe('cleanCachedSnippet (issue #2554)', () => {
  it('strips span tags from a stale cached snippet', () => {
    expect(cleanCachedSnippet('<span style="color:blue">Notes:</span> buy milk')).toBe(
      'Notes: buy milk'
    )
  })

  it('drops a span tag cut in half by the old truncation', () => {
    expect(cleanCachedSnippet('first line <span...')).toBe('first line...')
    expect(cleanCachedSnippet('first line <span style="col...')).toBe('first line...')
    expect(cleanCachedSnippet('first <span style="color:red">red</sp...')).toBe('first red...')
  })

  it('drops a %% comment cached before BBF-26', () => {
    expect(cleanCachedSnippet('Tail text %% Topic secret %% end. %% block Other %% After')).toBe(
      'Tail text end. After'
    )
    expect(cleanCachedSnippet('Sale 50%% off, cut mid...')).toBe('Sale 50%% off, cut mid...')
  })

  it('keeps table cells when a comment marker sits next to a cell pipe (BBF-59)', () => {
    const snippet = createSnippet(
      'Pipes\n\n| a | b |\n| --- | --- |\n| 50%% | 20%% |\n| 1 <!-- x | y --> | z |'
    )
    expect(snippet).toBe('Pipes | a | b | | --- | --- | | 50%% | 20%% | | 1 <!-- x | y --> | z |')
    expect(cleanCachedSnippet(snippet)).toBe(snippet)
  })

  it('leaves a clean snippet untouched', () => {
    expect(cleanCachedSnippet('a < b and c > d...')).toBe('a < b and c > d...')
    expect(cleanCachedSnippet(createSnippet('plain **text**'))).toBe('plain text')
  })
})

describe('the cover frontmatter key', () => {
  const COVER_REF = '../attachments/n1/abc123-photo.jpg'

  it('round-trips a note-relative ref byte-identically through parse and serialize', () => {
    const raw = `---
cover: ${COVER_REF}
status: reading
---

Body text
`

    const parsed = parseNote(raw, 'notes/Books/Dune.md')
    expect(parsed.frontmatter.cover).toBe(COVER_REF)

    const serialized = serializeNote(parsed.frontmatter, parsed.content)
    expect(serialized).toContain(COVER_REF)
    expect(serialized).not.toContain('memry-file://')

    const reparsed = parseNote(serialized, 'notes/Books/Dune.md')
    expect(reparsed.frontmatter.cover).toBe(COVER_REF)
    expect(serializeNote(reparsed.frontmatter, reparsed.content)).toBe(serialized)
  })

  it('hides an image-valued cover from extractProperties', () => {
    expect(extractProperties({ cover: COVER_REF, status: 'reading' })).toEqual({
      status: 'reading'
    })
    expect(COVER_FRONTMATTER_KEY).toBe('cover')
  })

  it('leaves a text-valued cover as an ordinary user property', () => {
    // `cover: Hardback` exists in real book notes written long before the key
    // meant anything. Reserving by name alone would drop the row.
    expect(extractProperties({ cover: 'Hardback', status: 'reading' })).toEqual({
      cover: 'Hardback',
      status: 'reading'
    })
  })

  it('REGRESSION: a property rewrite preserves the cover but still rewrites a text cover', () => {
    // `replacePropertiesOnRoot` deletes every key `extractProperties` returns
    // before rewriting, so without the value-aware reserve the cover vanishes
    // the first time the user edits any property.
    expect(
      replacePropertiesOnRoot(
        { tags: ['reading'], cover: COVER_REF, status: 'todo' },
        { status: 'done' }
      )
    ).toEqual({ tags: ['reading'], cover: COVER_REF, status: 'done' })

    expect(
      replacePropertiesOnRoot({ cover: 'Hardback', status: 'todo' }, { status: 'done' })
    ).toEqual({ status: 'done' })
  })
})

describe('value-gated cover keys', () => {
  const COVER_REF = '../attachments/n1/abc123-photo.jpg'

  it('reserves coverFocusX, coverZoom and coverHeight only when the value fits', () => {
    expect(
      extractProperties({ coverFocusX: 70, coverZoom: 1.5, coverHeight: 320, status: 'reading' })
    ).toEqual({ status: 'reading' })

    expect(
      extractProperties({ coverFocusX: 'left', coverZoom: '2x', coverHeight: 'tall' })
    ).toEqual({ coverFocusX: 'left', coverZoom: '2x', coverHeight: 'tall' })
  })

  it('round-trips the framing keys through the markdown file and a property rewrite', () => {
    const raw = `---
cover: ${COVER_REF}
coverFocus: 30
coverFocusX: 70
coverZoom: 1.5
coverHeight: 320
status: todo
---

Body text
`
    const parsed = parseNote(raw, 'notes/Books/Dune.md')
    expect(parsed.frontmatter).toMatchObject({
      coverFocus: 30,
      coverFocusX: 70,
      coverZoom: 1.5,
      coverHeight: 320
    })

    const rewritten = replacePropertiesOnRoot(parsed.frontmatter, { status: 'done' })
    const serialized = serializeNote(rewritten, parsed.content)
    const reparsed = parseNote(serialized, 'notes/Books/Dune.md')
    expect(reparsed.frontmatter).toEqual({
      cover: COVER_REF,
      coverFocus: 30,
      coverFocusX: 70,
      coverZoom: 1.5,
      coverHeight: 320,
      status: 'done'
    })
    expect(serializeNote(reparsed.frontmatter, reparsed.content)).toBe(serialized)
  })

  it('hides a wash cover from extractProperties the way an image cover is hidden', () => {
    expect(extractProperties({ cover: 'wash:sage', status: 'reading' })).toEqual({
      status: 'reading'
    })
  })

  it('reserves coverFocus, coverCredit and coverCreditUrl only when the value fits', () => {
    expect(
      extractProperties({
        coverFocus: 24,
        coverCredit: 'Ana Ruiz',
        coverCreditUrl: 'https://unsplash.com/@ana',
        status: 'reading'
      })
    ).toEqual({ status: 'reading' })

    // Written by a user long before these keys meant anything.
    expect(
      extractProperties({
        coverFocus: 'top of the shelf',
        coverCredit: '',
        coverCreditUrl: 'unsplash.com/@ana'
      })
    ).toEqual({
      coverFocus: 'top of the shelf',
      coverCredit: '',
      coverCreditUrl: 'unsplash.com/@ana'
    })
  })

  it('reserves writing only for writing tools data, and keeps it through a property rewrite', () => {
    const writing = { alternatives: { k3x9: { versions: ['calm'] } }, overflow: ['spare'] }
    expect(extractProperties({ writing, status: 'draft' })).toEqual({ status: 'draft' })
    expect(replacePropertiesOnRoot({ writing, status: 'draft' }, { status: 'done' })).toEqual({
      writing,
      status: 'done'
    })

    // A `writing` key the author uses for something else stays their property.
    expect(extractProperties({ writing: 'fiction' })).toEqual({ writing: 'fiction' })
    expect(extractProperties({ writing: { genre: 'fiction' } })).toEqual({
      writing: { genre: 'fiction' }
    })
  })

  it('REGRESSION: a property rewrite preserves focus and credit alongside the cover', () => {
    expect(
      replacePropertiesOnRoot(
        {
          cover: COVER_REF,
          coverFocus: 24,
          coverCredit: 'Ana Ruiz',
          coverCreditUrl: 'https://unsplash.com/@ana',
          status: 'todo'
        },
        { status: 'done' }
      )
    ).toEqual({
      cover: COVER_REF,
      coverFocus: 24,
      coverCredit: 'Ana Ruiz',
      coverCreditUrl: 'https://unsplash.com/@ana',
      status: 'done'
    })
  })
})
