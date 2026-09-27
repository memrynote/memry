import { afterEach, describe, expect, it } from 'vitest'
import { sidebarTreeExpandedKey } from './sidebar-tree-expanded-key'

describe('sidebarTreeExpandedKey', () => {
  afterEach(() => localStorage.clear())

  it('gives each vault its own key', () => {
    expect(sidebarTreeExpandedKey('/vaults/work')).toBe('sidebar-tree-expanded:/vaults/work')
    expect(sidebarTreeExpandedKey('/vaults/home')).toBe('sidebar-tree-expanded:/vaults/home')
  })

  it('uses the legacy key outside a vault workspace', () => {
    expect(sidebarTreeExpandedKey(null)).toBe('sidebar-tree-expanded')
  })

  it('lets the first vault claim the legacy set, once', () => {
    localStorage.setItem('sidebar-tree-expanded', JSON.stringify(['folder-Work']))

    const work = sidebarTreeExpandedKey('/vaults/work')
    expect(localStorage.getItem(work)).toBe(JSON.stringify(['folder-Work']))
    expect(localStorage.getItem('sidebar-tree-expanded')).toBeNull()

    const home = sidebarTreeExpandedKey('/vaults/home')
    expect(localStorage.getItem(home)).toBeNull()
  })

  it('keeps a vault set it already has', () => {
    localStorage.setItem('sidebar-tree-expanded:/vaults/work', JSON.stringify(['folder-Mine']))
    localStorage.setItem('sidebar-tree-expanded', JSON.stringify(['folder-Other']))

    const key = sidebarTreeExpandedKey('/vaults/work')
    expect(localStorage.getItem(key)).toBe(JSON.stringify(['folder-Mine']))
    expect(localStorage.getItem('sidebar-tree-expanded')).toBe(JSON.stringify(['folder-Other']))
  })
})
