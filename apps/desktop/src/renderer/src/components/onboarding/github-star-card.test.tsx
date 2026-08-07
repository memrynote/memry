import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GithubStarCard } from './github-star-card'
import { STAR_PROMPT_EVENT, STAR_PROMPT_KEY } from './star-prompt'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/lib/icons', () => ({
  Star: () => <svg data-testid="icon-star" />,
  X: () => <svg data-testid="icon-close" />
}))

/** Mirrors what the tour does when it ends: write the flag, then announce it. */
const armPrompt = (): void => {
  localStorage.setItem(STAR_PROMPT_KEY, 'pending')
  act(() => {
    window.dispatchEvent(new Event(STAR_PROMPT_EVENT))
  })
}

describe('GithubStarCard', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stays hidden while the prompt has never been armed', () => {
    render(<GithubStarCard />)
    expect(screen.queryByText('title')).not.toBeInTheDocument()
  })

  it('shows when mounted with a pending prompt', () => {
    localStorage.setItem(STAR_PROMPT_KEY, 'pending')
    render(<GithubStarCard />)
    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  it('shows when the tour arms the prompt while already mounted', () => {
    render(<GithubStarCard />)
    expect(screen.queryByText('title')).not.toBeInTheDocument()

    armPrompt()
    expect(screen.getByText('title')).toBeInTheDocument()
  })

  it('links to the repository in a new tab, without opener access', () => {
    localStorage.setItem(STAR_PROMPT_KEY, 'pending')
    render(<GithubStarCard />)

    const link = screen.getByRole('link', { name: /action/ })
    expect(link).toHaveAttribute('href', 'https://github.com/memrynote/memry')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('settles the prompt when the user goes to star', () => {
    localStorage.setItem(STAR_PROMPT_KEY, 'pending')
    render(<GithubStarCard />)

    fireEvent.click(screen.getByRole('link', { name: /action/ }))

    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe('done')
    expect(screen.queryByText('title')).not.toBeInTheDocument()
  })

  it('settles the prompt when the user dismisses it', () => {
    localStorage.setItem(STAR_PROMPT_KEY, 'pending')
    render(<GithubStarCard />)

    fireEvent.click(screen.getByRole('button', { name: 'close' }))

    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe('done')
    expect(screen.queryByText('title')).not.toBeInTheDocument()
  })

  it('never comes back once answered — not on mount, not on a stray event', () => {
    localStorage.setItem(STAR_PROMPT_KEY, 'done')
    render(<GithubStarCard />)
    expect(screen.queryByText('title')).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event(STAR_PROMPT_EVENT))
    })
    expect(screen.queryByText('title')).not.toBeInTheDocument()
  })
})
