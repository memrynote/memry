import { afterEach, describe, expect, it } from 'vitest'
import {
  captureVaultSidebarSnapshot,
  clearVaultSidebarSnapshot,
  getVaultSidebarSnapshot,
  resetVaultSidebarSnapshots,
  serializeSidebarSnapshot
} from './vault-sidebar-snapshot'

function page(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('vault sidebar snapshots', () => {
  afterEach(() => {
    resetVaultSidebarSnapshots()
    localStorage.clear()
  })

  it('keeps the markup but drops anything live or duplicated', () => {
    const html = serializeSidebarSnapshot(
      page(
        '<button id="new" data-tour="new-note" tabindex="0" onclick="alert(1)">New</button>' +
          '<script>alert(1)</script>' +
          '<a href="javascript:alert(1)">x</a>' +
          '<div data-snapshot-exclude="">cover</div>' +
          '<span class="text-sm">Inbox</span>'
      )
    )

    expect(html).toContain('New')
    expect(html).toContain('<span class="text-sm">Inbox</span>')
    expect(html).not.toMatch(/id=|data-tour|tabindex|onclick|<script|javascript:|cover/)
  })

  it('survives a reload through storage, and is forgotten with the vault', () => {
    captureVaultSidebarSnapshot('/vaults/work', page('<span>Q3 planning</span>'))
    resetVaultSidebarSnapshots()

    expect(getVaultSidebarSnapshot('/vaults/work')).toBe('<span>Q3 planning</span>')

    clearVaultSidebarSnapshot('/vaults/work')
    expect(getVaultSidebarSnapshot('/vaults/work')).toBeNull()
  })

  it('keeps an oversized page in memory only', () => {
    captureVaultSidebarSnapshot('/vaults/big', page(`<span>${'x'.repeat(300 * 1024)}</span>`))

    expect(getVaultSidebarSnapshot('/vaults/big')).not.toBeNull()
    resetVaultSidebarSnapshots()
    expect(getVaultSidebarSnapshot('/vaults/big')).toBeNull()
  })
})
