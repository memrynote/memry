import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { SidebarFeedbackButton } from './sidebar-feedback-button'

const mocks = vi.hoisted(() => ({
  email: null as string | null,
  submit: vi.fn().mockResolvedValue({ success: true }),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { status: 'authenticated', email: mocks.email } })
}))

vi.mock('@/hooks/use-app-updater', () => ({
  useAppUpdaterSelector: (selector: (state: { currentVersion: string }) => unknown) =>
    selector({ currentVersion: '1.2.3' })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => mocks.toastSuccess(...a),
    error: (...a: unknown[]) => mocks.toastError(...a)
  }
}))

vi.mock('@/lib/icons', () => ({ MessageCircle: () => <svg data-testid="icon-feedback" /> }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

// Render dialog children inline so the form is always testable.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.email = null
  mocks.submit.mockResolvedValue({ success: true })
  ;(window as unknown as { api: unknown }).api = { feedback: { submit: mocks.submit } }
})

describe('SidebarFeedbackButton', () => {
  it('disables Send until a message is entered', () => {
    render(<SidebarFeedbackButton />)
    expect(screen.getByRole('button', { name: 'feedbackSend' })).toBeDisabled()
  })

  it('submits the message and the typed email when signed out', async () => {
    render(<SidebarFeedbackButton />)

    fireEvent.change(screen.getByPlaceholderText('feedbackPlaceholder'), {
      target: { value: '  great app  ' }
    })
    fireEvent.change(screen.getByPlaceholderText('feedbackEmailHint'), {
      target: { value: 'me@example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'feedbackSend' }))

    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'great app',
        email: 'me@example.com',
        appVersion: '1.2.3'
      })
    )
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })

  it('uses the signed-in email and hides the email field', async () => {
    mocks.email = 'signed-in@example.com'
    render(<SidebarFeedbackButton />)

    expect(screen.queryByPlaceholderText('feedbackEmailHint')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('feedbackPlaceholder'), {
      target: { value: 'hello' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'feedbackSend' }))

    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'hello', email: 'signed-in@example.com' })
    )
  })

  it('shows an error toast when submission fails', async () => {
    mocks.submit.mockResolvedValue({ success: false, error: 'boom' })
    render(<SidebarFeedbackButton />)

    fireEvent.change(screen.getByPlaceholderText('feedbackPlaceholder'), {
      target: { value: 'hi' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'feedbackSend' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
  })
})
