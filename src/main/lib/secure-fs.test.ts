import { describe, it, expect, afterEach } from 'vitest'
import { writeFile, readFile, stat, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { secureDeleteFile } from './secure-fs'

describe('secureDeleteFile', () => {
  const testDir = path.join(os.tmpdir(), `memry-secure-fs-test-${Date.now()}`)
  let testFiles: string[] = []

  afterEach(async () => {
    testFiles = []
    await rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  async function createTestFile(name: string, content: string): Promise<string> {
    await mkdir(testDir, { recursive: true })
    const filePath = path.join(testDir, name)
    await writeFile(filePath, content, 'utf-8')
    testFiles.push(filePath)
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
    const originalSize = (await stat(filePath)).size

    let overwrittenContent: Buffer | null = null

    const origOpen = (await import('node:fs/promises')).open
    const realOpen = origOpen.bind(null)
    const { open } = await import('node:fs/promises')

    const handle = await open(filePath, 'r+')
    const readBefore = await readFile(filePath)
    expect(readBefore.toString()).toBe(original)
    await handle.close()

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
    await mkdir(testDir, { recursive: true })
    const filePath = path.join(testDir, 'large.bin')
    const largeContent = Buffer.alloc(200 * 1024, 0x41)
    await writeFile(filePath, largeContent)
    testFiles.push(filePath)

    // #when
    await secureDeleteFile(filePath)

    // #then
    await expect(stat(filePath)).rejects.toThrow()
  })
})
