import { beforeEach, describe, expect, it } from 'vitest'
import { COMMAND_RECENTS_KEY, readCommandRecents, recordCommandRecent } from './command-recents'

beforeEach(() => {
  localStorage.clear()
})

describe('command recents', () => {
  it('lists the latest first, once each', () => {
    recordCommandRecent('go.inbox')
    recordCommandRecent('go.tasks')
    recordCommandRecent('go.inbox')
    expect(readCommandRecents()).toEqual(['go.inbox', 'go.tasks'])
  })

  it('keeps the five latest', () => {
    const ids = [
      'go.home',
      'go.inbox',
      'go.journal',
      'go.calendar',
      'go.tasks',
      'go.graph'
    ] as const
    for (const id of ids) recordCommandRecent(id)
    expect(readCommandRecents()).toEqual([
      'go.graph',
      'go.tasks',
      'go.calendar',
      'go.journal',
      'go.inbox'
    ])
  })

  it('drops ids this build no longer has, and survives bad storage', () => {
    localStorage.setItem(COMMAND_RECENTS_KEY, JSON.stringify(['go.tasks', 'gone.command', 7]))
    expect(readCommandRecents()).toEqual(['go.tasks'])

    localStorage.setItem(COMMAND_RECENTS_KEY, '{not json')
    expect(readCommandRecents()).toEqual([])

    localStorage.setItem(COMMAND_RECENTS_KEY, '{"a":1}')
    expect(readCommandRecents()).toEqual([])
  })
})
