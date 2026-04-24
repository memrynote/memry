import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WindowControls } from './window-controls'
import { SidebarProvider } from '@/components/ui/sidebar'

// TrafficLights drives the window via Tauri's window API directly (not IPC).
// Mock the module so the close/minimize/maximize calls are observable.
const tauriWindowMock = {
  close: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn()
}

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => tauriWindowMock
}))

beforeEach(() => {
  vi.clearAllMocks()
})

function renderWithSidebar(ui: React.ReactElement) {
  return render(<SidebarProvider>{ui}</SidebarProvider>)
}

describe('WindowControls', () => {
  it('renders three traffic-light buttons (close, minimize, maximize)', () => {
    renderWithSidebar(<WindowControls />)
    expect(screen.getByLabelText('Close window')).toBeInTheDocument()
    expect(screen.getByLabelText('Minimize window')).toBeInTheDocument()
    expect(screen.getByLabelText('Maximize window')).toBeInTheDocument()
  })

  it('renders the sidebar toggle', () => {
    renderWithSidebar(<WindowControls />)
    expect(screen.getByRole('button', { name: /toggle sidebar/i })).toBeInTheDocument()
  })

  it('renders both history arrows as disabled', () => {
    renderWithSidebar(<WindowControls />)
    const back = screen.getByLabelText('Browser back')
    const forward = screen.getByLabelText('Browser forward')
    expect(back).toBeDisabled()
    expect(forward).toBeDisabled()
    expect(back).toHaveAttribute('aria-disabled', 'true')
    expect(forward).toHaveAttribute('aria-disabled', 'true')
  })

  it('calls getCurrentWindow().close() when the close button is clicked', async () => {
    const user = userEvent.setup()
    renderWithSidebar(<WindowControls />)
    await user.click(screen.getByLabelText('Close window'))
    expect(tauriWindowMock.close).toHaveBeenCalledTimes(1)
  })

  it('does nothing when a disabled history arrow is clicked', async () => {
    const user = userEvent.setup()
    renderWithSidebar(<WindowControls />)
    // userEvent respects `disabled`; click is a no-op. Assert no explosion + no side effects.
    await user.click(screen.getByLabelText('Browser back'))
    await user.click(screen.getByLabelText('Browser forward'))
    expect(tauriWindowMock.close).not.toHaveBeenCalled()
    expect(tauriWindowMock.minimize).not.toHaveBeenCalled()
  })
})
