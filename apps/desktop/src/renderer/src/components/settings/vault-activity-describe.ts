/**
 * Turns a vault activity entry into the sentence Settings shows for it.
 *
 * Kept apart from the component so every kind/reason pairing is testable
 * without rendering, and so an entry written by a newer build (a kind or reason
 * this one does not know) still renders as something readable.
 *
 * @module components/settings/vault-activity-describe
 */

import type { VaultActivityEntry } from '@memry/contracts/vault-activity-api'

export type Translate = (key: string, params?: Record<string, unknown>) => string

export type VaultActivityTone = 'neutral' | 'warning' | 'error'

export interface VaultActivityDescription {
  title: string
  /** Secondary line: cause, hint, or raw error text. */
  detail?: string
  tone: VaultActivityTone
}

/** Count keys in display order, each rendered through `vault.activity.counts.<key>`. */
const COUNT_KEYS = ['added', 'imported', 'attachments', 'skipped', 'unsupported', 'failed'] as const

const COUNT_LABEL_KEYS: Record<(typeof COUNT_KEYS)[number], string> = {
  added: 'vault.activity.counts.added',
  imported: 'vault.activity.counts.imported',
  attachments: 'vault.activity.counts.attachments',
  skipped: 'vault.activity.counts.skipped',
  unsupported: 'vault.activity.counts.unsupported',
  failed: 'vault.activity.counts.failed'
}

export function formatActivityCounts(
  counts: Record<string, number> | undefined,
  t: Translate,
  options: { rebuilt?: boolean } = {}
): string | undefined {
  if (!counts) return undefined
  const parts: string[] = []
  for (const key of COUNT_KEYS) {
    const count = counts[key]
    if (!count) continue
    // A rebuild re-reads every file; "new" would claim they were just added.
    const labelKey =
      key === 'added' && options.rebuilt ? 'vault.activity.counts.indexed' : COUNT_LABEL_KEYS[key]
    parts.push(t(labelKey, { count }))
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function describeFailure(
  entry: VaultActivityEntry,
  t: Translate,
  importerName: string
): VaultActivityDescription {
  const path = entry.path ?? ''
  switch (entry.reason) {
    case 'read-failed':
      return {
        title: t('vault.activity.entry.readFailed', { path }),
        detail: entry.message,
        tone: 'error'
      }
    case 'index-failed':
      return {
        title: t('vault.activity.entry.indexFailed', { path }),
        detail: entry.message,
        tone: 'error'
      }
    case 'copy-failed':
      return {
        title: t('vault.activity.entry.copyFailed', { path }),
        detail: entry.message,
        tone: 'error'
      }
    case 'attachment-upload-failed':
      return {
        title: t('vault.activity.entry.uploadFailed', { path }),
        detail: t('vault.activity.entry.uploadFailedHint'),
        tone: 'error'
      }
    case 'attachment-download-failed':
      return {
        title: t('vault.activity.entry.downloadFailed', { path }),
        detail: entry.message,
        tone: 'error'
      }
    case 'file-too-large':
      return { title: t('vault.activity.entry.fileTooLarge', { path }), tone: 'warning' }
    case 'note-too-large':
      return {
        title: entry.message
          ? t('vault.activity.entry.noteTooLarge', { title: entry.message })
          : t('vault.activity.entry.noteTooLargeUnnamed'),
        tone: 'warning'
      }
    case 'import-failed':
      return {
        title: t('vault.activity.entry.importFailed', { importer: importerName }),
        detail: entry.message,
        tone: 'error'
      }
    default:
      return {
        title: path
          ? t('vault.activity.entry.failedGeneric', { path })
          : t('vault.activity.entry.failedGenericUnnamed'),
        detail: entry.message,
        tone: 'error'
      }
  }
}

export function describeVaultActivity(
  entry: VaultActivityEntry,
  t: Translate,
  resolveImporterName: (id: string) => string
): VaultActivityDescription {
  const path = entry.path ?? ''
  const importerName = entry.importer ? resolveImporterName(entry.importer) : ''

  switch (entry.kind) {
    case 'added':
      return { title: t('vault.activity.entry.added', { path }), tone: 'neutral' }
    case 'removed':
      return { title: t('vault.activity.entry.removed', { path }), tone: 'neutral' }
    case 'renamed':
      return {
        title: t('vault.activity.entry.renamed', { oldPath: entry.oldPath ?? '', path }),
        tone: 'neutral'
      }
    case 'skipped':
      return {
        title: t('vault.activity.entry.skipped', { path }),
        detail:
          entry.reason === 'unsupported-type' && entry.message
            ? t('vault.activity.entry.skippedUnsupported', { ext: entry.message })
            : entry.message,
        tone: 'warning'
      }
    case 'failed':
      return describeFailure(entry, t, importerName)
    case 'scan': {
      const rebuilt = entry.reason === 'index-rebuilt'
      const hasProblems = !!(entry.counts?.failed || entry.counts?.unsupported)
      return {
        title: rebuilt ? t('vault.activity.entry.indexRebuilt') : t('vault.activity.entry.scan'),
        detail: formatActivityCounts(entry.counts, t, { rebuilt }),
        tone: hasProblems ? 'warning' : 'neutral'
      }
    }
    case 'import': {
      const canceled = entry.reason === 'import-canceled'
      const failed = entry.counts?.failed ?? 0
      return {
        title: canceled
          ? t('vault.activity.entry.importCanceled', { importer: importerName })
          : t('vault.activity.entry.import', { importer: importerName }),
        detail: formatActivityCounts(entry.counts, t),
        tone: failed > 0 ? 'error' : (entry.counts?.skipped ?? 0) > 0 ? 'warning' : 'neutral'
      }
    }
    default:
      return {
        title: t('vault.activity.entry.unknown'),
        detail: path || entry.message,
        tone: 'neutral'
      }
  }
}
