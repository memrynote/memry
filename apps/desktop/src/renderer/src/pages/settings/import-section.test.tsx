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
  importer('roam', 'Roam', ['json'])
]

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.count !== undefined ? `${key}:${vars.count}` : key
  })
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
