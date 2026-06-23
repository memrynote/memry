/**
 * Tests for parseEnex — requires fast-xml-parser to be installed.
 * These tests are expected to FAIL until the orchestrator runs `pnpm install`.
 */

import { describe, it, expect } from 'vitest'
import { parseEnex } from './parse-enex.ts'

const SAMPLE_ENEX = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20231015T143022Z" application="Evernote" version="10.0">
  <note>
    <title>Sample Note</title>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note><p>Hello world</p><en-todo checked="true"/>Done item</en-note>
    ]]></content>
    <created>20231015T143022Z</created>
    <updated>20231016T090000Z</updated>
    <tag>work</tag>
    <tag>important</tag>
    <resource>
      <data encoding="base64">iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==</data>
      <mime>image/png</mime>
      <resource-attributes>
        <file-name>pixel.png</file-name>
      </resource-attributes>
    </resource>
  </note>
</en-export>`

const MINIMAL_ENEX = `<en-export>
  <note>
    <title>Minimal</title>
    <content><![CDATA[<en-note><p>Text</p></en-note>]]></content>
  </note>
</en-export>`

const MULTI_NOTE_ENEX = `<en-export>
  <note>
    <title>Note A</title>
    <content><![CDATA[<en-note><p>A</p></en-note>]]></content>
    <tag>alpha</tag>
  </note>
  <note>
    <title>Note B</title>
    <content><![CDATA[<en-note><p>B</p></en-note>]]></content>
  </note>
</en-export>`

describe('parseEnex', () => {
  it('parses title, created, updated, tags, and resources', () => {
    const notes = parseEnex(SAMPLE_ENEX)
    expect(notes).toHaveLength(1)
    const [n] = notes
    expect(n.title).toBe('Sample Note')
    expect(n.created).toBe('2023-10-15T14:30:22Z')
    expect(n.updated).toBe('2023-10-16T09:00:00Z')
    expect(n.tags).toEqual(['work', 'important'])
    expect(n.resources).toHaveLength(1)
    expect(n.resources[0].mime).toBe('image/png')
    expect(n.resources[0].fileName).toBe('pixel.png')
    expect(n.resources[0].base64).toBeTruthy()
  })

  it('returns contentHtml containing the ENML', () => {
    const [n] = parseEnex(SAMPLE_ENEX)
    expect(n.contentHtml).toContain('<en-note>')
    expect(n.contentHtml).toContain('Hello world')
  })

  it('handles a note with no tags or resources', () => {
    const notes = parseEnex(MINIMAL_ENEX)
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toBe('Minimal')
    expect(notes[0].tags).toEqual([])
    expect(notes[0].resources).toEqual([])
    expect(notes[0].created).toBeUndefined()
  })

  it('parses multiple notes', () => {
    const notes = parseEnex(MULTI_NOTE_ENEX)
    expect(notes).toHaveLength(2)
    expect(notes[0].title).toBe('Note A')
    expect(notes[0].tags).toEqual(['alpha'])
    expect(notes[1].title).toBe('Note B')
    expect(notes[1].tags).toEqual([])
  })

  it('returns empty array for empty en-export', () => {
    const notes = parseEnex('<en-export></en-export>')
    expect(notes).toEqual([])
  })

  it('returns empty array when there is no en-export root', () => {
    const notes = parseEnex('<other>content</other>')
    expect(notes).toEqual([])
  })

  it('strips whitespace from base64 data', () => {
    const enex = `<en-export>
      <note>
        <title>T</title>
        <content><![CDATA[<en-note/>]]></content>
        <resource>
          <data encoding="base64">aGVs
bG8=</data>
          <mime>text/plain</mime>
        </resource>
      </note>
    </en-export>`
    const [n] = parseEnex(enex)
    expect(n.resources[0].base64).toBe('aGVsbG8=')
  })
})
