import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentMcpSection } from './agent-mcp-section'

const writeTextMock = vi.fn()

describe('AgentMcpSection', () => {
  beforeEach(() => {
    writeTextMock.mockReset()
    window.api.agentMcp = {
      getStatus: vi.fn().mockResolvedValue({
        url: 'http://127.0.0.1:1234',
        ['token']: 'local-token-placeholder',
        toolCount: 19
      }),
      ['rotateToken']: vi.fn().mockResolvedValue({
        url: 'http://127.0.0.1:1234',
        ['token']: 'rotated-local-token-placeholder',
        toolCount: 19
      })
    }
  })

  it('loads status, copies values, and rotates the token', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock }
    })
    render(<AgentMcpSection />)

    expect(await screen.findByText('http://127.0.0.1:1234')).toBeInTheDocument()
    expect(screen.getByText('local-token-placeholder')).toBeInTheDocument()
    expect(screen.getByText('19 tools')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Copy URL' }))
    expect(writeTextMock).toHaveBeenCalledWith('http://127.0.0.1:1234')

    await user.click(screen.getByRole('button', { name: 'Copy bearer token' }))
    expect(writeTextMock).toHaveBeenCalledWith('local-token-placeholder')

    await user.click(screen.getByRole('button', { name: 'Rotate token' }))

    await waitFor(() => {
      expect(window.api.agentMcp.rotateToken).toHaveBeenCalled()
    })
    expect(await screen.findByText('rotated-local-token-placeholder')).toBeInTheDocument()
  })
})
