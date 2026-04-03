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
