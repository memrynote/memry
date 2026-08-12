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

const requestMessages = (): Array<{ type: string; requestId: string }> =>
  mockUtilityProcessInstance.postMessage.mock.calls
    .map((call) => call[0] as { type: string; requestId: string })
    .filter((message) => message.type !== 'shutdown')

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

  it('caps in-flight worker requests and drains the queue as results arrive', async () => {
    const settled: string[] = []
    const promises = Array.from({ length: 10 }, (_, index) =>
      generateThumbnailInImageProcess(`/tmp/burst-${index}.jpg`, 'image/jpeg').then(
        () => {
          settled.push(`resolved-${index}`)
        },
        () => {
          settled.push(`rejected-${index}`)
        }
      )
    )

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(requestMessages()).toHaveLength(4)
    })

    for (let index = 0; index < 10; index += 1) {
      const dispatched = requestMessages()
      expect(dispatched.length - settled.length).toBeLessThanOrEqual(4)

      mockUtilityProcessInstance.simulateMessage({
        type: 'thumbnail-result',
        requestId: dispatched[index].requestId,
        result: null
      })
      await vi.waitFor(() => {
        expect(settled).toHaveLength(index + 1)
      })
    }

    await Promise.all(promises)
    expect(requestMessages()).toHaveLength(10)
    expect(new Set(settled).size).toBe(10)
  })

  it('starts the request timeout only once queued work is dispatched', async () => {
    vi.useFakeTimers()
    const outcomes: string[] = []
    const promises = Array.from({ length: 8 }, (_, index) =>
      generateThumbnailInImageProcess(`/tmp/timeout-${index}.jpg`, 'image/jpeg')
        .then(
          () => 'resolved',
          (error: Error) => error.message
        )
        .then((outcome) => {
          outcomes.push(outcome)
        })
    )

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(requestMessages()).toHaveLength(4)
    })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(outcomes).toHaveLength(4)
    expect(
      outcomes.every((outcome) => outcome.startsWith('Image processing request timed out'))
    ).toBe(true)
    expect(requestMessages()).toHaveLength(8)

    for (const message of requestMessages().slice(4)) {
      mockUtilityProcessInstance.simulateMessage({
        type: 'thumbnail-result',
        requestId: message.requestId,
        result: null
      })
    }

    await Promise.all(promises)
    expect(outcomes.filter((outcome) => outcome === 'resolved')).toHaveLength(4)
  })

  it('rejects new image work once the wait queue is full', async () => {
    const promises = Array.from({ length: 261 }, (_, index) =>
      generateThumbnailInImageProcess(`/tmp/flood-${index}.jpg`, 'image/jpeg').then(
        () => 'resolved',
        (error: Error) => error.message
      )
    )

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })

    await expect(promises[260]).resolves.toContain('Image processing is busy')
    expect(requestMessages()).toHaveLength(4)

    resetImageProcessingForTests()
    const outcomes = await Promise.all(promises)
    expect(outcomes.filter((outcome) => outcome === 'Image processing utility reset')).toHaveLength(
      260
    )
  })

  it('settles queued and in-flight work when the utility process stops', async () => {
    vi.useFakeTimers()
    const promises = Array.from({ length: 10 }, (_, index) =>
      generateThumbnailInImageProcess(`/tmp/stop-${index}.jpg`, 'image/jpeg').then(
        () => 'resolved',
        (error: Error) => error.message
      )
    )

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(requestMessages()).toHaveLength(4)
    })

    const stopPromise = stopImageProcessing()
    mockUtilityProcessInstance.simulateExit(0)
    await stopPromise

    const outcomes = await Promise.all(promises)
    expect(outcomes).toEqual(Array.from({ length: 10 }, () => 'Image processing utility stopped'))
    expect(vi.getTimerCount()).toBe(0)

    const afterStop = Array.from({ length: 4 }, (_, index) =>
      generateThumbnailInImageProcess(`/tmp/after-stop-${index}.jpg`, 'image/jpeg').then(
        () => 'resolved',
        (error: Error) => error.message
      )
    )
    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(requestMessages()).toHaveLength(4)
    })

    resetImageProcessingForTests()
    await Promise.all(afterStop)
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
