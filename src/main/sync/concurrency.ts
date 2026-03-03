import { createLogger } from '../lib/logger'

const log = createLogger('Concurrency')

export async function parallelWithLimit<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  signal?: AbortSignal
): Promise<PromiseSettledResult<T>[]> {
  if (tasks.length === 0) return []
  if (concurrency < 1) {
    throw new Error('concurrency must be >= 1')
  }

  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (nextIndex < tasks.length) {
      if (signal?.aborted) {
        const abortError = new DOMException('Aborted', 'AbortError')
        while (nextIndex < tasks.length) {
          const idx = nextIndex++
          results[idx] = { status: 'rejected', reason: abortError }
        }
        return
      }

      const idx = nextIndex++
      try {
        const value = await tasks[idx]()
        results[idx] = { status: 'fulfilled', value }
      } catch (reason) {
        results[idx] = { status: 'rejected', reason }
      }
    }
  }

  const workerCount = Math.min(concurrency, tasks.length)
  log.debug('Running parallel tasks', { total: tasks.length, concurrency: workerCount })

  const workers = Array.from({ length: workerCount }, () => runWorker())
  await Promise.all(workers)

  return results
}
