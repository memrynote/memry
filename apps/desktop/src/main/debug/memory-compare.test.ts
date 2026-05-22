import { describe, expect, it } from 'vitest'
import { buildMemoryComparisonRows, formatMemoryComparison } from './memory-compare'
import type { MemoryCaptureFile } from './memory-snapshot-types'

function capture(label: string, usedJSHeapSize: number, rss: number): MemoryCaptureFile {
  return {
    version: 1,
    scenario: 'boot',
    label,
    branch: label,
    vaultPath: '/vault',
    hostname: 'test-host',
    capturedAt: '2026-05-22T00:00:00.000Z',
    samples: [
      {
        phase: 'T0',
        snapshot: {
          timestamp: '2026-05-22T00:00:00.000Z',
          main: {
            rss,
            heapUsed: 50 * 1024 * 1024,
            heapTotal: 80 * 1024 * 1024,
            external: 1 * 1024 * 1024,
            arrayBuffers: 1 * 1024 * 1024
          },
          renderer: {
            jsHeapSizeLimit: 2000 * 1024 * 1024,
            totalJSHeapSize: 200 * 1024 * 1024,
            usedJSHeapSize
          },
          workers: [{ name: 'worker-a', rss: 30 * 1024 * 1024 }],
          metadata: {
            vaultPath: '/vault',
            scenario: 'boot',
            branch: label,
            label,
            hostname: 'test-host',
            capturedAt: '2026-05-22T00:00:00.000Z'
          }
        }
      }
    ]
  }
}

describe('buildMemoryComparisonRows', () => {
  it('calculates absolute and percent deltas per process metric', () => {
    const rows = buildMemoryComparisonRows(
      capture('main', 100 * 1024 * 1024, 500 * 1024 * 1024),
      capture('feat', 80 * 1024 * 1024, 450 * 1024 * 1024)
    )

    expect(rows).toContainEqual(
      expect.objectContaining({
        phase: 'T0',
        process: 'renderer',
        metric: 'usedJSHeapSize',
        deltaBytes: -20 * 1024 * 1024,
        deltaPercent: -20
      })
    )
    expect(rows).toContainEqual(
      expect.objectContaining({
        process: 'main',
        metric: 'rss',
        deltaBytes: -50 * 1024 * 1024,
        deltaPercent: -10
      })
    )
  })
})

describe('formatMemoryComparison', () => {
  it('prints a readable delta table', () => {
    const output = formatMemoryComparison(
      capture('main', 100 * 1024 * 1024, 500 * 1024 * 1024),
      capture('feat', 80 * 1024 * 1024, 450 * 1024 * 1024)
    )

    expect(output).toContain('Memory comparison: main -> feat')
    expect(output).toContain('renderer')
    expect(output).toContain('usedJSHeapSize')
    expect(output).toContain('-20.0 MiB')
  })
})
