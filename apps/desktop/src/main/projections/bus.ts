import type { ProjectionEvent } from './types'

export class ProjectionBus {
  private queue: ProjectionEvent[] = []

  enqueue(event: ProjectionEvent): void {
    this.queue.push(event)
  }

  dequeue(): ProjectionEvent | undefined {
    return this.queue.shift()
  }

  clear(): void {
    this.queue = []
  }

  get size(): number {
    return this.queue.length
  }
}
