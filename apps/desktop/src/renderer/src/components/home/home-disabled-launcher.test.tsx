import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HomeDisabledLauncher } from './home-disabled-launcher'

describe('HomeDisabledLauncher', () => {
  it('calls onCreateNote when the CTA is clicked', () => {
    const onCreateNote = vi.fn()
    render(<HomeDisabledLauncher onCreateNote={onCreateNote} />)
    fireEvent.click(screen.getByRole('button', { name: /create note/i }))
    expect(onCreateNote).toHaveBeenCalledTimes(1)
  })
})
