import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist mutable references so factory functions close over the same instances.
let mockVaultStatus = {
  isIndexing: false,
  indexBuilt: undefined as number | undefined,
  indexTotal: undefined as number | undefined
}

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en', language: 'en', changeLanguage: vi.fn() }
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: vi.fn() })
}))

vi.mock('@/hooks/use-vault', () => ({
  useVault: () => mockVaultStatus
}))

vi.mock('@/services/search-service', () => ({
  searchService: {
    query: vi.fn().mockResolvedValue({ groups: [], totalCount: 0, queryTimeMs: 0 }),
    getReasons: vi.fn().mockResolvedValue([]),
    addReason: vi.fn(),
    clearReasons: vi.fn().mockResolvedValue({ cleared: true })
  }
}))

vi.mock('./search-filters', () => ({
  SearchFilters: () => <div data-testid="search-filters" />
}))

vi.mock('./recent-reasons', () => ({
  RecentReasons: () => <div data-testid="recent-reasons" />
}))

vi.mock('./search-result-group', () => ({
  SearchResultGroup: () => <div data-testid="result-group" />
}))

import { CommandPalette } from './command-palette'

describe('CommandPalette incomplete-index indicator (#1832)', () => {
  beforeEach(() => {
    mockVaultStatus = { isIndexing: false, indexBuilt: undefined, indexTotal: undefined }
  })

  it('shows nothing while the index is current', () => {
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('announces the build with counts while indexing', () => {
    mockVaultStatus = { isIndexing: true, indexBuilt: 120, indexTotal: 400 }
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />)

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('componentsSearchCommandPalette.indexBuilding')
  })

  it('falls back to the countless variant before the first beat arrives', () => {
    mockVaultStatus = { isIndexing: true, indexBuilt: undefined, indexTotal: undefined }
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />)

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('componentsSearchCommandPalette.indexBuildingUnknown')
  })
})
