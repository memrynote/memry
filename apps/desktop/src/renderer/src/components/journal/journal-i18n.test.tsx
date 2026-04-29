import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactElement } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'
import { JournalEntryListItem } from './journal-entry-list-item'
import { JournalBreadcrumb } from './journal-breadcrumb'
import { JournalNavigationRow } from './journal-navigation-row'
import { AIConnectionsPanel } from './ai-connections-panel'

type TestLocale = 'en' | 'tr' | 'ar'

async function renderWithI18n(
  ui: ReactElement,
  options: {
    locale?: TestLocale
    journalOverrides?: Record<string, unknown>
  } = {}
): Promise<I18nInstance> {
  const i18n = await createRendererI18n({ locale: options.locale ?? 'en' })

  if (options.journalOverrides) {
    i18n.addResourceBundle('en', 'journal', options.journalOverrides, true, true)
  }

  render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
  return i18n
}

describe('journal i18n', () => {
  it('falls back to English when the active locale journal namespace is empty', async () => {
    await renderWithI18n(
      <JournalEntryListItem
        day={14}
        dayName="Tuesday"
        date="2026-04-14"
        heatmapLevel={0}
        isFuture
        onClick={vi.fn()}
      />,
      { locale: 'tr' }
    )

    expect(screen.getByText('Future')).toBeInTheDocument()
  })

  it('renders journal namespace overrides in list item empty copy', async () => {
    await renderWithI18n(
      <JournalEntryListItem
        day={14}
        dayName="Tuesday"
        date="2026-04-14"
        heatmapLevel={0}
        onClick={vi.fn()}
      />,
      {
        journalOverrides: {
          empty: { noEntry: 'No page today' }
        }
      }
    )

    expect(screen.getByText('No page today')).toBeInTheDocument()
  })

  it('uses journal date labels in breadcrumb month rendering', async () => {
    await renderWithI18n(
      <JournalBreadcrumb
        viewState={{ type: 'day', date: '2026-04-14' }}
        isToday={false}
        onPreviousDay={vi.fn()}
        onNextDay={vi.fn()}
        onMonthClick={vi.fn()}
        onYearClick={vi.fn()}
        onTodayClick={vi.fn()}
      />,
      {
        journalOverrides: {
          date: { month: { april: 'Aprilo' } }
        }
      }
    )

    expect(screen.getByText('Aprilo')).toBeInTheDocument()
  })

  it('uses journal navigation aria labels', async () => {
    await renderWithI18n(
      <JournalNavigationRow
        viewState={{ type: 'day', date: '2026-04-14' }}
        isToday={false}
        isBookmarked={false}
        hasEntry={false}
        journalDate="2026-04-14"
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onToday={vi.fn()}
        onFocusToggle={vi.fn()}
        onBookmarkToggle={vi.fn()}
        onVersionHistory={vi.fn()}
        onExport={vi.fn()}
      />,
      {
        journalOverrides: {
          nav: { previousDay: 'Previous journal day' }
        }
      }
    )

    expect(screen.getByRole('button', { name: 'Previous journal day' })).toBeInTheDocument()
  })

  it('renders journal namespace AI empty state copy', async () => {
    await renderWithI18n(
      <AIConnectionsPanel connections={[]} isNewUser={false} />,
      {
        journalOverrides: {
          ai: {
            empty: {
              noneYet: 'No related journal history',
              keepWriting: 'Keep writing for matches'
            }
          }
        }
      }
    )

    expect(screen.getByText('No related journal history')).toBeInTheDocument()
    expect(screen.getByText('Keep writing for matches')).toBeInTheDocument()
  })
})
