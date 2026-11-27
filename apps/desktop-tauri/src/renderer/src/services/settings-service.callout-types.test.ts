import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  commands: {
    settingsGetGroup: vi.fn(),
    settingsGetPath: vi.fn()
  },
  listeners: new Map<string, (event: { payload: unknown }) => void>()
}))

vi.mock('../../../generated/bindings', () => {
  const event = (name: string) => ({
    listen: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, handler)
      return () => undefined
    })
  })
  return {
    commands: mocks.commands,
    events: {
      settingsChangedEvent: event('changed'),
      settingsOpenSectionEvent: event('open'),
      syncItemSyncedEvent: event('synced')
    }
  }
})

import {
  getCalloutTypes,
  startCalloutTypesSync
} from '../components/note/content-area/callout-types-store'
import { onSettingsChanged, settingsService } from './settings-service'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const peerType = { name: 'peer-note', label: 'Peer note', color: '#336699', icon: 'info' }

describe('callout types on a pulled settings page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The editor group read has no `calloutTypes`: core keeps them out of `get_group`.
    mocks.commands.settingsGetGroup.mockResolvedValue({ spellCheck: false })
  })

  it("reaches the callout-types store with the peer's types", async () => {
    mocks.commands.settingsGetPath.mockResolvedValue(null)
    Object.assign(window, {
      api: { settings: { getCalloutTypes: settingsService.getCalloutTypes }, onSettingsChanged }
    })
    startCalloutTypesSync()
    await flush()
    expect(getCalloutTypes()).toEqual([])

    mocks.commands.settingsGetPath.mockResolvedValue({ [peerType.name]: peerType })
    vi.useFakeTimers()
    try {
      mocks.listeners.get('synced')?.({
        payload: {
          operation: 'pull',
          items: [{ itemId: 'synced_settings', type: 'settings', itemOperation: 'update' }]
        }
      })
      await vi.advanceTimersByTimeAsync(150)
    } finally {
      vi.useRealTimers()
    }
    await flush()

    expect(getCalloutTypes()).toEqual([peerType])
  })
})
