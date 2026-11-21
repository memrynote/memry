import { describe, it, expect, beforeEach, vi } from 'vitest'
import { homePagesService } from './home-pages-service'

const commands = vi.hoisted(() => ({
  homePagesUpdate: vi.fn(),
  homePagesDelete: vi.fn(),
  homePagesSetCover: vi.fn(),
  homePagesSetCoverFraming: vi.fn()
}))
const invokeBinary = vi.hoisted(() => vi.fn())

vi.mock('../../../generated/bindings', () => ({ commands, events: {} }))
vi.mock('../lib/ipc-binary', () => ({ invokeBinary }))

const page = { id: 'b1', name: 'Work', position: 0, widgets: [] }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('homePagesService', () => {
  it('answers a saved cover as Electron did', async () => {
    commands.homePagesSetCover.mockResolvedValue({ status: 'saved', page })

    const result = await homePagesService.setCover('b1', { kind: 'wash', id: 'sky' })

    expect(commands.homePagesSetCover).toHaveBeenCalledWith('b1', { kind: 'wash', id: 'sky' })
    expect(result).toEqual({ ok: true, page })
  })

  it('answers a refused cover with its reason', async () => {
    commands.homePagesSetCover.mockResolvedValue({ status: 'failed', reason: 'not-an-image' })

    const result = await homePagesService.setCover('b1', {
      kind: 'url',
      url: 'https://example.com/a.txt'
    })

    expect(result).toEqual({ ok: false, reason: 'not-an-image' })
  })

  it('sends an upload as raw bytes with the board id and file name', async () => {
    invokeBinary.mockResolvedValue({ status: 'saved', page })
    const data = new Uint8Array([1, 2, 3]).buffer

    const result = await homePagesService.setCover('b1', {
      kind: 'upload',
      filename: 'cover.png',
      data
    })

    expect(invokeBinary).toHaveBeenCalledWith(
      'home_pages_set_cover_upload',
      new Uint8Array([1, 2, 3]),
      { id: 'b1', filename: 'cover.png' }
    )
    expect(commands.homePagesSetCover).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, page })
  })

  it('reports whether a delete found the board', async () => {
    commands.homePagesDelete.mockResolvedValue(false)

    await expect(homePagesService.delete('gone')).resolves.toEqual({ success: false })
  })
})
