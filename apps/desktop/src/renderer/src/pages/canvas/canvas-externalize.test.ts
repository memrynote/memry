import { describe, it, expect, vi } from 'vitest'
import { externalizeSceneAssets, type AssetUploader } from './canvas-externalize'

const CANVAS_ID = 'canvas-1'

function scene(files: Record<string, unknown>): string {
  return JSON.stringify({ elements: [], appState: {}, files })
}

describe('externalizeSceneAssets', () => {
  it('uploads a data: URI file and rewrites its dataURL to the returned ref', async () => {
    const upload = vi.fn<AssetUploader>().mockResolvedValue({ ref: 'memry-file://canvas-1/file-1' })
    const sceneJson = scene({
      'file-1': { mimeType: 'image/png', dataURL: 'data:image/png;base64,aGVsbG8=' }
    })

    const result = await externalizeSceneAssets(sceneJson, CANVAS_ID, upload)

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith({
      canvasId: CANVAS_ID,
      fileId: 'file-1',
      mimeType: 'image/png',
      data: expect.any(ArrayBuffer)
    })
    const [[{ data }]] = upload.mock.calls
    expect(new TextDecoder().decode(data as ArrayBuffer)).toBe('hello')

    const parsed = JSON.parse(result)
    expect(parsed.files['file-1'].dataURL).toBe('memry-file://canvas-1/file-1')
  })

  it('leaves an already-externalized file untouched and does not upload', async () => {
    const upload = vi.fn<AssetUploader>()
    const sceneJson = scene({
      'file-1': { mimeType: 'image/png', dataURL: 'memry-file://canvas-1/file-1' }
    })

    const result = await externalizeSceneAssets(sceneJson, CANVAS_ID, upload)

    expect(upload).not.toHaveBeenCalled()
    expect(result).toBe(sceneJson)
  })

  it('externalizes only the data: file in a mixed scene', async () => {
    const upload = vi.fn<AssetUploader>().mockResolvedValue({ ref: 'memry-file://canvas-1/file-1' })
    const sceneJson = scene({
      'file-1': { mimeType: 'image/png', dataURL: 'data:image/png;base64,aGVsbG8=' },
      'file-2': { mimeType: 'image/jpeg', dataURL: 'memry-file://canvas-1/file-2' }
    })

    const result = await externalizeSceneAssets(sceneJson, CANVAS_ID, upload)

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file-1', mimeType: 'image/png' })
    )
    const parsed = JSON.parse(result)
    expect(parsed.files['file-1'].dataURL).toBe('memry-file://canvas-1/file-1')
    expect(parsed.files['file-2'].dataURL).toBe('memry-file://canvas-1/file-2')
  })

  it('returns the input unchanged when there are no files', async () => {
    const upload = vi.fn<AssetUploader>()
    const sceneJson = scene({})

    const result = await externalizeSceneAssets(sceneJson, CANVAS_ID, upload)

    expect(upload).not.toHaveBeenCalled()
    expect(result).toBe(sceneJson)

    const noFilesJson = JSON.stringify({ elements: [], appState: {} })
    const noFilesResult = await externalizeSceneAssets(noFilesJson, CANVAS_ID, upload)
    expect(upload).not.toHaveBeenCalled()
    expect(noFilesResult).toBe(noFilesJson)
  })

  it('keeps the failed file as data: URI but still externalizes the others', async () => {
    const upload = vi
      .fn<AssetUploader>()
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValueOnce({ ref: 'memry-file://canvas-1/file-2' })
    const sceneJson = scene({
      'file-1': { mimeType: 'image/png', dataURL: 'data:image/png;base64,aGVsbG8=' },
      'file-2': { mimeType: 'image/png', dataURL: 'data:image/png;base64,d29ybGQ=' }
    })

    const resolved = await externalizeSceneAssets(sceneJson, CANVAS_ID, upload)

    expect(upload).toHaveBeenCalledTimes(2)
    const parsed = JSON.parse(resolved)
    expect(parsed.files['file-1'].dataURL).toBe('data:image/png;base64,aGVsbG8=')
    expect(parsed.files['file-2'].dataURL).toBe('memry-file://canvas-1/file-2')
  })

  it('falls back to parsing the mime type from the dataURL when mimeType is missing', async () => {
    const upload = vi.fn<AssetUploader>().mockResolvedValue({ ref: 'memry-file://canvas-1/file-1' })
    const sceneJson = scene({
      'file-1': { dataURL: 'data:image/webp;base64,aGVsbG8=' }
    })

    await externalizeSceneAssets(sceneJson, CANVAS_ID, upload)

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/webp' }))
  })
})
