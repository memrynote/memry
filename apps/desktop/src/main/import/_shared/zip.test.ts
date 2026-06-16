import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { forEachZipEntry, assertSafeEntryPath } from './zip'

const FIXTURE = path.join(__dirname, '..', 'notion', '__fixtures__', 'notion-export.zip')

describe('shared zip iteration', () => {
  it('recurses into the nested Part-1.zip and yields html entries', async () => {
    const names: string[] = []
    await forEachZipEntry([FIXTURE], new AbortController().signal, async (entry) => {
      names.push(entry.filepath)
    })
    expect(names.some((n) => n.endsWith('.html'))).toBe(true)
    // The nested child page proves recursion into the inner zip worked.
    expect(names.some((n) => n.includes('Child Page'))).toBe(true)
  })

  it('does not surface the nested zip itself as an entry', async () => {
    const names: string[] = []
    await forEachZipEntry([FIXTURE], new AbortController().signal, async (entry) => {
      names.push(entry.filepath)
    })
    expect(names.some((n) => n.endsWith('.zip'))).toBe(false)
  })

  it('exposes name, extension and parent for a nested entry', async () => {
    let child: { name: string; extension: string; parent: string } | undefined
    await forEachZipEntry([FIXTURE], new AbortController().signal, async (entry) => {
      if (entry.name.startsWith('Child Page')) {
        child = { name: entry.name, extension: entry.extension, parent: entry.parent }
      }
    })
    expect(child?.extension).toBe('html')
    expect(child?.parent).toContain('Parent Page')
  })

  it('reads entry bytes and text', async () => {
    let text = ''
    await forEachZipEntry([FIXTURE], new AbortController().signal, async (entry) => {
      if (entry.name.startsWith('Parent Page') && entry.extension === 'html') {
        text = await entry.readText()
      }
    })
    expect(text).toContain('<title>Parent Page</title>')
  })

  it('rejects a zip-slip entry path', () => {
    expect(() => assertSafeEntryPath('../../etc/passwd')).toThrow(/unsafe/i)
    expect(() => assertSafeEntryPath('a/b/c.html')).not.toThrow()
  })

  it('stops iterating when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const names: string[] = []
    await forEachZipEntry([FIXTURE], ac.signal, async (entry) => {
      names.push(entry.filepath)
    })
    expect(names.length).toBe(0)
  })
})
