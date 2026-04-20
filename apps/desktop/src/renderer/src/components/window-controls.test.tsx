import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WindowControls } from './window-controls'
import { SidebarProvider } from '@/components/ui/sidebar'

// Mock the electron preload bridge — TrafficLights calls window.api.*
const windowApiMock = {
  windowClose: vi.fn(),
  windowMinimize: vi.fn(),
  windowMaximize: vi.fn()
}

type WindowWithApi = Window & { api?: unknown }
let originalApi: unknown

beforeEach(() => {
  vi.clearAllMocks()
  const w = window as WindowWithApi
  originalApi = w.api
  w.api = windowApiMock
})

afterEach(() => {
  const w = window as WindowWithApi
  if (originalApi === undefined) {
    delete w.api
  } else {
    w.api = originalApi
  }
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

  it('calls windowClose when the close button is clicked', async () => {
    const user = userEvent.setup()
    renderWithSidebar(<WindowControls />)
    await user.click(screen.getByLabelText('Close window'))
    expect(windowApiMock.windowClose).toHaveBeenCalledTimes(1)
  })

  it('does nothing when a disabled history arrow is clicked', async () => {
    const user = userEvent.setup()
    renderWithSidebar(<WindowControls />)
    // userEvent respects `disabled`; click is a no-op. Assert no explosion + no side effects.
    await user.click(screen.getByLabelText('Browser back'))
    await user.click(screen.getByLabelText('Browser forward'))
    expect(windowApiMock.windowClose).not.toHaveBeenCalled()
    expect(windowApiMock.windowMinimize).not.toHaveBeenCalled()
  })
})
