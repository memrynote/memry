import { trackRendererLog } from './telemetry-diagnostics'

let unavailabilityReported = false

function reportUnavailable(): false {
  if (!unavailabilityReported) {
    unavailabilityReported = true
    trackRendererLog('warn', 'webgl_unavailable', 'WebGLSupport')
  }
  return false
}

/**
 * Sigma needs at least one WebGL context for every graph surface. Probe the
 * browser boundary once before mounting Sigma so unsupported devices get a
 * rendered fallback instead of an exception from Sigma's constructor.
 */
export function hasWebGLSupport(): boolean {
  if (typeof document === 'undefined') return false

  const canvas = document.createElement('canvas')

  try {
    const context =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')
    if (!context) return reportUnavailable()

    ;(context as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return reportUnavailable()
  }
}
