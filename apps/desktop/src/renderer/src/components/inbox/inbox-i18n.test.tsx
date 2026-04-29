import { render, screen } from '@testing-library/react'
import { describe, expect, it, beforeAll } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { InboxSegmentControl } from './inbox-segment-control'
import { TriageActionBar } from './triage-action-bar'
import { InboxZeroState } from '@/components/empty-state/inbox-zero-state'

describe('inbox i18n', () => {
  let i18nEn: I18nInstance
  let i18nTr: I18nInstance

  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
    i18nTr = await createRendererI18n({ locale: 'tr' })
  })

  it('renders English inbox namespace labels', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <InboxSegmentControl value="inbox" onChange={() => {}} />
      </I18nextProvider>
    )

    expect(screen.getByText('Inbox')).toBeInTheDocument()
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(screen.getByText('Insights')).toBeInTheDocument()
  })

  it('renders Turkish inbox namespace labels', () => {
    render(
      <I18nextProvider i18n={i18nTr}>
        <InboxSegmentControl value="archived" onChange={() => {}} />
      </I18nextProvider>
    )

    expect(screen.getByText('Gelen kutusu')).toBeInTheDocument()
    expect(screen.getByText('Arşivlendi')).toBeInTheDocument()
  })

  it('renders triage action labels from the inbox namespace', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <TriageActionBar
          itemType="note"
          activePicker={null}
          onPickerChange={() => {}}
          onDiscard={() => {}}
          onConvertToTask={() => {}}
          onExpandToNote={() => {}}
        />
      </I18nextProvider>
    )

    expect(screen.getByText('Discard')).toBeInTheDocument()
    expect(screen.getByText('To Task')).toBeInTheDocument()
    expect(screen.getByText('To Note')).toBeInTheDocument()
    expect(screen.getByText('File')).toBeInTheDocument()
    expect(screen.getByText('Snooze')).toBeInTheDocument()
  })

  it('renders inbox zero copy through i18n', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <InboxZeroState itemsProcessedToday={0} processedThisWeek={3} currentStreak={2} />
      </I18nextProvider>
    )

    expect(screen.getByText('Inbox Zero')).toBeInTheDocument()
    expect(screen.getByText('3 filed this week')).toBeInTheDocument()
    expect(screen.getByText('2 day streak')).toBeInTheDocument()
  })
})
