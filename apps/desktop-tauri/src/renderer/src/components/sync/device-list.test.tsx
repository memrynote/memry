import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DeviceList } from './device-list'
import { Smartphone, Tablet } from '@/lib/icons'

const getDevices = vi.hoisted(() => vi.fn())

vi.mock('@/services/device-service', () => ({ deviceService: { getDevices } }))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))

function glyph(Icon: typeof Tablet): string {
  const { container, unmount } = render(<Icon className="w-4 h-4 text-muted-foreground shrink-0" />)
  const html = container.innerHTML
  unmount()
  return html
}

function rowGlyph(name: string): string {
  const row = screen.getByText(name).closest('.group')
  return row?.querySelector('svg')?.outerHTML ?? ''
}

describe('DeviceList device symbol', () => {
  it('draws an iPad from the form factor and falls back to the platform when it is absent', async () => {
    const linkedAt = Date.now()
    getDevices.mockResolvedValue({
      devices: [
        {
          id: 'a',
          name: 'iPad',
          platform: 'ios',
          formFactor: 'tablet',
          isCurrentDevice: false,
          linkedAt
        },
        {
          id: 'b',
          name: 'iPhone',
          platform: 'ios',
          formFactor: 'phone',
          isCurrentDevice: false,
          linkedAt
        },
        { id: 'c', name: 'Old iOS', platform: 'ios', isCurrentDevice: false, linkedAt }
      ]
    })
    const tablet = glyph(Tablet)
    const phone = glyph(Smartphone)
    expect(tablet).not.toBe(phone)

    render(<DeviceList />)
    await screen.findByText('iPad')

    expect(rowGlyph('iPad')).toBe(tablet)
    expect(rowGlyph('iPhone')).toBe(phone)
    expect(rowGlyph('Old iOS')).toBe(phone)
  })
})
