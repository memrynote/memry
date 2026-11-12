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
        toolCount: 20
      }),
      ['rotateToken']: vi.fn().mockResolvedValue({
        url: 'http://127.0.0.1:1234',
        ['token']: 'rotated-local-token-placeholder',
        toolCount: 20
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

    expect(await screen.findByText('http://127.0.0.1:1234/mcp')).toBeInTheDocument()
    expect(screen.queryByText('local-token-placeholder')).not.toBeInTheDocument()
    expect(screen.getByText('loca••••••••lder')).toBeInTheDocument()
    expect(screen.getByText('20 tools')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Copy URL' }))
    expect(writeTextMock).toHaveBeenCalledWith('http://127.0.0.1:1234/mcp')

    await user.click(screen.getByRole('button', { name: 'Copy Bearer token' }))
    expect(writeTextMock).toHaveBeenCalledWith('local-token-placeholder')

    await user.click(screen.getByRole('button', { name: 'Rotate token' }))

    await waitFor(() => {
      expect(window.api.agentMcp.rotateToken).toHaveBeenCalled()
    })
    expect(await screen.findByText('rota••••••••lder')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy Bearer token' }))
    expect(writeTextMock).toHaveBeenLastCalledWith('rotated-local-token-placeholder')
  })

  it('copies client configs with the /mcp endpoint and live token filled in', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock }
    })
    render(<AgentMcpSection />)

    await user.click(await screen.findByRole('button', { name: 'Copy Claude Desktop config' }))
    expect(JSON.parse(writeTextMock.mock.lastCall?.[0] as string)).toEqual({
      mcpServers: {
        memrynote: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote',
            'http://127.0.0.1:1234/mcp',
            '--allow-http',
            '--header',
            'Authorization:${MEMRYNOTE_AUTH}'
          ],
          env: { MEMRYNOTE_AUTH: 'Bearer local-token-placeholder' }
        }
      }
    })

    await user.click(screen.getByRole('button', { name: 'Copy Claude Code config' }))
    expect(writeTextMock).toHaveBeenLastCalledWith(
      'claude mcp add --transport http memrynote http://127.0.0.1:1234/mcp --header "Authorization: Bearer local-token-placeholder"'
    )

    expect(screen.getByText(/PERMISSION_DENIED/)).toBeInTheDocument()
    expect(screen.getByText(/URL and token change when memrynote restarts/)).toBeInTheDocument()
  })
})
