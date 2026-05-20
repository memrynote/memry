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
