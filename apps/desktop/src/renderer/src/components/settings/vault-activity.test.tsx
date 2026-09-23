import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ListVaultActivityResult } from '@memry/contracts/vault-activity-api'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.path ? `${key}:${String(vars.path)}` : key
  })
}))

vi.mock('@/hooks/use-importers', () => ({
  useImporters: () => ({ importers: [], isLoading: false })
}))

import { VaultActivitySettings } from './vault-activity'

function renderActivity(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <VaultActivitySettings />
    </QueryClientProvider>
  )
}

const result = (fields: Partial<ListVaultActivityResult>): ListVaultActivityResult => ({
  entries: [],
  retentionDays: 30,
  available: true,
  ...fields
})

describe('VaultActivitySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists entries with their sentence', async () => {
    window.api.vaultActivity.list = vi.fn().mockResolvedValue(
      result({
        entries: [
          {
            v: 1,
            id: 'a',
            at: '2026-01-01T10:00:00.000Z',
            kind: 'skipped',
            source: 'watcher',
            path: 'docs/report.docx',
            reason: 'unsupported-type',
            message: '.docx'
          }
        ]
      })
    )

    renderActivity()

    expect(
      await screen.findByText('vault.activity.entry.skipped:docs/report.docx')
    ).toBeInTheDocument()
  })

  it('shows the empty state and refetches with the problems filter', async () => {
    window.api.vaultActivity.list = vi.fn().mockResolvedValue(result({}))

    renderActivity()

    expect(await screen.findByText('vault.activity.empty')).toBeInTheDocument()
    fireEvent.click(screen.getByText('vault.activity.filter.problems'))
    await waitFor(() =>
      expect(window.api.vaultActivity.list).toHaveBeenLastCalledWith({
        limit: 200,
        filter: 'problems'
      })
    )
    expect(await screen.findByText('vault.activity.emptyProblems')).toBeInTheDocument()
  })

  it('reveals the log file', async () => {
    window.api.vaultActivity.list = vi.fn().mockResolvedValue(result({}))

    renderActivity()

    fireEvent.click(await screen.findByText('vault.activity.reveal'))
    await waitFor(() => expect(window.api.vaultActivity.reveal).toHaveBeenCalled())
  })

  it('clears only after confirmation', async () => {
    window.api.vaultActivity.list = vi.fn().mockResolvedValue(
      result({
        entries: [
          {
            v: 1,
            id: 'a',
            at: '2026-01-01T10:00:00.000Z',
            kind: 'added',
            source: 'scan',
            path: 'a.md'
          }
        ]
      })
    )

    renderActivity()

    await screen.findByText('vault.activity.entry.added:a.md')
    fireEvent.click(screen.getByText('vault.activity.clear'))
    expect(window.api.vaultActivity.clear).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('vault.activity.clearConfirm'))
    await waitFor(() => expect(window.api.vaultActivity.clear).toHaveBeenCalled())
  })

  it('says to open a vault when none is open', async () => {
    window.api.vaultActivity.list = vi.fn().mockResolvedValue(result({ available: false }))

    renderActivity()

    expect(await screen.findByText('vault.activity.unavailable')).toBeInTheDocument()
  })
})
