/**
 * Whole-UI zoom ladder.
 *
 * Zoom is a fixed set of rungs rather than a free float, so clamping, stepping
 * and reset are index arithmetic and the persisted value is always a member of
 * a known set.
 *
 * The ladder stops at 2.0 because zoom divides the renderer's CSS-pixel
 * viewport, which moves every responsive breakpoint under the existing layout.
 * At 2.0 a 1920px-wide window leaves the renderer 960 CSS px, already under
 * Tailwind's `lg` (1024px); past 2.5 it drops under `md` (768px), where the
 * desktop layout collapses to its narrow arrangement on ordinary hardware.
 * Electron's own limits are wider (0.5-3.0).
 *
 * @module contracts/ui-zoom
 */

export const ZOOM_FACTORS = [0.75, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2] as const

export type ZoomFactor = (typeof ZOOM_FACTORS)[number]

export const DEFAULT_ZOOM_FACTOR: ZoomFactor = 1

/**
 * Snap any input to the nearest rung.
 *
 * Takes `unknown` because this is the parse step for values arriving from
 * outside the type system: a hand-edited config, a config written by a future
 * version with a different ladder, or an IPC payload. It is total on purpose —
 * a corrupt value self-heals to a usable rung here rather than reaching
 * `webContents.zoomFactor` as NaN.
 */
export function clampZoomFactor(value: unknown): ZoomFactor {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR

  let nearest: ZoomFactor = ZOOM_FACTORS[0]
  for (const factor of ZOOM_FACTORS) {
    if (Math.abs(factor - value) < Math.abs(nearest - value)) nearest = factor
  }
  return nearest
}

/**
 * Move one rung in `direction`, saturating at the ends rather than wrapping.
 * `current` is snapped to the ladder first, so an off-ladder value steps from
 * its nearest rung.
 */
export function stepZoomFactor(current: number, direction: 1 | -1): ZoomFactor {
  const snapped = clampZoomFactor(current)
  const next = ZOOM_FACTORS.indexOf(snapped) + direction
  if (next < 0 || next >= ZOOM_FACTORS.length) return snapped
  return ZOOM_FACTORS[next]
}

/**
 * Zoom is device-local and lives outside the synced settings groups, so it gets
 * its own channels rather than riding on `settings:*`. Declared here, next to
 * the ladder they carry, and re-exported from `ipc-channels` so the preload
 * bridge keeps one import point for channel names.
 */
export const UiZoomChannels = {
  invoke: {
    /** Read this install's zoom factor */
    GET: 'ui-zoom:get',
    /** Persist a zoom factor and apply it to every window */
    SET: 'ui-zoom:set'
  },
  events: {
    /** Zoom changed anywhere (settings row, shortcut, or menu) */
    CHANGED: 'ui-zoom:changed'
  }
} as const

export type UiZoomInvokeChannel = (typeof UiZoomChannels.invoke)[keyof typeof UiZoomChannels.invoke]

export interface UiZoomChangedEvent {
  factor: ZoomFactor
}
