import { beforeEach, describe, expect, it, vi } from 'vitest'

const { begin, finish, release, invokeBinary } = vi.hoisted(() => ({
  begin: vi.fn(),
  finish: vi.fn(),
  release: vi.fn(),
  invokeBinary: vi.fn()
}))
vi.mock('../../../generated/bindings', () => ({
  commands: { dropStageBegin: begin, dropStageFinish: finish, dropStageRelease: release }
}))
vi.mock('./ipc-binary', () => ({ invokeBinary }))
vi.mock('./logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { CHUNK_BYTES, withStagedFiles } from './drop-stage'

// jsdom's Blob has no `arrayBuffer`; every engine the app runs on does.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer))
      reader.addEventListener('error', () => reject(new Error('could not read the blob')))
      reader.readAsArrayBuffer(this)
    })
  }
}

function fileOf(name: string, size: number): File {
  return new File([new Uint8Array(size).fill(7)], name)
}

beforeEach(() => {
  vi.clearAllMocks()
  let next = 0
  begin.mockImplementation(() => Promise.resolve(`id${next++}`))
  finish.mockImplementation((id: string) => Promise.resolve(`/staging/${id}/file`))
  release.mockResolvedValue(undefined)
  invokeBinary.mockResolvedValue(undefined)
})

describe('withStagedFiles', () => {
  it('streams each file in order, in chunks, hands the import the staged paths, then releases them', async () => {
    const big = fileOf('big.pdf', CHUNK_BYTES * 2 + 5)
    const small = fileOf('small.md', 3)
    const used = vi.fn(() => Promise.resolve('imported'))

    await expect(withStagedFiles([big, small], used)).resolves.toBe('imported')

    expect(begin.mock.calls).toEqual([
      ['big.pdf', big.size],
      ['small.md', 3]
    ])
    const sent = invokeBinary.mock.calls.map(([command, bytes, meta]) => [
      command,
      (bytes as Uint8Array).length,
      meta
    ])
    expect(sent).toEqual([
      ['drop_stage_chunk', CHUNK_BYTES, { id: 'id0', offset: 0 }],
      ['drop_stage_chunk', CHUNK_BYTES, { id: 'id0', offset: CHUNK_BYTES }],
      ['drop_stage_chunk', 5, { id: 'id0', offset: CHUNK_BYTES * 2 }],
      ['drop_stage_chunk', 3, { id: 'id1', offset: 0 }]
    ])
    expect(used).toHaveBeenCalledWith(['/staging/id0/file', '/staging/id1/file'])
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith(['id0', 'id1'])
  })

  it('stages an empty file with no chunk', async () => {
    await withStagedFiles([fileOf('empty.md', 0)], () => Promise.resolve())
    expect(invokeBinary).not.toHaveBeenCalled()
    expect(finish).toHaveBeenCalledWith('id0')
  })

  it('releases the copies when the import fails, and passes the failure on', async () => {
    await expect(
      withStagedFiles([fileOf('a.md', 1)], () => Promise.reject(new Error('vault is read-only')))
    ).rejects.toThrow('vault is read-only')
    expect(release).toHaveBeenCalledWith(['id0'])
  })

  it('stops at a file that cannot be staged and releases it with the ones before it', async () => {
    invokeBinary.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'))
    const use = vi.fn()

    await expect(
      withStagedFiles([fileOf('a.md', 1), fileOf('b.pdf', 1), fileOf('c.md', 1)], use)
    ).rejects.toThrow('disk full')

    expect(use).not.toHaveBeenCalled()
    expect(begin).toHaveBeenCalledTimes(2)
    expect(release.mock.calls).toEqual([[['id1']], [['id0']]])
  })

  it('does not hide an import result behind a release that fails', async () => {
    release.mockRejectedValue(new Error('locked'))
    await expect(withStagedFiles([fileOf('a.md', 1)], () => Promise.resolve(42))).resolves.toBe(42)
  })
})
