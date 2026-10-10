import { describe, expect, it } from 'vitest'

import {
  appendMemryFileBlocks,
  readPromptFile,
  splitMemryFileBlocks,
  PROMPT_FILES_MAX_BYTES
} from '../memry-file-block'

const textFile = (name: string, content: string | Uint8Array): File =>
  new File([content as BlobPart], name, { type: 'text/plain' })

describe('memry-file blocks', () => {
  it('appends each file as a fenced block whose info string names the file and its size', () => {
    const text = appendMemryFileBlocks('what failed?', [
      { name: 'app.log', bytes: 12, text: 'ERROR boom\n' }
    ])

    expect(text).toBe('what failed?\n\n```memry-file name="app.log" bytes=12\nERROR boom\n\n```')
  })

  it('uses a fence longer than any backtick run in the file', () => {
    const content = 'before\n````\ninner\n````\nafter'
    const text = appendMemryFileBlocks('look', [{ name: 'a.md', bytes: 27, text: content }])

    expect(text).toContain('`````memry-file name="a.md" bytes=27\n')
    expect(splitMemryFileBlocks(text)).toEqual([
      { kind: 'text', text: 'look' },
      { kind: 'file', name: 'a.md', bytes: 27, content }
    ])
  })

  it('round-trips names with quotes and several files', () => {
    const files = [
      { name: 'say "hi".txt', bytes: 2, text: 'hi' },
      { name: 'data.csv', bytes: 4, text: 'a,b\n' }
    ]
    const segments = splitMemryFileBlocks(appendMemryFileBlocks('two files', files))

    expect(segments).toEqual([
      { kind: 'text', text: 'two files' },
      { kind: 'file', name: 'say "hi".txt', bytes: 2, content: 'hi' },
      { kind: 'file', name: 'data.csv', bytes: 4, content: 'a,b\n' }
    ])
  })

  it('leaves text without blocks and ordinary code fences alone', () => {
    const text = 'see\n```ts\nconst a = 1\n```'
    expect(splitMemryFileBlocks(text)).toEqual([{ kind: 'text', text }])
  })

  it('reads a UTF-8 text file with its byte size', async () => {
    const result = await readPromptFile(textFile('notes.md', 'çay\n'), 0)
    expect(result).toEqual({ ok: true, file: { name: 'notes.md', bytes: 5, text: 'çay\n' } })
  })

  it('refuses a file type outside the text allowlist', async () => {
    const result = await readPromptFile(textFile('photo.png', 'x'), 0)
    expect(result).toEqual({ ok: false, reason: 'unsupported_type' })
  })

  it('refuses bytes that are not UTF-8 text', async () => {
    const invalid = await readPromptFile(textFile('app.log', new Uint8Array([0xff, 0xfe])), 0)
    const binary = await readPromptFile(textFile('app.log', new Uint8Array([0x61, 0x00])), 0)
    expect(invalid).toEqual({ ok: false, reason: 'not_text' })
    expect(binary).toEqual({ ok: false, reason: 'not_text' })
  })

  it('refuses a file that would take the message over the size limit', async () => {
    const result = await readPromptFile(
      textFile('big.txt', 'a'.repeat(10)),
      PROMPT_FILES_MAX_BYTES - 5
    )
    expect(result).toEqual({ ok: false, reason: 'too_large' })
  })
})
