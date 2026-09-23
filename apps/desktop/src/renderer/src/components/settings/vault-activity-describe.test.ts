import { describe, it, expect } from 'vitest'
import type { VaultActivityEntry } from '@memry/contracts/vault-activity-api'
import { describeVaultActivity, formatActivityCounts } from './vault-activity-describe'

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}(${JSON.stringify(params)})` : key

const importerName = (id: string): string => (id === 'notion' ? 'Notion' : id)

function entry(fields: Partial<VaultActivityEntry>): VaultActivityEntry {
  return {
    v: 1,
    id: 'e1',
    at: '2026-01-01T00:00:00.000Z',
    kind: 'added',
    source: 'watcher',
    ...fields
  }
}

describe('describeVaultActivity', () => {
  it('names the file and the extension Memry does not open', () => {
    const result = describeVaultActivity(
      entry({ kind: 'skipped', path: 'docs/a.docx', reason: 'unsupported-type', message: '.docx' }),
      t,
      importerName
    )
    expect(result.title).toBe('vault.activity.entry.skipped({"path":"docs/a.docx"})')
    expect(result.detail).toBe('vault.activity.entry.skippedUnsupported({"ext":".docx"})')
    expect(result.tone).toBe('warning')
  })

  it('renders a rename with both paths', () => {
    const result = describeVaultActivity(
      entry({ kind: 'renamed', oldPath: 'a.md', path: 'b.md' }),
      t,
      importerName
    )
    expect(result.title).toBe('vault.activity.entry.renamed({"oldPath":"a.md","path":"b.md"})')
  })

  it('maps each failure reason to its own sentence', () => {
    const cases: [string, string][] = [
      ['read-failed', 'vault.activity.entry.readFailed'],
      ['index-failed', 'vault.activity.entry.indexFailed'],
      ['copy-failed', 'vault.activity.entry.copyFailed'],
      ['attachment-upload-failed', 'vault.activity.entry.uploadFailed'],
      ['attachment-download-failed', 'vault.activity.entry.downloadFailed'],
      ['file-too-large', 'vault.activity.entry.fileTooLarge'],
      ['a-reason-from-a-newer-build', 'vault.activity.entry.failedGeneric']
    ]
    for (const [reason, key] of cases) {
      const result = describeVaultActivity(
        entry({ kind: 'failed', path: 'x.pdf', reason }),
        t,
        importerName
      )
      expect(result.title).toBe(`${key}({"path":"x.pdf"})`)
    }
  })

  it('names a too-large note by its title when the entry carries one', () => {
    expect(
      describeVaultActivity(
        entry({ kind: 'failed', source: 'sync', reason: 'note-too-large', message: 'Big' }),
        t,
        importerName
      ).title
    ).toBe('vault.activity.entry.noteTooLarge({"title":"Big"})')
    expect(
      describeVaultActivity(
        entry({ kind: 'failed', source: 'sync', reason: 'note-too-large' }),
        t,
        importerName
      ).title
    ).toBe('vault.activity.entry.noteTooLargeUnnamed')
  })

  it('summarizes an import run with the importer name and counts', () => {
    const result = describeVaultActivity(
      entry({
        kind: 'import',
        source: 'import',
        importer: 'notion',
        counts: { imported: 3, attachments: 0, skipped: 1, failed: 0 }
      }),
      t,
      importerName
    )
    expect(result.title).toBe('vault.activity.entry.import({"importer":"Notion"})')
    expect(result.detail).toBe(
      'vault.activity.counts.imported({"count":3}) · vault.activity.counts.skipped({"count":1})'
    )
    expect(result.tone).toBe('warning')
  })

  it('does not call a rebuilt index "new files"', () => {
    const result = describeVaultActivity(
      entry({ kind: 'scan', source: 'scan', reason: 'index-rebuilt', counts: { added: 12 } }),
      t,
      importerName
    )
    expect(result.title).toBe('vault.activity.entry.indexRebuilt')
    expect(result.detail).toBe('vault.activity.counts.indexed({"count":12})')
  })
})

describe('formatActivityCounts', () => {
  it('skips zero counts and returns undefined when nothing is left', () => {
    expect(formatActivityCounts({ imported: 0, failed: 0 }, t)).toBeUndefined()
    expect(formatActivityCounts(undefined, t)).toBeUndefined()
  })
})
