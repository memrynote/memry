/**
 * Tests for attachment-rename-reconcile.ts (#1714) — the half that makes a
 * rename real on the OTHER devices. The blob is never re-uploaded, so a peer's
 * only evidence is the body change; these cover what that evidence licenses and,
 * just as importantly, what it does not (an external rename is left alone).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  extractAttachmentFilenames,
  planAttachmentRenames,
  reconcileDownloadedAttachmentName,
  reconcileRenamedAttachments
} from './attachment-rename-reconcile'

// statSync passes through unless a test reports the ino 0 some mounts return.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, statSync: vi.fn(actual.statSync) }
})

const NOTE_ID = 'n1'

let vaultPath = ''

function attachmentsDir(): string {
  return path.join(vaultPath, 'attachments', NOTE_ID)
}

function writeAttachment(filename: string): string {
  const dir = attachmentsDir()
  fs.mkdirSync(dir, { recursive: true })
  const absolute = path.join(dir, filename)
  fs.writeFileSync(absolute, 'bytes')
  return absolute
}

function body(...filenames: string[]): string {
  return filenames
    .map(
      (f) =>
        `<!-- file:{"url":"../attachments/${NOTE_ID}/${f}","name":"x","size":1,"mimeType":"application/pdf"} -->`
    )
    .join('\n\n')
}

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-reconcile-'))
})

afterEach(() => {
  vi.mocked(fs.statSync).mockRestore()
  fs.rmSync(vaultPath, { recursive: true, force: true })
})

describe('extractAttachmentFilenames', () => {
  it('finds refs in file markers, image links and legacy absolute urls', () => {
    const markdown = [
      body('k3f9x2-report.pdf'),
      `![pic](../attachments/${NOTE_ID}/aaaaaa-photo.png)`,
      `![old](memry-file://local/Users/someone/Vault/attachments/${NOTE_ID}/bbbbbb-legacy.png)`
    ].join('\n\n')

    expect(extractAttachmentFilenames(NOTE_ID, markdown)).toEqual(
      new Set(['k3f9x2-report.pdf', 'aaaaaa-photo.png', 'bbbbbb-legacy.png'])
    )
  })

  it('decodes percent-encoded refs', () => {
    expect(
      extractAttachmentFilenames(NOTE_ID, `![p](../attachments/${NOTE_ID}/aaaaaa-my%20file.png)`)
    ).toEqual(new Set(['aaaaaa-my file.png']))
  })

  it('ignores another note’s attachments', () => {
    expect(
      extractAttachmentFilenames(NOTE_ID, `![p](../attachments/other/aaaaaa-photo.png)`)
    ).toEqual(new Set())
  })
})

describe('planAttachmentRenames', () => {
  it('pairs a ref that left with the one that arrived under the same prefix', () => {
    expect(
      planAttachmentRenames(new Set(['k3f9x2-scan.pdf']), new Set(['k3f9x2-invoice.pdf']))
    ).toEqual([{ from: 'k3f9x2-scan.pdf', to: 'k3f9x2-invoice.pdf' }])
  })

  it('pairs two renames in the same body change independently', () => {
    expect(
      planAttachmentRenames(
        new Set(['aaaaaa-one.pdf', 'bbbbbb-two.pdf']),
        new Set(['aaaaaa-first.pdf', 'bbbbbb-second.pdf'])
      )
    ).toEqual([
      { from: 'aaaaaa-one.pdf', to: 'aaaaaa-first.pdf' },
      { from: 'bbbbbb-two.pdf', to: 'bbbbbb-second.pdf' }
    ])
  })

  it('is silent for a deleted block and for a newly added one', () => {
    expect(planAttachmentRenames(new Set(['k3f9x2-scan.pdf']), new Set())).toEqual([])
    expect(planAttachmentRenames(new Set(), new Set(['k3f9x2-scan.pdf']))).toEqual([])
  })

  it('refuses to guess when the same prefix has two candidates', () => {
    expect(
      planAttachmentRenames(new Set(['k3f9x2-scan.pdf']), new Set(['k3f9x2-a.pdf', 'k3f9x2-b.pdf']))
    ).toEqual([])
  })

  it('ignores prefix-less filenames, which carry no identity to pair on', () => {
    expect(planAttachmentRenames(new Set(['scan.pdf']), new Set(['invoice.pdf']))).toEqual([])
  })
})

describe('reconcileRenamedAttachments', () => {
  it('renames this device’s file to the name the synced body asks for', () => {
    writeAttachment('k3f9x2-scan.pdf')

    const applied = reconcileRenamedAttachments(
      NOTE_ID,
      body('k3f9x2-scan.pdf'),
      body('k3f9x2-invoice.pdf'),
      vaultPath
    )

    expect(applied).toEqual([{ from: 'k3f9x2-scan.pdf', to: 'k3f9x2-invoice.pdf' }])
    expect(fs.existsSync(path.join(attachmentsDir(), 'k3f9x2-invoice.pdf'))).toBe(true)
    expect(fs.existsSync(path.join(attachmentsDir(), 'k3f9x2-scan.pdf'))).toBe(false)
  })

  it('is a no-op on the device that already renamed the file', () => {
    writeAttachment('k3f9x2-invoice.pdf')

    expect(
      reconcileRenamedAttachments(
        NOTE_ID,
        body('k3f9x2-scan.pdf'),
        body('k3f9x2-invoice.pdf'),
        vaultPath
      )
    ).toEqual([])
    expect(fs.existsSync(path.join(attachmentsDir(), 'k3f9x2-invoice.pdf'))).toBe(true)
  })

  it('never overwrites a file already holding the target name', () => {
    writeAttachment('k3f9x2-scan.pdf')
    fs.writeFileSync(path.join(attachmentsDir(), 'k3f9x2-invoice.pdf'), 'other-bytes')

    expect(
      reconcileRenamedAttachments(
        NOTE_ID,
        body('k3f9x2-scan.pdf'),
        body('k3f9x2-invoice.pdf'),
        vaultPath
      )
    ).toEqual([])
    expect(fs.readFileSync(path.join(attachmentsDir(), 'k3f9x2-invoice.pdf'), 'utf8')).toBe(
      'other-bytes'
    )
  })

  it('leaves a file renamed outside the app alone — the body did not change', () => {
    // #1713's case: this device's disk moved, the note did not. Self-heal serves
    // it; renaming it back here would undo what the user did in Finder.
    writeAttachment('k3f9x2-renamed-by-hand.pdf')
    const unchanged = body('k3f9x2-scan.pdf')

    expect(reconcileRenamedAttachments(NOTE_ID, unchanged, unchanged, vaultPath)).toEqual([])
    expect(fs.existsSync(path.join(attachmentsDir(), 'k3f9x2-renamed-by-hand.pdf'))).toBe(true)
  })

  it('does nothing without a previous body (a note written for the first time)', () => {
    writeAttachment('k3f9x2-scan.pdf')
    expect(
      reconcileRenamedAttachments(NOTE_ID, null, body('k3f9x2-invoice.pdf'), vaultPath)
    ).toEqual([])
  })
})

describe('reconcileDownloadedAttachmentName', () => {
  it('renames a freshly downloaded file to the name the body carries', async () => {
    // The manifest froze the name at upload, so sync lands the OLD one here.
    const downloaded = writeAttachment('k3f9x2-scan.pdf')

    const result = await reconcileDownloadedAttachmentName(
      NOTE_ID,
      downloaded,
      body('k3f9x2-invoice.pdf'),
      vaultPath
    )

    expect(result).toBe(path.join(attachmentsDir(), 'k3f9x2-invoice.pdf'))
    expect(fs.existsSync(path.join(attachmentsDir(), 'k3f9x2-invoice.pdf'))).toBe(true)
    expect(fs.existsSync(downloaded)).toBe(false)
  })

  it('leaves a download the body already names alone', async () => {
    const downloaded = writeAttachment('k3f9x2-invoice.pdf')

    expect(
      await reconcileDownloadedAttachmentName(
        NOTE_ID,
        downloaded,
        body('k3f9x2-invoice.pdf'),
        vaultPath
      )
    ).toBe(downloaded)
  })

  it('leaves a download the body has no unique match for alone', async () => {
    const downloaded = writeAttachment('k3f9x2-scan.pdf')

    expect(
      await reconcileDownloadedAttachmentName(
        NOTE_ID,
        downloaded,
        body('k3f9x2-a.pdf', 'k3f9x2-b.pdf'),
        vaultPath
      )
    ).toBe(downloaded)
    expect(fs.existsSync(downloaded)).toBe(true)
  })

  it('refuses a path outside this note’s attachments folder', async () => {
    const outside = path.join(vaultPath, 'attachments', 'other', 'k3f9x2-scan.pdf')
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    fs.writeFileSync(outside, 'bytes')

    expect(
      await reconcileDownloadedAttachmentName(
        NOTE_ID,
        outside,
        body('k3f9x2-invoice.pdf'),
        vaultPath
      )
    ).toBeNull()
    expect(fs.existsSync(outside)).toBe(true)
  })
})

function fileSystemIgnoresCase(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '')
    return fs.existsSync(path.join(dir, 'PROBE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// REVIEW-5749: a ref that differs from the manifest name only by case names
// the download itself on a case-insensitive FS. It must never be deleted as
// its own duplicate.
describe.runIf(fileSystemIgnoresCase())('reconcileDownloadedAttachmentName, case-only ref', () => {
  it('gives the download the body’s spelling and keeps its bytes', async () => {
    const downloaded = writeAttachment('abc123-photo.png')

    const result = await reconcileDownloadedAttachmentName(
      NOTE_ID,
      downloaded,
      `![x](attachments/${NOTE_ID}/abc123-Photo.png)`,
      vaultPath
    )

    expect(result).toBe(path.join(attachmentsDir(), 'abc123-Photo.png'))
    expect(fs.readdirSync(attachmentsDir())).toEqual(['abc123-Photo.png'])
    expect(fs.readFileSync(result!, 'utf8')).toBe('bytes')
  })

  it('keeps local edits of a file the download skipped as already materialized', async () => {
    // The skip hands back the manifest's spelling of the file on disk, which
    // holds this device's edits the server lacks.
    fs.mkdirSync(attachmentsDir(), { recursive: true })
    fs.writeFileSync(path.join(attachmentsDir(), 'abc123-Photo.png'), 'edited here')
    const skipped = path.join(attachmentsDir(), 'abc123-photo.png')

    const result = await reconcileDownloadedAttachmentName(
      NOTE_ID,
      skipped,
      `![x](attachments/${NOTE_ID}/abc123-Photo.png)`,
      vaultPath
    )

    expect(fs.readdirSync(attachmentsDir())).toEqual(['abc123-Photo.png'])
    expect(fs.readFileSync(result!, 'utf8')).toBe('edited here')
  })
})

// VERIFY-5749R2: some mounts (SMB/WebDAV redirectors, virtual cloud drives,
// FUSE) report ino 0 for every file, which proves neither same nor different.
describe.runIf(fileSystemIgnoresCase())('reconcileDownloadedAttachmentName, ino 0', () => {
  beforeEach(() => {
    const realStatSync = vi.mocked(fs.statSync).getMockImplementation()!
    vi.mocked(fs.statSync).mockImplementation((p: fs.PathLike, options?: fs.StatOptions) => {
      const stats = realStatSync(p, options)
      if (stats && options?.bigint) (stats as fs.BigIntStats).ino = 0n
      return stats
    })
  })

  it('keeps a different file whose name differs from the body only by case', async () => {
    fs.mkdirSync(attachmentsDir(), { recursive: true })
    const downloaded = path.join(attachmentsDir(), 'abc123-scan.pdf')
    fs.writeFileSync(downloaded, 'server')
    fs.writeFileSync(path.join(attachmentsDir(), 'abc123-invoice.pdf'), 'edited')

    const result = await reconcileDownloadedAttachmentName(
      NOTE_ID,
      downloaded,
      `![x](attachments/${NOTE_ID}/abc123-Invoice.pdf)`,
      vaultPath
    )

    expect(result).toBe(downloaded)
    expect(fs.readdirSync(attachmentsDir()).toSorted()).toEqual([
      'abc123-invoice.pdf',
      'abc123-scan.pdf'
    ])
    expect(fs.readFileSync(downloaded, 'utf8')).toBe('server')
    expect(fs.readFileSync(path.join(attachmentsDir(), 'abc123-invoice.pdf'), 'utf8')).toBe(
      'edited'
    )
  })

  it('keeps the only copy of a case-only download', async () => {
    const downloaded = writeAttachment('abc123-photo.png')

    const result = await reconcileDownloadedAttachmentName(
      NOTE_ID,
      downloaded,
      `![x](attachments/${NOTE_ID}/abc123-Photo.png)`,
      vaultPath
    )

    expect(fs.readdirSync(attachmentsDir())).toHaveLength(1)
    expect(fs.readFileSync(result!, 'utf8')).toBe('bytes')
  })
})
