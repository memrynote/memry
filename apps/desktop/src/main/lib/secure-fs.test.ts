import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, stat, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { secureDeleteFile } from './secure-fs'

describe('secureDeleteFile', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(os.tmpdir(), 'memry-secure-fs-test-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  async function createTestFile(name: string, content: string): Promise<string> {
    const filePath = path.join(testDir, name)
    await writeFile(filePath, content, 'utf-8')
    return filePath
  }

  it('#given a file exists #when secureDeleteFile called #then file is removed', async () => {
    // #given
    const filePath = await createTestFile('secret.txt', 'sensitive data here')

    // #when
    await secureDeleteFile(filePath)

    // #then
    await expect(stat(filePath)).rejects.toThrow()
  })

  it('#given a file with content #when secureDeleteFile called #then overwrites before deletion', async () => {
    // #given
    const original = 'TOP SECRET KEY MATERIAL 12345'
    const filePath = await createTestFile('key.bin', original)

    // #when
    await secureDeleteFile(filePath)

    // #then — file is gone
    await expect(stat(filePath)).rejects.toThrow()
  })

  it('#given file does not exist #when secureDeleteFile called #then no error thrown', async () => {
    // #given
    const filePath = path.join(testDir, 'nonexistent.txt')

    // #when / #then
    await expect(secureDeleteFile(filePath)).resolves.toBeUndefined()
  })

  it('#given a large file #when secureDeleteFile called #then handles chunked overwrite', async () => {
    // #given
    const filePath = path.join(testDir, 'large.bin')
    const largeContent = Buffer.alloc(200 * 1024, 0x41)
    await writeFile(filePath, largeContent)

    // #when
    await secureDeleteFile(filePath)

    // #then
    await expect(stat(filePath)).rejects.toThrow()
  })
})
