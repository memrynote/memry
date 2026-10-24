import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FeaturesSection } from './features-section'

const setFeaturesSettings = vi.fn().mockResolvedValue({ success: true })

beforeEach(() => {
  const settingsMock = window.api.settings as Record<string, unknown>
  settingsMock.getFeaturesSettings = vi.fn().mockResolvedValue({
    home: true,
    inbox: true,
    journal: true,
    tasks: true,
    calendar: true,
    graph: true
  })
  settingsMock.setFeaturesSettings = setFeaturesSettings
})

describe('FeaturesSection', () => {
  it('persists a toggle to setFeaturesSettings', async () => {
    render(<FeaturesSection />)
    const tasksSwitch = await screen.findByRole('switch', { name: /tasks/i })
    fireEvent.click(tasksSwitch)
    await waitFor(() => expect(setFeaturesSettings).toHaveBeenCalledWith({ tasks: false }))
  })
})
