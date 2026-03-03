import { describe, it, expect, vi } from 'vitest'
import { parallelWithLimit } from './concurrency'

describe('parallelWithLimit', () => {
  describe('#given empty task list #when called', () => {
    it('#then returns empty array', async () => {
      const result = await parallelWithLimit([], 5)
      expect(result).toEqual([])
    })
  })

  describe('#given tasks #when concurrency is 1', () => {
    it('#then executes tasks serially', async () => {
      const order: number[] = []
      const tasks = [0, 1, 2].map(
        (i) => () =>
          new Promise<number>((resolve) => {
            order.push(i)
            resolve(i)
          })
      )

      const results = await parallelWithLimit(tasks, 1)

      expect(order).toEqual([0, 1, 2])
      expect(results).toHaveLength(3)
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    })
  })

  describe('#given tasks #when concurrency matches task count', () => {
    it('#then all tasks start immediately', async () => {
      let concurrent = 0
      let maxConcurrent = 0

      const tasks = Array.from({ length: 5 }, () => async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 10))
        concurrent--
        return 'done'
      })

      await parallelWithLimit(tasks, 5)
      expect(maxConcurrent).toBe(5)
    })
  })

  describe('#given 6 tasks #when concurrency is 3', () => {
    it('#then never exceeds concurrency limit', async () => {
      let concurrent = 0
      let maxConcurrent = 0

      const tasks = Array.from({ length: 6 }, (_, i) => async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 10))
        concurrent--
        return i
      })

      const results = await parallelWithLimit(tasks, 3)

      expect(maxConcurrent).toBeLessThanOrEqual(3)
      expect(results).toHaveLength(6)
      const values = results
        .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
        .map((r) => r.value)
      expect(values).toEqual([0, 1, 2, 3, 4, 5])
    })
  })

  describe('#given tasks with partial failures #when called', () => {
    it('#then returns settled results for all tasks', async () => {
      const tasks = [
        () => Promise.resolve('ok'),
        () => Promise.reject(new Error('fail')),
        () => Promise.resolve('also ok')
      ]

      const results = await parallelWithLimit(tasks, 3)

      expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' })
      expect(results[1].status).toBe('rejected')
      expect(results[2]).toEqual({ status: 'fulfilled', value: 'also ok' })
    })
  })

  describe('#given tasks #when signal already aborted', () => {
    it('#then all tasks are rejected with AbortError', async () => {
      const controller = new AbortController()
      controller.abort()

      const tasks = [() => Promise.resolve('a'), () => Promise.resolve('b')]

      const results = await parallelWithLimit(tasks, 2, controller.signal)

      expect(results.every((r) => r.status === 'rejected')).toBe(true)
    })
  })

  describe('#given tasks #when signal aborts mid-execution', () => {
    it('#then remaining tasks are rejected', async () => {
      const controller = new AbortController()
      let taskIndex = 0

      const tasks = Array.from({ length: 5 }, () => async () => {
        const idx = taskIndex++
        if (idx === 1) controller.abort()
        await new Promise((r) => setTimeout(r, 5))
        return idx
      })

      const results = await parallelWithLimit(tasks, 2, controller.signal)

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(fulfilled.length).toBeGreaterThan(0)
      expect(rejected.length).toBeGreaterThan(0)
    })
  })

  describe('#given invalid concurrency #when called', () => {
    it('#then throws error', async () => {
      await expect(parallelWithLimit([() => Promise.resolve(1)], 0)).rejects.toThrow(
        'concurrency must be >= 1'
      )
    })
  })

  describe('#given tasks #when results have correct indices', () => {
    it('#then result order matches task order regardless of completion order', async () => {
      const tasks = [
        () => new Promise<string>((r) => setTimeout(() => r('slow'), 50)),
        () => new Promise<string>((r) => setTimeout(() => r('fast'), 10)),
        () => new Promise<string>((r) => setTimeout(() => r('medium'), 30))
      ]

      const results = await parallelWithLimit(tasks, 3)

      const values = results
        .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
        .map((r) => r.value)
      expect(values).toEqual(['slow', 'fast', 'medium'])
    })
  })
})
