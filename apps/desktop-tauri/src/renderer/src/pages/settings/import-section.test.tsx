import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { DEFAULT_IMPORT_ICON } from '@/lib/import-catalog'
import type { ImporterItem } from '@/hooks/use-importers'

function importer(id: string, name: string, extensions: string[]): ImporterItem {
  return {
    id,
    name,
    descriptionKey: `import.sources.${id}`,
    fileSpec: { label: name, extensions, allowMultiple: true },
    supportsPreview: false,
    icon: DEFAULT_IMPORT_ICON
  }
}

const importers: ImporterItem[] = [
  importer('markdown', 'Markdown', ['md', 'markdown']),
  importer('todoist', 'Todoist', ['csv']),
  importer('notion', 'Notion', ['zip']),
  importer('evernote', 'Evernote', ['enex']),
  importer('apple-notes', 'Apple Notes', ['sqlite']),
  importer('bear', 'Bear', ['bear2bk', 'zip']),
  { ...importer('onenote', 'OneNote', []), accountBased: true },
  importer('roam', 'Roam', ['json']),
  { ...importer('readwise', 'Readwise', []), accountBased: true }
]

let readwiseStatus: unknown = null

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, string | number | undefined>) =>
      vars?.count !== undefined ? `${key}:${vars.count}` : key,
    i18n: { language: 'en' }
  })
}))
vi.mock('@/hooks/use-readwise-status', () => ({
  useReadwiseStatus: () => ({ status: readwiseStatus, refresh: () => {} })
}))
vi.mock('@/hooks/use-importers', () => ({
  useImporters: () => ({ importers, isLoading: false })
}))
vi.mock('@/components/settings/import-dialog', () => ({
  ImportDialog: ({ item, open }: { item: ImporterItem | null; open: boolean }) =>
    open ? <div data-testid="import-dialog">{item?.name}</div> : null
}))

import { ImportSettings } from './import-section'

describe('ImportSettings', () => {
  it('groups sources and lists every note app', () => {
    render(<ImportSettings />)

    const noteApps = screen.getByTestId('import-group-noteApps')
    expect(within(noteApps).getAllByRole('listitem')).toHaveLength(6)
    expect(within(noteApps).getByTestId('import-source-notion')).toHaveTextContent('.zip')
    expect(within(noteApps).getByTestId('import-source-apple-notes')).toHaveTextContent('macOS')
    expect(within(noteApps).getByTestId('import-source-roam')).toBeInTheDocument()
    expect(within(noteApps).getAllByRole('listitem')).toHaveLength(6)
    expect(within(noteApps).getByTestId('import-source-onenote')).toHaveTextContent(
      'import.v2.formatAccount'
    )

    expect(
      within(screen.getByTestId('import-group-tasks')).getByTestId('import-source-todoist')
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('import-group-files')).getByTestId('import-source-markdown')
    ).toHaveTextContent('.md')
  })

  it('lists Readwise first, in its own reading group, with its connection state', () => {
    readwiseStatus = null
    const { unmount } = render(<ImportSettings />)
    const reading = screen.getByTestId('import-group-reading')
    expect(screen.getAllByTestId(/^import-group-/)[0].getAttribute('data-testid')).toBe(
      'import-group-reading'
    )
    expect(within(reading).getByTestId('import-source-readwise')).toHaveTextContent(
      'import.v2.readwise.notConnected'
    )
    unmount()

    const states: Array<[Record<string, unknown>, string]> = [
      [{ error: { kind: 'invalid-token' } }, 'import.v2.readwise.invalidToken'],
      [{ error: { kind: 'subscription-expired' } }, 'import.v2.readwise.subscriptionExpired'],
      [{ error: { kind: 'rate-limited' } }, 'import.v2.readwise.rateLimited'],
      [{ error: { kind: 'network' } }, 'import.v2.readwise.network'],
      [{ error: { kind: 'server' } }, 'import.v2.readwise.server'],
      [{ error: { kind: 'unexpected' } }, 'import.v2.readwise.unexpected'],
      [{ syncing: { stage: 'reading', planned: null, done: 0 } }, 'import.v2.readwise.syncing'],
      [
        { syncing: { stage: 'waiting-for-sync', planned: null, done: 0 } },
        'import.v2.readwise.waiting'
      ],
      [
        { lastSyncAt: new Date(Date.now() - 5 * 60_000).toISOString() },
        'import.v2.readwise.synced'
      ],
      [{}, 'import.v2.readwise.connected']
    ]
    for (const [over, text] of states) {
      readwiseStatus = {
        connected: true,
        thisDevicePulls: true,
        syncing: null,
        error: null,
        lastSyncAt: null,
        ...over
      }
      const rendered = render(<ImportSettings />)
      expect(screen.getByTestId('import-source-readwise')).toHaveTextContent(text)
      rendered.unmount()
    }

    // The token stays on the pulling device, so another device is never "connected".
    readwiseStatus = {
      connected: false,
      thisDevicePulls: false,
      pullingDeviceName: 'Desk Mac',
      syncing: null,
      error: null
    }
    render(<ImportSettings />)
    expect(screen.getByTestId('import-source-readwise')).toHaveTextContent(
      'import.v2.readwise.otherDevice'
    )
    readwiseStatus = null
  })

  it('opens the Readwise panel when the error toast asks for it', () => {
    render(<ImportSettings focusTarget="readwise-import" focusRequestId={1} />)
    expect(screen.getByTestId('import-dialog')).toHaveTextContent('Readwise')
  })

  it('filters by name, id, and file extension', () => {
    render(<ImportSettings />)
    const search = screen.getByRole('searchbox')

    fireEvent.change(search, { target: { value: '.enex' } })
    expect(screen.getByTestId('import-source-evernote')).toBeInTheDocument()
    expect(screen.queryByTestId('import-source-notion')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'csv' } })
    expect(screen.getByTestId('import-source-todoist')).toBeInTheDocument()
    expect(screen.queryByTestId('import-group-noteApps')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'apple-notes' } })
    expect(screen.getByTestId('import-source-apple-notes')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('import.v2.noMatch')).toBeInTheDocument()
  })

  it('opens the import dialog for the clicked source', () => {
    render(<ImportSettings />)
    fireEvent.click(screen.getByTestId('import-source-bear'))
    expect(screen.getByTestId('import-dialog')).toHaveTextContent('Bear')
  })
})
