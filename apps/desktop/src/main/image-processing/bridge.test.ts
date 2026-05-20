import { EventEmitter } from 'events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mockApp = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => `/mock/${name}`)
}))

class MockUtilityProcess extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn().mockReturnValue(true)
  stdout = null
  stderr = null
  pid = 4321

  simulateMessage(message: unknown): void {
    this.emit('message', message)
  }

  simulateExit(code: number): void {
    this.emit('exit', code)
  }
}

const mockFork = vi.hoisted(() => vi.fn())
let mockUtilityProcessInstance: MockUtilityProcess

vi.mock('electron', () => ({
  app: mockApp,
  utilityProcess: {
    fork: (...args: unknown[]) => {
      mockUtilityProcessInstance = new MockUtilityProcess()
      mockFork(...args)
      return mockUtilityProcessInstance
    }
  }
}))

vi.mock('sharp', () => {
  throw new Error('image-processing bridge must not import sharp in the main process')
})

import {
  generateThumbnailInImageProcess,
  processInboxImageAttachment,
  resetImageProcessingForTests,
  stopImageProcessing
} from './bridge'

describe('image-processing bridge', () => {
  beforeEach(() => {
    resetImageProcessingForTests()
    mockFork.mockReset()
    mockApp.getPath.mockImplementation((name: string) => `/mock/${name}`)
  })

  afterEach(() => {
    resetImageProcessingForTests()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('does not start the utility process until image work is requested', () => {
    expect(mockFork).not.toHaveBeenCalled()
  })

  it('generates thumbnails in a utility process and shuts down after staying idle', async () => {
    vi.useFakeTimers()
    const thumbnailPromise = generateThumbnailInImageProcess('/tmp/photo.jpg', 'image/jpeg')

    expect(mockFork).toHaveBeenCalledOnce()
    const [, , options] = mockFork.mock.calls[0] ?? []
    expect(options).toEqual(
      expect.objectContaining({
        serviceName: 'ImageProcessing'
      })
    )

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      type: string
      requestId: string
      filePath: string
      mimeType: string
    }
    expect(requestMessage).toEqual(
      expect.objectContaining({
        type: 'generate-thumbnail',
        filePath: '/tmp/photo.jpg',
        mimeType: 'image/jpeg'
      })
    )

    mockUtilityProcessInstance.simulateMessage({
      type: 'thumbnail-result',
      requestId: requestMessage.requestId,
      result: {
        data: new Uint8Array(Buffer.from('fake-webp')),
        width: 150,
        height: 100,
        format: 'webp'
      }
    })

    await expect(thumbnailPromise).resolves.toEqual({
      data: Buffer.from('fake-webp'),
      width: 150,
      height: 100,
      format: 'webp'
    })
    expect(mockUtilityProcessInstance.postMessage).not.toHaveBeenCalledWith({ type: 'shutdown' })

    await vi.advanceTimersByTimeAsync(30_000)

    expect(mockUtilityProcessInstance.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' })
  })

  it('processes inbox image metadata and thumbnails through the utility process', async () => {
    const processPromise = processInboxImageAttachment('/tmp/inbox/photo.jpg')

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      type: string
      requestId: string
      filePath: string
    }
    expect(requestMessage).toEqual(
      expect.objectContaining({
        type: 'process-inbox-image',
        filePath: '/tmp/inbox/photo.jpg'
      })
    )

    mockUtilityProcessInstance.simulateMessage({
      type: 'inbox-image-result',
      requestId: requestMessage.requestId,
      result: {
        metadata: {
          format: 'jpeg',
          width: 640,
          height: 480,
          hasExif: true
        },
        thumbnailData: new Uint8Array(Buffer.from('thumb'))
      }
    })

    await expect(processPromise).resolves.toEqual({
      metadata: {
        format: 'jpeg',
        width: 640,
        height: 480,
        hasExif: true
      },
      thumbnailData: Buffer.from('thumb')
    })
  })

  it('rejects image work when the utility process reports an error or exits', async () => {
    const failedProcess = processInboxImageAttachment('/tmp/bad.jpg')

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })
    const failedRequest = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'error',
      requestId: failedRequest.requestId,
      error: 'corrupt image'
    })

    await expect(failedProcess).rejects.toThrow('corrupt image')

    resetImageProcessingForTests()
    const exitedProcess = processInboxImageAttachment('/tmp/exit.jpg')
    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })
    mockUtilityProcessInstance.simulateExit(9)

    await expect(exitedProcess).rejects.toThrow(
      'Image processing utility exited unexpectedly (code 9)'
    )
  })

  it('stops a running utility process gracefully', async () => {
    const thumbnailPromise = generateThumbnailInImageProcess('/tmp/photo.jpg', 'image/jpeg')

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })
    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'thumbnail-result',
      requestId: requestMessage.requestId,
      result: null
    })
    await expect(thumbnailPromise).resolves.toBeNull()

    const stopPromise = stopImageProcessing()
    expect(mockUtilityProcessInstance.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' })
    mockUtilityProcessInstance.simulateExit(0)

    await expect(stopPromise).resolves.toBeUndefined()
  })
})
