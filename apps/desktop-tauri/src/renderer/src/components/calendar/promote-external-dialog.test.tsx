import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PromoteExternalDialog } from './promote-external-dialog'

describe('PromoteExternalDialog (M2)', () => {
  it('#given open #when rendered #then shows the explanatory copy and primary button', () => {
    render(<PromoteExternalDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    expect(
      screen.getByText(/Editing this event will create a linked copy in memrynote/)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit in memrynote' })).toBeInTheDocument()
  })

  it('#given user clicks confirm without ticking checkbox #when invoked #then onConfirm receives dontAskAgain=false', () => {
    const onConfirm = vi.fn()
    render(<PromoteExternalDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit in memrynote' }))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('#given user ticks "Don\'t ask again" and confirms #when invoked #then onConfirm receives dontAskAgain=true', () => {
    const onConfirm = vi.fn()
    render(<PromoteExternalDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByLabelText("Don't ask again"))
    fireEvent.click(screen.getByRole('button', { name: 'Edit in memrynote' }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('#given user clicks Cancel #when invoked #then onOpenChange(false) is called and onConfirm is not', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(<PromoteExternalDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('#given isWorking #when rendered #then disables both buttons and shows the "Preparing…" label', () => {
    render(<PromoteExternalDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} isWorking />)
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('#given agentAccessOff #when rendered #then warns that the copy becomes agent-readable', () => {
    render(<PromoteExternalDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} agentAccessOff />)
    expect(screen.getByText(/AI agent can read this copy/)).toBeInTheDocument()
  })

  it('#given agent access is already on #when rendered #then omits the warning', () => {
    render(<PromoteExternalDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.queryByText(/AI agent can read this copy/)).not.toBeInTheDocument()
  })

  it('#given errorMessage #when rendered #then surfaces it via role=alert', () => {
    render(
      <PromoteExternalDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        errorMessage="Something went wrong"
      />
    )
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong')
  })
})
