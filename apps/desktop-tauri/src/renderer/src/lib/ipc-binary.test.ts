import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { decodeChunk, invokeBinary, META_HEADER, readBinary, sliceChunks } from './ipc-binary'

beforeEach(() => {
  invoke.mockReset()
})

describe('invokeBinary', () => {
  it('sends the body raw and the metadata in the x-memry-meta header', async () => {
    invoke.mockResolvedValue('done')
    const body = new Uint8Array([1, 2, 3])

    await expect(invokeBinary('drop_stage', body, { name: 'a.txt' })).resolves.toBe('done')

    expect(invoke).toHaveBeenCalledWith('drop_stage', body, {
      headers: { [META_HEADER]: '{"name":"a.txt"}' }
    })
  })

  it('escapes non-ASCII metadata so the header stays ASCII and round-trips', async () => {
    invoke.mockResolvedValue(undefined)

    await invokeBinary('drop_stage', new Uint8Array(), { name: 'caf\u00e9 \u{1F600}.md' })

    const header = invoke.mock.calls[0][2].headers[META_HEADER] as string
    expect(header).toBe('{"name":"caf\\u00e9 \\ud83d\\ude00.md"}')
    expect(header).toMatch(/^[\x20-\x7e]*$/)
    expect(JSON.parse(header)).toEqual({ name: 'caf\u00e9 \u{1F600}.md' })
  })
})

describe('readBinary and decodeChunk', () => {
  it('reads a raw response as bytes', async () => {
    invoke.mockResolvedValue(new Uint8Array([9, 8]).buffer)

    expect([...(await readBinary('file_read', { id: 'x' }))]).toEqual([9, 8])
    expect(invoke).toHaveBeenCalledWith('file_read', { id: 'x' })
  })

  it('decodes an ArrayBuffer chunk and passes bytes through', () => {
    const bytes = new Uint8Array([1, 2])

    expect([...decodeChunk(bytes.buffer)]).toEqual([1, 2])
    expect(decodeChunk(bytes)).toBe(bytes)
  })

  it('refuses anything else', () => {
    expect(() => decodeChunk('text')).toThrow(TypeError)
  })
})

describe('sliceChunks', () => {
  it('yields fixed-size slices with a short tail', () => {
    const slices = [...sliceChunks(new Uint8Array([1, 2, 3, 4, 5]), 2)].map((s) => [...s])

    expect(slices).toEqual([[1, 2], [3, 4], [5]])
  })

  it('yields nothing for empty input and rejects a bad size', () => {
    expect([...sliceChunks(new Uint8Array(), 4)]).toEqual([])
    expect(() => [...sliceChunks(new Uint8Array([1]), 0)]).toThrow(RangeError)
  })
})
