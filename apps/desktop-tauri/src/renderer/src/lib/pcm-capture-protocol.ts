/** Shared by `pcm-capture.ts` (main thread) and `pcm-capture-worklet.ts` (audio thread). */
export const PCM_CAPTURE_PROCESSOR = 'memry-pcm-capture'

/** Frames per `samples` message: about 85 ms at 48 kHz, so the port carries ~12 messages a second. */
export const PCM_CAPTURE_CHUNK_FRAMES = 4096

/** Main thread to worklet. */
export type PcmCaptureCommand = { type: 'stop' }

/** Worklet to main thread: mono samples in capture order, then `done` once after `stop`. */
export type PcmCaptureMessage = { type: 'samples'; samples: Float32Array } | { type: 'done' }
