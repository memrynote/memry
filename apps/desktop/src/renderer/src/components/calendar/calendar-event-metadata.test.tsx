import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CalendarEventMetadata } from './calendar-event-metadata'
import type { CalendarEventMetadataProps } from './calendar-event-metadata'

const FULL: CalendarEventMetadataProps = {
  attendees: [
    { email: 'alice@example.com', displayName: 'Alice', responseStatus: 'accepted' },
    { email: 'bob@example.com', responseStatus: 'declined' },
    { email: 'carol@example.com', responseStatus: 'needsAction', optional: true }
  ],
  reminders: {
    useDefault: false,
    overrides: [
      { method: 'popup', minutes: 10 },
      { method: 'email', minutes: 60 }
    ]
  },
  visibility: 'private',
  conferenceData: {
    entryPoints: [
      { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }
    ]
  }
}

describe('CalendarEventMetadata (M5)', () => {
  it('renders each attendee with email + response status badge', () => {
    render(<CalendarEventMetadata {...FULL} />)

    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
    expect(screen.getByText('bob@example.com')).toBeInTheDocument()
    expect(screen.getByText('carol@example.com')).toBeInTheDocument()

    // response status surfaces as readable badges
    expect(screen.getByText(/accepted/i)).toBeInTheDocument()
    expect(screen.getByText(/declined/i)).toBeInTheDocument()
    expect(screen.getByText(/pending|needs/i)).toBeInTheDocument()
  })

  it('marks optional attendees', () => {
    render(<CalendarEventMetadata {...FULL} />)
    expect(screen.getByText(/optional/i)).toBeInTheDocument()
  })

  it('renders a compact reminders summary', () => {
    render(<CalendarEventMetadata {...FULL} />)
    expect(screen.getByText(/10 min/i)).toBeInTheDocument()
    expect(screen.getByText(/60 min|1 hr|1 hour/i)).toBeInTheDocument()
    expect(screen.getByText(/popup/i)).toBeInTheDocument()
    expect(screen.getByText(/email/i)).toBeInTheDocument()
  })

  it('renders "Default reminders" when useDefault + no overrides', () => {
    render(<CalendarEventMetadata {...FULL} reminders={{ useDefault: true, overrides: [] }} />)
    expect(screen.getByText(/default reminders/i)).toBeInTheDocument()
  })

  it('renders a visibility tag for non-default visibility', () => {
    render(<CalendarEventMetadata {...FULL} />)
    expect(screen.getByText(/private/i)).toBeInTheDocument()
  })

  it('omits the visibility tag when visibility is default or null', () => {
    render(<CalendarEventMetadata {...FULL} visibility={null} />)
    expect(screen.queryByText(/^visibility/i)).not.toBeInTheDocument()
  })

  it('renders a "Join meeting" link when conferenceData has a video entry point', () => {
    render(<CalendarEventMetadata {...FULL} />)
    const link = screen.getByRole('link', { name: /join meeting/i })
    expect(link).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij')
  })

  it('renders nothing when no metadata is present', () => {
    const { container } = render(
      <CalendarEventMetadata
        attendees={null}
        reminders={null}
        visibility={null}
        conferenceData={null}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
