import { describe, it, expect, vi } from 'vitest'
import { quietDefuddleUrlNoise } from './quiet-url-noise.ts'

describe('quietDefuddleUrlNoise', () => {
  it('swallows defuddle "Failed to parse URL" noise but passes other logs through', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await quietDefuddleUrlNoise(async () => {
      // What defuddle emits per relative link (caught internally, just noisy):
      console.error('Failed to parse URL: /yatirim-fonu--104761', new TypeError('Invalid URL'))
      console.warn('Failed to parse URL:', new TypeError('Invalid URL'))
      // A genuinely useful log must still get through:
      console.error('something genuinely important')
    })

    const errMsgs = errSpy.mock.calls.map((c) => String(c[0]))
    expect(errMsgs).toContain('something genuinely important')
    expect(errMsgs.some((m) => m.includes('Failed to parse URL'))).toBe(false)
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('Failed to parse URL'))).toBe(false)

    errSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('restores console after running, even when the body throws', async () => {
    const before = console.error
    await expect(
      quietDefuddleUrlNoise(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(console.error).toBe(before)
  })
})
