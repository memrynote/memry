import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateContentHash } from './frontmatter'
import { scanMarkdownFile } from './file-scan'

describe('scanMarkdownFile', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-file-scan-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function write(name: string, content: string): string {
    const filePath = path.join(dir, name)
    fs.writeFileSync(filePath, content, 'utf8')
    return filePath
  }

  it('hashes a multi-chunk file to the same value as hashing it whole', async () => {
    // #given a file several read chunks long. Rename detection matches the
    // hash of a newly added file against the hash cached for a deleted one,
    // and only one of those two can come from a stream — so the streaming
    // hash has to equal the whole-string hash exactly or renames break.
    const content = 'alpha beta gamma delta\n'.repeat(40_000)
    const filePath = write('big.md', content)

    // #when
    const scan = await scanMarkdownFile(filePath)

    // #then
    expect(scan).not.toBeNull()
    expect(scan!.contentHash).toBe(generateContentHash(content))
  })

  it('counts words and characters across chunk boundaries', async () => {
    // #given a word deliberately long enough to straddle several chunks
    const content = `${'a'.repeat(200_000)} second third`
    const filePath = write('straddle.md', content)

    // #when
    const scan = await scanMarkdownFile(filePath)

    // #then the split word is counted once, not once per chunk
    expect(scan!.wordCount).toBe(3)
    expect(scan!.characterCount).toBe(content.length)
  })

  it('keeps only the requested head in memory', async () => {
    // #given a file far larger than the head budget
    const content = 'head text here\n'.repeat(50_000)
    const filePath = write('head.md', content)

    // #when
    const scan = await scanMarkdownFile(filePath, 1_024)

    // #then the head is bounded, while the counts still describe the whole file
    expect(scan!.head.length).toBeLessThan(1_024 + 128 * 1024)
    expect(scan!.head.startsWith('head text here')).toBe(true)
    expect(scan!.wordCount).toBe(3 * 50_000)
  })

  it('returns null for a file that is gone', async () => {
    // #given nothing at the path — the watcher can enqueue a backfill for a
    // file the user deletes a moment later
    const scan = await scanMarkdownFile(path.join(dir, 'missing.md'))

    // #then
    expect(scan).toBeNull()
  })

  it('handles an empty file', async () => {
    const filePath = write('empty.md', '')

    const scan = await scanMarkdownFile(filePath)

    expect(scan).toEqual({
      wordCount: 0,
      characterCount: 0,
      contentHash: generateContentHash(''),
      head: ''
    })
  })
})
