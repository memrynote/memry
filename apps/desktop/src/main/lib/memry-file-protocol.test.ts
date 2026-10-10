import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('../telemetry/diagnostics', () => ({ trackMainLog: () => undefined }))

import { serveMemryFile } from './memry-file-protocol'
import { toMemryFileUrl } from './paths'

const isWindows = process.platform === 'win32'

describe('memry-file:// (#3112)', () => {
  let vault: string
  let userData: string
  let outside: string
  let secret: string

  const get = (file: string, headers: HeadersInit = {}): Promise<Response> =>
    serveMemryFile(new Request(toMemryFileUrl(file), { headers }), userData, [vault, null])

  const text = async (response: Response): Promise<string> =>
    Buffer.from(await response.arrayBuffer()).toString('latin1')

  function write(relative: string, content: string): string {
    const file = path.join(vault, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    return file
  }

  beforeEach(() => {
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-file-vault-')))
    userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-file-userdata-')))
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-file-outside-')))
    secret = path.join(outside, 'private.pdf')
    fs.writeFileSync(secret, 'outside secret bytes')
  })

  afterEach(() => {
    race.target = ''
    for (const dir of [vault, userData, outside]) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('serves an inside file whole and in ranges', async () => {
    const file = write('attachments/n1/doc.pdf', '%PDF-0123456789')

    const whole = await get(file)
    expect(whole.status).toBe(200)
    expect(await text(whole)).toBe('%PDF-0123456789')

    const range = await get(file, { Range: 'bytes=5-8' })
    expect(range.status).toBe(206)
    expect(range.headers.get('Content-Range')).toBe('bytes 5-8/15')
    expect(await text(range)).toBe('0123')

    const tail = await get(file, { Range: 'bytes=11-' })
    expect(tail.headers.get('Content-Range')).toBe('bytes 11-14/15')
    expect(await text(tail)).toBe('6789')
  })

  it('serves a userData file', async () => {
    const file = path.join(userData, 'thumb.png')
    fs.writeFileSync(file, 'png bytes')
    const response = await get(file)
    expect(response.status).toBe(200)
    expect(await text(response)).toBe('png bytes')
  })

  it('serves a path from another device and a renamed attachment', async () => {
    write('attachments/n1/abc123-photo.png', 'png bytes')

    const remapped = await get('/Users/other/vault/attachments/n1/abc123-photo.png')
    expect(await text(remapped)).toBe('png bytes')

    const healed = await get(path.join(vault, 'attachments/n1/abc123-old-name.png'))
    expect(await text(healed)).toBe('png bytes')
  })

  it('answers a missing image with the blank png and a missing pdf with 404', async () => {
    const png = await get(path.join(vault, 'attachments/n1/gone.png'))
    expect(png.status).toBe(200)
    expect(png.headers.get('Content-Type')).toBe('image/png')
    expect((await get(path.join(vault, 'attachments/n1/gone.pdf'))).status).toBe(404)
  })

  it.skipIf(isWindows)('refuses a vault file linked outside the vault', async () => {
    const link = path.join(vault, 'attachments/n1/photo.pdf')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(secret, link)

    for (const headers of [{}, { Range: 'bytes=0-6' }] as HeadersInit[]) {
      const response = await get(link, headers)
      expect(response.status).toBe(403)
      expect(await text(response)).not.toContain('outside')
    }
  })

  it.skipIf(isWindows)('refuses a file swapped for an outside link after the check', async () => {
    for (const headers of [{}, { Range: 'bytes=0-6' }] as HeadersInit[]) {
      const file = write('attachments/n1/scan.pdf', '%PDF-inside')
      race.target = file
      race.swap = () => {
        fs.rmSync(file)
        fs.symlinkSync(secret, file)
      }
      const response = await get(file, headers)
      expect(response.status).toBe(403)
      expect(await text(response)).not.toContain('outside')
      fs.rmSync(file)
    }
  })
})
