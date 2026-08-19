import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  externalizeSceneAssets,
  retryCanvasAssetUploads,
  type AssetUploader
} from './canvas-externalize'
import { trackRendererError } from '@/lib/telemetry-diagnostics'

vi.mock('@/lib/telemetry-diagnostics', () => ({ trackRendererError: vi.fn() }))

const CANVAS_ID = 'canvas-1'

function scene(files: Record<string, unknown>): string {
  return JSON.stringify({ elements: [], appState: {}, files })
}

describe('externalizeSceneAssets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The failure cache is module-level, so one test's failure would otherwise
    // gate the next test's upload of the same (canvasId, fileId).
    retryCanvasAssetUploads()
  })

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

  it('uploads nothing and reports nothing when uploads are unavailable (signed out)', async () => {
    const upload = vi.fn<AssetUploader>()
    const canUpload = vi.fn().mockResolvedValue(false)
    const sceneJson = scene({
      'file-1': { mimeType: 'image/png', dataURL: 'data:image/png;base64,aGVsbG8=' },
      'file-2': { mimeType: 'image/png', dataURL: 'data:image/png;base64,d29ybGQ=' }
    })

    const first = await externalizeSceneAssets(sceneJson, 'canvas-signed-out', upload, {
      canUpload
    })
    const second = await externalizeSceneAssets(sceneJson, 'canvas-signed-out', upload, {
      canUpload
    })

    expect(upload).not.toHaveBeenCalled()
    expect(trackRendererError).not.toHaveBeenCalled()
    // One gate question per save, whatever the image count — and the scene is
    // handed back untouched so it still saves.
    expect(canUpload).toHaveBeenCalledTimes(2)
    expect(first).toBe(sceneJson)
    expect(second).toBe(sceneJson)
  })

  it('treats a gate that throws as "cannot upload" instead of failing the save', async () => {
    const upload = vi.fn<AssetUploader>()
    const canUpload = vi.fn().mockRejectedValue(new Error('no vault is open'))
    const sceneJson = scene({
      'file-1': { mimeType: 'image/png', dataURL: 'data:image/png;base64,aGVsbG8=' }
    })

    const result = await externalizeSceneAssets(sceneJson, 'canvas-gate-throws', upload, {
      canUpload
    })

    expect(upload).not.toHaveBeenCalled()
    expect(trackRendererError).not.toHaveBeenCalled()
    expect(result).toBe(sceneJson)
  })

  it('does not re-attempt a failed file on the next save, and reports it once', async () => {
    const upload = vi.fn<AssetUploader>().mockRejectedValue(new Error('upload failed'))
    const sceneJson = scene({
      'file-1': { mimeType: 'image/png', dataURL: 'data:image/png;base64,aGVsbG8=' }
    })

    await externalizeSceneAssets(sceneJson, 'canvas-stable-failure', upload)
    await externalizeSceneAssets(sceneJson, 'canvas-stable-failure', upload)
    await externalizeSceneAssets(sceneJson, 'canvas-stable-failure', upload)

    expect(upload).toHaveBeenCalledTimes(1)
    expect(trackRendererError).toHaveBeenCalledTimes(1)
  })

  it('retries a blocked file once sync state moves, without reporting it twice', async () => {
    const upload = vi
      .fn<AssetUploader>()
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValueOnce({ ref: 'memry-file://canvas-1/file-1' })
    const sceneJson = scene({
      'file-1': { mimeType: 'image/png', dataURL: 'data:image/png;base64,aGVsbG8=' }
    })

    await externalizeSceneAssets(sceneJson, 'canvas-recovers', upload)
    await externalizeSceneAssets(sceneJson, 'canvas-recovers', upload)
    expect(upload).toHaveBeenCalledTimes(1)

    // Auth/sync/network moved: everything remembered becomes retryable again.
    retryCanvasAssetUploads()
    await externalizeSceneAssets(sceneJson, 'canvas-recovers', upload)
    expect(upload).toHaveBeenCalledTimes(2)
    // Still the same failure, so still one telemetry event.
    expect(trackRendererError).toHaveBeenCalledTimes(1)

    retryCanvasAssetUploads()
    const recovered = await externalizeSceneAssets(sceneJson, 'canvas-recovers', upload)
    expect(upload).toHaveBeenCalledTimes(3)
    expect(JSON.parse(recovered).files['file-1'].dataURL).toBe('memry-file://canvas-1/file-1')
    expect(trackRendererError).toHaveBeenCalledTimes(1)
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
