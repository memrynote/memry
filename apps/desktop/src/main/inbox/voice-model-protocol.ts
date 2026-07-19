export type VoiceModelProgressPhase = 'downloading' | 'loading' | 'ready' | 'error'

export interface VoiceModelProgressMessage {
  type: 'progress'
  phase: VoiceModelProgressPhase
  progress: number
  status: string
}

export type VoiceModelMainToWorkerMessage =
  | {
      type: 'download-model'
      requestId: string
    }
  | {
      type: 'transcribe'
      requestId: string
      audioBuffer: Uint8Array
    }
  | {
      type: 'shutdown'
    }

// Forwarded worker warn/error log record (see lib/log-forward.ts). Kept
// inline rather than importing from telemetry/log-ship.ts so this
// electron-free protocol file (reachable from voice-transcription-worker.ts)
// never risks pulling electron into the worker bundle.
export interface WorkerLogForwardMessage {
  type: 'log'
  record: { level: string; scope?: string; data: unknown[]; date?: string }
}

export type VoiceModelWorkerToMainMessage =
  | {
      type: 'ready'
    }
  | VoiceModelProgressMessage
  | {
      type: 'download-model-result'
      requestId: string
    }
  | {
      type: 'transcribe-result'
      requestId: string
      transcription: string
    }
  | {
      type: 'error'
      requestId: string
      error: string
    }
  | WorkerLogForwardMessage
