import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getSetting: vi.fn()
}))

vi.mock('../database', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('../database/queries/settings', () => ({ getSetting: mocks.getSetting }))

import { getEditorSettings } from './editor-settings'

describe('getEditorSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDatabase.mockReturnValue({})
  })

  it('reads agent checklist conversion as off when no vault is open', () => {
    mocks.getDatabase.mockImplementation(() => {
      throw new Error('No vault is open')
    })

    expect(getEditorSettings().convertAgentChecklistsToTasks).toBe(false)
  })

  it('reads it as off from an editor group written before the key existed', () => {
    mocks.getSetting.mockReturnValue(JSON.stringify({ width: 'full' }))

    expect(getEditorSettings()).toMatchObject({
      width: 'full',
      convertChecklistsToTasks: true,
      convertAgentChecklistsToTasks: false
    })
  })

  it('keeps the owner turning it on', () => {
    mocks.getSetting.mockReturnValue(JSON.stringify({ convertAgentChecklistsToTasks: true }))

    expect(getEditorSettings().convertAgentChecklistsToTasks).toBe(true)
  })

  it('reads it as off when nothing is stored or the blob is corrupt', () => {
    mocks.getSetting.mockReturnValueOnce(undefined).mockReturnValueOnce('{not json')

    expect(getEditorSettings().convertAgentChecklistsToTasks).toBe(false)
    expect(getEditorSettings().convertAgentChecklistsToTasks).toBe(false)
  })
})
