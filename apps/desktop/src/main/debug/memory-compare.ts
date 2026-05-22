import type {
  DebugMemorySnapshot,
  MemoryCaptureFile,
  MemorySample,
  MemorySamplePhase
} from './memory-snapshot-types'

export interface MemoryComparisonRow {
  phase: MemorySamplePhase
  process: string
  metric: string
  baselineBytes: number
  candidateBytes: number
  deltaBytes: number
  deltaPercent: number | null
}

type MemoryComparable = MemoryCaptureFile | DebugMemorySnapshot

function isCaptureFile(value: MemoryComparable): value is MemoryCaptureFile {
  return 'samples' in value
}

function samplesOf(value: MemoryComparable): MemorySample[] {
  if (isCaptureFile(value)) return value.samples
  return [{ phase: 'T0', snapshot: value }]
}

function labelOf(value: MemoryComparable): string {
  if (isCaptureFile(value)) return value.label
  return value.metadata.label
}

function collectMetrics(sample: MemorySample): Array<[string, string, number | null | undefined]> {
  const { snapshot } = sample
  const metrics: Array<[string, string, number | null | undefined]> = [
    ['main', 'rss', snapshot.main.rss],
    ['main', 'heapUsed', snapshot.main.heapUsed],
    ['main', 'heapTotal', snapshot.main.heapTotal],
    ['main', 'external', snapshot.main.external],
    ['main', 'arrayBuffers', snapshot.main.arrayBuffers],
    ['renderer', 'jsHeapSizeLimit', snapshot.renderer.jsHeapSizeLimit],
    ['renderer', 'totalJSHeapSize', snapshot.renderer.totalJSHeapSize],
    ['renderer', 'usedJSHeapSize', snapshot.renderer.usedJSHeapSize],
    [
      'renderer',
      'measureUserAgentSpecificMemory.bytes',
      snapshot.renderer.measureUserAgentSpecificMemory?.bytes
    ]
  ]

  for (const worker of snapshot.workers) {
    metrics.push([`worker:${worker.name}`, 'rss', worker.rss])
  }

  return metrics
}

export function buildMemoryComparisonRows(
  baseline: MemoryComparable,
  candidate: MemoryComparable
): MemoryComparisonRow[] {
  const candidateByPhase = new Map(samplesOf(candidate).map((sample) => [sample.phase, sample]))
  const rows: MemoryComparisonRow[] = []

  for (const baselineSample of samplesOf(baseline)) {
    const candidateSample = candidateByPhase.get(baselineSample.phase)
    if (!candidateSample) continue

    const candidateMetrics = new Map(
      collectMetrics(candidateSample).map(([processName, metric, value]) => [
        `${processName}:${metric}`,
        value
      ])
    )

    for (const [processName, metric, baselineValue] of collectMetrics(baselineSample)) {
      const candidateValue = candidateMetrics.get(`${processName}:${metric}`)
      if (typeof baselineValue !== 'number' || typeof candidateValue !== 'number') continue

      const deltaBytes = candidateValue - baselineValue
      rows.push({
        phase: baselineSample.phase,
        process: processName,
        metric,
        baselineBytes: baselineValue,
        candidateBytes: candidateValue,
        deltaBytes,
        deltaPercent: baselineValue === 0 ? null : (deltaBytes / baselineValue) * 100
      })
    }
  }

  return rows
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ')
}

export function formatMemoryComparison(
  baseline: MemoryComparable,
  candidate: MemoryComparable
): string {
  const rows = buildMemoryComparisonRows(baseline, candidate)
  const header = ['phase', 'process', 'metric', 'baseline', 'candidate', 'delta', 'delta%']
  const tableRows = rows.map((row) => [
    row.phase,
    row.process,
    row.metric,
    formatMiB(row.baselineBytes),
    formatMiB(row.candidateBytes),
    `${row.deltaBytes >= 0 ? '+' : ''}${formatMiB(row.deltaBytes)}`,
    formatPercent(row.deltaPercent)
  ])

  const widths = header.map((heading, index) =>
    Math.max(heading.length, ...tableRows.map((row) => row[index].length))
  )

  const lines = [
    `Memory comparison: ${labelOf(baseline)} -> ${labelOf(candidate)}`,
    header.map((cell, index) => pad(cell, widths[index])).join(' | '),
    widths.map((width) => '-'.repeat(width)).join('-|-'),
    ...tableRows.map((row) => row.map((cell, index) => pad(cell, widths[index])).join(' | '))
  ]

  return lines.join('\n')
}
