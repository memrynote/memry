import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SidebarSection } from './sidebar-section'
import { SidebarProvider } from '@/components/ui/sidebar'
import { isRevealed } from '@tests/utils/reveal'

// Every section header action — "New canvas", "New note", "New folder", the
// tags actions — sits in the tab order at `opacity-0`. Hover was the only thing
// that brought it back, so a keyboard user landed on a control with nothing on
// screen: WCAG 2.4.7. These tests drive Tab, never a pointer.

function renderSection() {
  return render(
    <SidebarProvider>
      <SidebarSection
        id="focus-reveal"
        label="Canvas"
        actions={
          <>
            <button type="button">New canvas</button>
            <button type="button">New canvas folder</button>
          </>
        }
      >
        <div>child</div>
      </SidebarSection>
    </SidebarProvider>
  )
}

// `SidebarSection` seeds its expanded state from localStorage and jsdom keeps
// it for the whole file, so clear it rather than let test order decide.
beforeEach(() => {
  localStorage.clear()
})

describe('sidebar section pinned actions', () => {
  // An empty section has nothing in its body to click, and every section starts
  // collapsed, so hover-only actions leave a section with no entry point at all.
  it('keeps the actions on screen without hover or focus when pinned', () => {
    render(
      <SidebarProvider>
        <SidebarSection
          id="pinned"
          label="Projects"
          actionsAlwaysVisible
          actions={<button type="button">New project</button>}
        >
          <div>child</div>
        </SidebarSection>
      </SidebarProvider>
    )

    const actions = screen.getByRole('button', { name: 'New project' }).parentElement
    expect(actions).not.toBeNull()
    expect(isRevealed(actions!)).toBe(true)
  })

  it('falls back to the hover reveal when not pinned', () => {
    renderSection()

    const actions = screen.getByRole('button', { name: 'New canvas' }).parentElement
    expect(isRevealed(actions!)).toBe(false)
  })
})

describe('sidebar section focus reveal', () => {
  it('keeps the actions hidden while nothing in the section has focus', () => {
    renderSection()

    const actions = screen.getByRole('button', { name: 'New canvas' }).parentElement
    expect(actions).not.toBeNull()
    expect(isRevealed(actions!)).toBe(false)
  })

  it('reveals the actions when the first one is tabbed to', async () => {
    const user = userEvent.setup()
    renderSection()

    const newCanvas = screen.getByRole('button', { name: 'New canvas' })

    await user.tab() // section header
    await user.tab() // first action

    expect(newCanvas).toHaveFocus()
    expect(isRevealed(newCanvas.parentElement!)).toBe(true)
  })

  it('keeps the actions revealed while focus moves between them', async () => {
    const user = userEvent.setup()
    renderSection()

    const newFolder = screen.getByRole('button', { name: 'New canvas folder' })

    await user.tab()
    await user.tab()
    await user.tab()

    expect(newFolder).toHaveFocus()
    expect(isRevealed(newFolder.parentElement!)).toBe(true)
  })

  it('reveals the chevron when the header itself is focused', async () => {
    // The header sets `focus-visible:outline-none` and the app defines no
    // global focus ring, so the chevron fading in is the header's ONLY visible
    // focus state. At `opacity-0` a keyboard user gets nothing at all.
    const user = userEvent.setup()
    renderSection()

    const header = screen.getByRole('button', { name: /^Canvas section/ })
    const chevron = header.querySelector('svg')
    expect(chevron).not.toBeNull()
    expect(isRevealed(chevron!)).toBe(false)

    await user.tab()

    expect(header).toHaveFocus()
    expect(isRevealed(chevron!)).toBe(true)
  })
})
