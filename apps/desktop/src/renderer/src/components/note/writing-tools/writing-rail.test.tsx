import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WritingRail } from './writing-rail'
import { WritingToolsSession } from './writing-tools-session'

describe('WritingRail', () => {
  it('closes the rail from its close button', async () => {
    const session = new WritingToolsSession(vi.fn(), () => '', true)
    session.setMode('overflow')
    render(
      <WritingRail mode="overflow" session={session} snapshot={session.getSnapshot()} aiEnabled />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Close writing tools' }))
    expect(session.getSnapshot().mode).toBeNull()
  })
})
