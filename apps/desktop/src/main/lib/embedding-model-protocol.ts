export type EmbeddingProgressPhase = 'downloading' | 'loading' | 'ready' | 'error'

export interface EmbeddingProgressMessage {
  type: 'progress'
  phase: EmbeddingProgressPhase
  progress: number
  status: string
}

export type EmbeddingMainToWorkerMessage =
  | {
      type: 'load-model'
      requestId: string
    }
  | {
      type: 'embed'
      requestId: string
      text: string
    }
  | {
      type: 'shutdown'
    }

// Forwarded worker warn/error log record (see lib/log-forward.ts). Kept
// inline rather than importing from telemetry/log-ship.ts so this
// electron-free protocol file (reachable from embedding-worker.ts) never
// risks pulling electron into the worker bundle.
export interface WorkerLogForwardMessage {
  type: 'log'
  record: { level: string; scope?: string; data: unknown[]; date?: string }
}

export type EmbeddingWorkerToMainMessage =
  | {
      type: 'ready'
    }
  | EmbeddingProgressMessage
  | {
      type: 'load-model-result'
      requestId: string
    }
  | {
      type: 'embed-result'
      requestId: string
      embedding: number[]
    }
  | {
      type: 'error'
      requestId: string
      error: string
    }
  | WorkerLogForwardMessage
