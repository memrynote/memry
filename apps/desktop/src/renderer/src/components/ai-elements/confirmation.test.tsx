import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle
} from './confirmation'

describe('Confirmation', () => {
  it('renders confirmation content and actions for approval states', () => {
    const onAccept = vi.fn()

    render(
      <Confirmation
        approval={{ approved: true, id: 'approval-1' }}
        data-testid="confirmation"
        state="approval-requested"
      >
        <ConfirmationTitle>
          <ConfirmationRequest>Approve this tool call?</ConfirmationRequest>
          <ConfirmationAccepted>Accepted</ConfirmationAccepted>
          <ConfirmationRejected>Rejected</ConfirmationRejected>
        </ConfirmationTitle>
        <ConfirmationActions>
          <ConfirmationAction onClick={onAccept}>Accept</ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>
    )

    expect(screen.getByTestId('confirmation')).toHaveAttribute('data-approved', 'true')
    expect(screen.getByText('Approve this tool call?')).toBeInTheDocument()
    expect(screen.getByText('Accepted')).toBeInTheDocument()
    expect(screen.getByText('Rejected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it('does not render for running-only tool states', () => {
    const { container } = render(
      <Confirmation state="input-available">
        <ConfirmationTitle>Hidden</ConfirmationTitle>
      </Confirmation>
    )

    expect(container).toBeEmptyDOMElement()
  })
})
