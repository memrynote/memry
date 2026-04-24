import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { AppPlaceholder } from './app-placeholder'

describe('AppPlaceholder', () => {
  it('renders the M1 skeleton header so the window is not blank', () => {
    render(<AppPlaceholder />)
    expect(screen.getByText(/M1 Tauri skeleton/i)).toBeInTheDocument()
  })

  it('invokes the mock IPC to prove the mock pipeline is reachable', async () => {
    render(<AppPlaceholder />)
    // notes_list returns 12 non-deleted fixtures (see src/lib/ipc/mocks/notes.ts).
    await waitFor(() => {
      expect(screen.getByTestId('mock-notes-count')).toHaveTextContent(/\d+ mock note/)
    })
  })

  it('reports a descriptive error if the mock invoke rejects', async () => {
    render(<AppPlaceholder initialCommand="nonexistent_command" />)
    await waitFor(() => {
      expect(screen.getByTestId('mock-error')).toHaveTextContent(/not implemented/i)
    })
  })
})
