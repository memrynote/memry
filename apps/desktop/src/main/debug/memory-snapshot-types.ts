export const MEMORY_DEBUG_HOST = '127.0.0.1'
export const MEMORY_DEBUG_DEFAULT_PORT = 17345

export type MemoryScenario = 'boot' | 'idle-60s'
export type MemorySamplePhase = 'T0' | 'T1' | 'T2'

export interface ProcessMemorySnapshot {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
  arrayBuffers: number
}

export interface RendererSpecificMemoryBreakdown {
  bytes: number
  types?: string[]
  attribution?: Array<{
    url?: string
    scope?: string
  }>
}

export interface RendererSpecificMemorySnapshot {
  bytes: number
  breakdown?: RendererSpecificMemoryBreakdown[]
}

export interface RendererMemorySnapshot {
  jsHeapSizeLimit: number | null
  totalJSHeapSize: number | null
  usedJSHeapSize: number | null
  measureUserAgentSpecificMemory?: RendererSpecificMemorySnapshot
}

export interface WorkerMemorySnapshot {
  name: string
  rss: number
}

export interface DebugMemoryMetadata {
  vaultPath: string | null
  scenario: MemoryScenario
  branch: string
  label: string
  hostname: string
  capturedAt: string
}

export interface DebugMemorySnapshot {
  timestamp: string
  main: ProcessMemorySnapshot
  renderer: RendererMemorySnapshot
  workers: WorkerMemorySnapshot[]
  metadata: DebugMemoryMetadata
}

export interface MemorySample {
  phase: MemorySamplePhase
  snapshot: DebugMemorySnapshot
}

export interface MemoryCaptureFile {
  version: 1
  scenario: MemoryScenario
  label: string
  branch: string
  vaultPath: string
  hostname: string
  capturedAt: string
  samples: MemorySample[]
}

export interface MemorySnapshotRequest {
  scenario: MemoryScenario
  label: string
  branch: string
}
