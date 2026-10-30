import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VaultActivityList } from '../../../../generated/bindings'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  clear: vi.fn(),
  reveal: vi.fn(),
  setRetention: vi.fn(),
  onChanged: null as (() => void) | null
}))

vi.mock('../../../../generated/bindings', () => ({
  commands: {
    vaultActivityList: api.list,
    vaultActivityClear: api.clear,
    vaultActivityReveal: api.reveal,
    vaultActivitySetRetention: api.setRetention
  },
  events: {
    vaultActivityChangedEvent: {
      listen: (handler: (event: { payload: null }) => void) => {
        api.onChanged = () => handler({ payload: null })
        return Promise.resolve(() => {})
      }
    }
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars?.path
        ? `${key}:${String(vars.path)}`
        : vars?.importer
          ? `${key}:${String(vars.importer)}`
          : key
  })
}))

vi.mock('@/hooks/use-importers', () => ({
  useImporters: () => ({ importers: [{ id: 'notion', name: 'Notion' }], isLoading: false })
}))

const toastMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

import { VaultActivitySettings } from './vault-activity'

function renderActivity(props: Parameters<typeof VaultActivitySettings>[0] = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <VaultActivitySettings {...props} />
    </QueryClientProvider>
  )
}

const result = (fields: Partial<VaultActivityList>): VaultActivityList => ({
  entries: [],
  retentionDays: 30,
  available: true,
  ...fields
})

describe('VaultActivitySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.clear.mockResolvedValue(null)
    api.reveal.mockResolvedValue(true)
    api.setRetention.mockResolvedValue(null)
    api.onChanged = null
  })

  it('lists entries with their sentence', async () => {
    api.list.mockResolvedValue(
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
    api.list.mockResolvedValue(result({}))

    renderActivity()

    expect(await screen.findByText('vault.activity.empty')).toBeInTheDocument()
    fireEvent.click(screen.getByText('vault.activity.filter.problems'))
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(200, 'problems'))
    expect(await screen.findByText('vault.activity.emptyProblems')).toBeInTheDocument()
  })

  it('reveals the log file', async () => {
    api.list.mockResolvedValue(result({}))

    renderActivity()

    fireEvent.click(await screen.findByText('vault.activity.reveal'))
    await waitFor(() => expect(api.reveal).toHaveBeenCalled())
  })

  it('clears only after confirmation', async () => {
    api.list.mockResolvedValue(
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
    expect(api.clear).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('vault.activity.clearConfirm'))
    await waitFor(() => expect(api.clear).toHaveBeenCalled())
  })

  it('names the importer and expands a summary into its items', async () => {
    api.list.mockResolvedValue(
      result({
        entries: [
          {
            v: 1,
            id: 'i',
            at: '2026-01-01T10:00:00.000Z',
            kind: 'import',
            source: 'import',
            importer: 'notion',
            counts: { imported: 1, failed: 1 },
            items: ['Broken page \u2014 bad html']
          }
        ]
      })
    )

    renderActivity()

    expect(await screen.findByText('vault.activity.entry.import:Notion')).toBeInTheDocument()
    expect(screen.getByText('Broken page \u2014 bad html')).toBeInTheDocument()
  })

  it('scrolls itself into view when Settings asks for it', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    api.list.mockResolvedValue(result({}))

    renderActivity({ focusTarget: 'vault-activity', focusRequestId: 1 })

    await screen.findByText('vault.activity.empty')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  })

  it('does not scroll for another section focus target', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    api.list.mockResolvedValue(result({}))

    renderActivity({ focusTarget: 'voice-local-model', focusRequestId: 1 })

    await screen.findByText('vault.activity.empty')
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('shows a load failure in place of the list', async () => {
    api.list.mockRejectedValue(new Error('disk gone'))

    renderActivity()

    expect(await screen.findByText('disk gone')).toBeInTheDocument()
  })

  it('reports a failed reveal or clear with a toast', async () => {
    api.list.mockResolvedValue(
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
    api.reveal.mockRejectedValue(new Error('no finder'))
    api.clear.mockRejectedValue(new Error('read-only'))

    renderActivity()

    await screen.findByText('vault.activity.entry.added:a.md')
    fireEvent.click(screen.getByText('vault.activity.reveal'))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('no finder'))

    fireEvent.click(screen.getByText('vault.activity.clear'))
    fireEvent.click(screen.getByText('vault.activity.clearConfirm'))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('read-only'))
  })

  it('refetches when the main process says the log changed', async () => {
    api.list.mockResolvedValue(result({}))

    renderActivity()

    await screen.findByText('vault.activity.empty')
    const calls = api.list.mock.calls.length
    api.onChanged?.()
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(calls))
  })

  it('says to open a vault when none is open', async () => {
    api.list.mockResolvedValue(result({ available: false }))

    renderActivity()

    expect(await screen.findByText('vault.activity.unavailable')).toBeInTheDocument()
  })
})
