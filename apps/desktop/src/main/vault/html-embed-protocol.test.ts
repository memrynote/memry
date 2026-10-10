import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// The seam: right after the outside-vault check resolves the requested file,
// the file is swapped for a link to a file outside the vault, before it is read.
const race = vi.hoisted(() => ({ target: '', swap: (): void => {} }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const realpath = async (probe: string): Promise<string> => {
    const real = await actual.realpath(probe)
    if (race.target !== '' && probe === race.target) {
      race.target = ''
      race.swap()
    }
    return real
  }
  return { ...actual, default: { ...actual, realpath }, realpath }
})

import { HTML_EMBED_CSP, resolveHtmlEmbedFile, serveHtmlEmbed } from './html-embed-protocol'

/** `memry-html://local/<abs>` for a path, the shape the renderer builds. */
function embedUrl(absolutePath: string): string {
  return `memry-html://local${pathToFileURL(absolutePath).pathname}`
}

describe('memry-html protocol (#1872)', () => {
  let vault: string
  let noteDir: string

  beforeEach(() => {
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-html-')))
    noteDir = path.join(vault, 'attachments', 'note-1')
    fs.mkdirSync(noteDir, { recursive: true })
    fs.writeFileSync(path.join(noteDir, 'abc123-report.html'), '<h1>hi</h1>')
    fs.writeFileSync(path.join(noteDir, 'zzz999-notes.md'), '# secret')
    fs.mkdirSync(path.join(vault, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'notes', 'page.html'), '<p>not an attachment</p>')
  })

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true })
  })

  describe('resolveHtmlEmbedFile', () => {
    it('serves an html attachment inside the vault', () => {
      const file = path.join(noteDir, 'abc123-report.html')
      expect(resolveHtmlEmbedFile(embedUrl(file), [vault])).toBe(file)
    })

    it('refuses anything that is not html, even inside attachments', () => {
      expect(resolveHtmlEmbedFile(embedUrl(path.join(noteDir, 'zzz999-notes.md')), [vault])).toBe(
        null
      )
    })

    it('refuses html outside the attachments folder', () => {
      expect(resolveHtmlEmbedFile(embedUrl(path.join(vault, 'notes', 'page.html')), [vault])).toBe(
        null
      )
    })

    it('refuses traversal out of the attachments folder', () => {
      const escaped = `memry-html://local${pathToFileURL(noteDir).pathname}/../../notes/page.html`
      expect(resolveHtmlEmbedFile(escaped, [vault])).toBe(null)
    })

    it('refuses other schemes and a missing vault', () => {
      const file = path.join(noteDir, 'abc123-report.html')
      expect(
        resolveHtmlEmbedFile(embedUrl(file).replace('memry-html:', 'memry-file:'), [vault])
      ).toBe(null)
      expect(resolveHtmlEmbedFile(embedUrl(file), [null])).toBe(null)
    })

    it('remaps a path written on another device onto this vault', () => {
      const foreign = 'memry-html://local/Users/someone/vault/attachments/note-1/abc123-report.html'
      expect(resolveHtmlEmbedFile(foreign, [vault])).toBe(path.join(noteDir, 'abc123-report.html'))
    })

    it('heals a file renamed on disk', () => {
      fs.renameSync(path.join(noteDir, 'abc123-report.html'), path.join(noteDir, 'report.html'))
      const file = path.join(noteDir, 'abc123-report.html')
      expect(resolveHtmlEmbedFile(embedUrl(file), [vault])).toBe(path.join(noteDir, 'report.html'))
    })
  })

  describe('serveHtmlEmbed', () => {
    it('answers with the file and a sandboxing CSP', async () => {
      const file = path.join(noteDir, 'abc123-report.html')
      const response = await serveHtmlEmbed(new Request(embedUrl(file)), [vault])

      expect(response.status).toBe(200)
      expect(await response.text()).toBe('<h1>hi</h1>')
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('Content-Security-Policy')).toBe(HTML_EMBED_CSP)
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    })

    it('keeps a charset the document declares itself', async () => {
      const file = path.join(noteDir, 'latin.html')
      fs.writeFileSync(file, '<meta charset="windows-1254"><p>x</p>')
      const response = await serveHtmlEmbed(new Request(embedUrl(file)), [vault])
      expect(response.headers.get('Content-Type')).toBe('text/html')
    })

    it('404s anything it will not serve', async () => {
      const response = await serveHtmlEmbed(
        new Request(embedUrl(path.join(vault, 'notes', 'page.html'))),
        [vault]
      )
      expect(response.status).toBe(404)
    })

    it.skipIf(process.platform === 'win32')(
      'refuses an html attachment linked outside the vault',
      async () => {
        const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-out-')))
        try {
          const secret = path.join(outside, 'private.html')
          fs.writeFileSync(secret, '<p>outside secret</p>')
          const file = path.join(noteDir, 'linked.html')
          fs.symlinkSync(secret, file)
          const response = await serveHtmlEmbed(new Request(embedUrl(file)), [vault])
          expect(response.status).toBe(404)
          expect(await response.text()).not.toContain('outside')
        } finally {
          fs.rmSync(outside, { recursive: true, force: true })
        }
      }
    )

    it.skipIf(process.platform === 'win32')(
      'refuses an html attachment swapped for an outside link after the check',
      async () => {
        const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-out-')))
        try {
          const secret = path.join(outside, 'private.html')
          fs.writeFileSync(secret, '<p>outside secret</p>')
          const file = path.join(noteDir, 'abc123-report.html')
          race.target = file
          race.swap = () => {
            fs.rmSync(file)
            fs.symlinkSync(secret, file)
          }
          const response = await serveHtmlEmbed(new Request(embedUrl(file)), [vault])
          expect(response.status).toBe(404)
          expect(await response.text()).not.toContain('outside')
        } finally {
          race.target = ''
          fs.rmSync(outside, { recursive: true, force: true })
        }
      }
    )

    it('only answers GET', async () => {
      const file = path.join(noteDir, 'abc123-report.html')
      const response = await serveHtmlEmbed(
        new Request(embedUrl(file), { method: 'POST', body: 'x' }),
        [vault]
      )
      expect(response.status).toBe(405)
    })
  })

  describe('HTML_EMBED_CSP', () => {
    it('sandboxes without same-origin and keeps vault schemes out of reach', () => {
      expect(HTML_EMBED_CSP).toMatch(/^sandbox allow-scripts /)
      expect(HTML_EMBED_CSP).not.toContain('allow-same-origin')
      expect(HTML_EMBED_CSP).not.toContain('allow-top-navigation')
      expect(HTML_EMBED_CSP).not.toContain('memry-file')
      expect(HTML_EMBED_CSP).not.toContain("'self'")
      expect(HTML_EMBED_CSP).not.toMatch(/\bhttp:/)
    })
  })
})
